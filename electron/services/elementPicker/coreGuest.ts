/**
 * One core picker binding's guest: the bootstrap in its isolated world, and
 * the extractors installed into the page's main world once something says the
 * page uses their framework.
 *
 * The bridge owns the binding's lifecycle — epochs, origin policy, the lease,
 * the queue, teardown — and calls in here at the points that matter. What this
 * owns is the rule the picker's loading rests on: an extractor is evaluated
 * only after an admitted detection names its framework, only into the document
 * that detection was made in, and at most once per framework per document.
 *
 * Every step re-reads whether its document is still current after each await,
 * because a navigation can land under any of them, and `invalidate` is
 * synchronous so the bridge can retire everything in flight the moment it
 * observes one.
 *
 * Loaded on the first core bind rather than at startup, so an app that never
 * opens the picker never evaluates these schemas.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  admitElementPickerMessage,
  type ElementPickerAdmission,
  type ElementPickerEvent,
  type ElementPickerVerdict,
} from "../../../shared/elementPicker/protocol.js";
import {
  FrameworkDetectionSchema,
  OBSERVATION_LIMITS,
  type FrameworkDetection,
} from "../../../shared/elementPicker/observation.js";
import type { ElementPickerFramework } from "../../../shared/elementPicker/source.js";
import type { SitePreviewMode } from "../../../shared/types/ipc/sitePreview.js";
import type { ElementPickerReselectRequest } from "../../../shared/types/ipc/elementPicker.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { isExpectedCdpError } from "../../utils/webContentsLifecycle.js";
import type { GuestOriginPolicy } from "../sitePreview/originPolicy.js";
import { extractorAssetId, type CoreGuestAssetLoader } from "./guestAssets.js";
import { EXTRACTOR_INSTALL_STATUS } from "./guestChannel.js";
import {
  buildBootstrapSource,
  buildExtractorSource,
  buildPickerAvailabilitySource,
  buildPickerClearHoverSource,
  buildPickerClearSelectionSource,
  buildPickerDisposeSource,
  buildPickerModeSource,
  buildPickerReselectSource,
  buildProbeSource,
} from "./guestSources.js";
import type { ExtractorAvailability, PickerAvailability } from "./guest/types.js";
import type { ElementPickerPushPayload } from "./types.js";

/**
 * When the one extra probe runs after a document reports ready. Long enough
 * for a client-rendered app to have mounted; the selection-time detectors
 * catch an island that hydrates later still, when the user points at it.
 */
export const LATE_PROBE_DELAY_MS = 2_500;

const ProbeResultSchema = z.array(FrameworkDetectionSchema).max(OBSERVATION_LIMITS.detections);

export interface CoreGuestDeps {
  sessionId: string;
  projectId: string;
  bindingName: string;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** The binding's own queue, shared with its navigation reinstalls. */
  enqueue(work: () => Promise<void>): Promise<void>;
  loadAsset: CoreGuestAssetLoader;
  emit(payload: ElementPickerPushPayload): void;
  /** The binding's epoch now, or null once it may install nothing (detached, suspended, closing). */
  liveEpoch(): number | null;
  /**
   * The page's main world as the CDP lease sees it: the default world's
   * `uniqueId` and the document generation it belongs to. Null with no lease.
   */
  mainWorld(): { uniqueId: string | null; generation: number } | null;
  evaluateTimeoutMs: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Injected so tests can name the channel; random otherwise. */
  newChannel?: () => string;
}

type EvaluateResult = { result?: { value?: unknown }; exceptionDetails?: { text?: string } };

/** What the bootstrap is asked to select again; the session is the bridge's to match, not the page's to hear. */
export type CoreGuestReselectRequest = Omit<ElementPickerReselectRequest, "sessionId">;

/**
 * A call into a world or frame whose document is gone. Expected here and
 * nowhere else in main: only the picker aims evaluates at a context it named.
 */
const GONE_CONTEXT_ERRORS = [
  "Cannot find context with specified id",
  "uniqueContextId not found",
  "No frame for given id found",
];

function isGoneContextError(err: unknown): boolean {
  if (isExpectedCdpError(err)) return true;
  const message = formatErrorMessage(err, "");
  return GONE_CONTEXT_ERRORS.some((expected) => message.includes(expected));
}

export class CoreGuest {
  /** The picker's isolated world. Per binding, so two bindings never share one. */
  readonly worldName = `daintree-element-picker-${randomBytes(8).toString("hex")}`;
  /** The world's context in the current document; kept past `invalidate` for disposal. */
  private contextId: number | null = null;
  private installId = 0;
  private channel: string | null = null;
  /** The epoch everything below describes, or -1 once nothing may act on it. */
  private epoch = -1;
  private readonly extractors = new Map<ElementPickerFramework, ExtractorAvailability>();
  /** Whether the last scheduled look at this document has come back; until it has, nothing is known to be absent. */
  private detection: PickerAvailability["detection"] = "pending";
  private probedEpoch = -1;
  private lateProbe: unknown = null;
  /** The lease's document generation when this install's world was created. */
  private generation: number | null = null;

  constructor(private readonly deps: CoreGuestDeps) {}

  /**
   * The binding is exposed only in the picker's own world, so a call from any
   * other context — the page's main world, an iframe, a world from a previous
   * document — is not the bootstrap. Fails closed: the context is known
   * exactly, from the world this install created.
   */
  isTrustedContext(contextId: number): boolean {
    return this.epoch !== -1 && this.contextId !== null && contextId === this.contextId;
  }

  admit(payload: unknown, admission: ElementPickerAdmission): ElementPickerVerdict {
    return admitElementPickerMessage(payload, admission);
  }

  /**
   * Retire everything in flight for the current document. Synchronous, so the
   * bridge can call it the instant it sees a navigation, a suspension or a
   * teardown, before any await of its own.
   */
  invalidate(): void {
    this.epoch = -1;
    this.generation = null;
    this.extractors.clear();
    this.detection = "pending";
    // A reinstall into the same document probes it again: what the last
    // install found went with that install's readers.
    this.probedEpoch = -1;
    if (this.lateProbe !== null) {
      (this.deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(
        this.lateProbe
      );
      this.lateProbe = null;
    }
  }

  private isCurrent(epoch: number): boolean {
    return epoch !== -1 && this.epoch === epoch && this.deps.liveEpoch() === epoch;
  }

  /**
   * False when the document the install was for went away under it — a
   * navigation the bridge will reinstall for — rather than a failure to report.
   */
  async install(input: {
    epoch: number;
    installId: number;
    mode: SitePreviewMode;
    origins: GuestOriginPolicy;
    frameId: string;
  }): Promise<boolean> {
    const body = await this.deps.loadAsset("bootstrap");
    if (body === null) {
      throw new AppError({
        code: "INTERNAL",
        message: "The Element Picker bootstrap is missing from the guest asset catalog",
      });
    }
    if (this.deps.liveEpoch() !== input.epoch) return false;
    // Scoped by world name: page script in the main world never sees the
    // binding, and neither does a frame the picker made no world in.
    await this.deps.send("Runtime.addBinding", {
      name: this.deps.bindingName,
      executionContextName: this.worldName,
    });
    // For the current document only, unlike a new-document script: nothing of
    // the picker's carries over into a document it was not installed in.
    let world: { executionContextId?: unknown } | undefined;
    try {
      world = (await this.deps.send("Page.createIsolatedWorld", {
        frameId: input.frameId,
        worldName: this.worldName,
        grantUniveralAccess: false,
      })) as { executionContextId?: unknown } | undefined;
    } catch (err) {
      if (isGoneContextError(err)) return false;
      throw err;
    }
    if (this.deps.liveEpoch() !== input.epoch) return false;
    const contextId = world?.executionContextId;
    if (typeof contextId !== "number") {
      throw new AppError({
        code: "INTERNAL",
        message: "The dev preview did not create the Element Picker's isolated world",
      });
    }

    this.invalidate();
    this.epoch = input.epoch;
    this.contextId = contextId;
    this.installId = input.installId;
    // Read with nothing awaited since the world was made, so it is the
    // generation of the document the world is in.
    this.generation = this.deps.mainWorld()?.generation ?? null;
    const channel =
      this.deps.newChannel?.() ?? `daintree-element-picker-${randomBytes(12).toString("hex")}`;
    this.channel = channel;

    // Set before the evaluate: the bootstrap reports `documentReady` from inside it.
    let evaluated: EvaluateResult | undefined;
    try {
      evaluated = (await this.deps.send("Runtime.evaluate", {
        expression: buildBootstrapSource({
          sessionId: this.deps.sessionId,
          installId: input.installId,
          documentEpoch: input.epoch,
          bindingName: this.deps.bindingName,
          channel,
          mode: input.mode,
          origins: input.origins,
          body,
        }),
        contextId,
        timeout: this.deps.evaluateTimeoutMs,
      })) as EvaluateResult | undefined;
    } catch (err) {
      // The world went with its document: a reload landed between creating it
      // and evaluating into it. The navigation's own reinstall takes over.
      if (isGoneContextError(err)) return false;
      throw err;
    }
    if (evaluated?.exceptionDetails) {
      throw new AppError({
        code: "INTERNAL",
        message: "The Element Picker bootstrap threw while initialising in the guest",
        context: { detail: evaluated.exceptionDetails.text },
      });
    }
    return true;
  }

  /**
   * The main world of the document this install's bootstrap is in, or null
   * when it is unknown or belongs to a later document. Evaluates aimed at its
   * `uniqueId` fail outright once that document is gone, so nothing meant for
   * one document can run in the next — however the page dresses up the
   * handshake, which stays only as a second check.
   */
  private mainWorldTarget(): string | null {
    const world = this.deps.mainWorld();
    if (world === null || this.generation === null || world.generation !== this.generation) {
      return null;
    }
    return world.uniqueId;
  }

  /** An admitted event from the bootstrap, for the epoch it was admitted under. */
  onGuestEvent(epoch: number, event: ElementPickerEvent): void {
    if (!this.isCurrent(epoch)) return;
    if (event.type === "documentReady") {
      this.onDocumentReady(epoch);
    } else if (event.type === "frameworksDetected") {
      if (this.requestExtractors(epoch, event.detections)) void this.publishAvailability(epoch);
    }
  }

  private onDocumentReady(epoch: number): void {
    if (this.probedEpoch === epoch) return;
    this.probedEpoch = epoch;
    this.queueProbe(epoch, false);
    // Exactly one more look per document, for a page that mounts after it
    // reported ready. A page that never hydrates must not be probed forever.
    const setTimer =
      this.deps.setTimer ??
      ((callback: () => void, ms: number) => setTimeout(callback, ms).unref?.());
    this.lateProbe = setTimer(() => {
      this.lateProbe = null;
      this.queueProbe(epoch, true);
    }, LATE_PROBE_DELAY_MS);
  }

  private queueProbe(epoch: number, late: boolean): void {
    // Queued, never awaited from the caller: an event handled while the
    // install is still evaluating would otherwise wait on itself.
    void this.deps.enqueue(() => this.probe(epoch, late)).catch((err) => this.warn("probe", err));
  }

  private async probe(epoch: number, late: boolean): Promise<void> {
    const channel = this.channel;
    if (!this.isCurrent(epoch) || channel === null) return;
    const body = await this.deps.loadAsset("probe");
    if (body === null || !this.isCurrent(epoch)) return;
    const target = this.mainWorldTarget();
    if (target === null) return;
    let evaluated: EvaluateResult | undefined;
    try {
      evaluated = (await this.deps.send("Runtime.evaluate", {
        expression: buildProbeSource({ channel, body }),
        uniqueContextId: target,
        returnByValue: true,
        timeout: this.deps.evaluateTimeoutMs,
      })) as EvaluateResult | undefined;
    } catch (err) {
      if (!isGoneContextError(err)) this.warn("probe", err);
      return;
    }
    if (!this.isCurrent(epoch) || evaluated?.exceptionDetails) return;
    // Ran in the page's world: the page could have shaped any of it. A result
    // that fails the schema is no evidence the page has no framework either.
    const parsed = ProbeResultSchema.safeParse(evaluated?.result?.value);
    if (!parsed.success) return;
    // Settled by the last look, not the first: an app that mounts after the
    // document reported ready would otherwise read as having no framework
    // until it did. Settled even when empty: a bounded look that found no
    // framework we read is the answer a plain page gets.
    const settles = late && this.detection === "pending";
    if (settles) this.detection = "settled";
    if (parsed.data.length > 0) {
      this.deps.emit({
        kind: "frameworks-probed",
        sessionId: this.deps.sessionId,
        projectId: this.deps.projectId,
        documentEpoch: epoch,
        detections: parsed.data,
      });
    }
    if (this.requestExtractors(epoch, parsed.data) || settles) {
      await this.publishAvailability(epoch);
    }
  }

  /**
   * Tell the picker what is now known about the document's readers. Every
   * call carries the whole state, so whichever arrives last is right.
   */
  private async publishAvailability(epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    const availability: PickerAvailability = {
      detection: this.detection,
      extractors: Object.fromEntries(this.extractors),
    };
    await this.callBootstrap(buildPickerAvailabilitySource(this.installId, availability));
  }

  /**
   * Reserve each framework's slot synchronously, before the queued install
   * runs, so a detection repeated while the first is in flight finds it taken.
   * The enum bounds the attempts per document at its size. True when any
   * framework was new, which the picker has to hear about.
   */
  private requestExtractors(epoch: number, detections: readonly FrameworkDetection[]): boolean {
    let added = false;
    for (const { framework } of detections) {
      if (!this.isCurrent(epoch) || this.extractors.has(framework)) continue;
      this.extractors.set(framework, "pending");
      added = true;
      void this.deps
        .enqueue(() => this.installExtractor(epoch, framework))
        .catch((err) => this.warn("extractor install", err));
    }
    return added;
  }

  /** Whatever the attempt came to, the picker hears it, so a selection made meanwhile is described again. */
  private async installExtractor(epoch: number, framework: ElementPickerFramework): Promise<void> {
    await this.loadExtractor(epoch, framework);
    await this.publishAvailability(epoch);
  }

  private async loadExtractor(epoch: number, framework: ElementPickerFramework): Promise<void> {
    const channel = this.channel;
    if (!this.isCurrent(epoch) || channel === null) return;
    if (this.extractors.get(framework) !== "pending") return;
    let body: string | null;
    try {
      body = await this.deps.loadAsset(extractorAssetId(framework));
    } catch {
      if (this.isCurrent(epoch)) this.fail(epoch, framework, "the extractor could not be read");
      return;
    }
    if (!this.isCurrent(epoch)) return;
    if (body === null) {
      this.extractors.set(framework, "unavailable");
      return;
    }
    const target = this.mainWorldTarget();
    if (target === null) {
      // The document this detection was made in is not the one the lease now
      // sees; its own navigation resets this, so it is nobody's failure.
      this.extractors.set(framework, "failed");
      return;
    }
    let evaluated: EvaluateResult | undefined;
    try {
      evaluated = (await this.deps.send("Runtime.evaluate", {
        expression: buildExtractorSource({ channel, framework, body }),
        uniqueContextId: target,
        returnByValue: true,
        timeout: this.deps.evaluateTimeoutMs,
      })) as EvaluateResult | undefined;
    } catch (err) {
      if (!this.isCurrent(epoch)) return;
      // The page's world went with its document, which the bridge has not
      // retired yet: nobody's failure, and nothing to report, but over.
      if (isGoneContextError(err)) this.extractors.set(framework, "failed");
      else this.fail(epoch, framework, "the extractor could not be evaluated");
      return;
    }
    if (!this.isCurrent(epoch)) return;
    const status = evaluated?.exceptionDetails ? null : evaluated?.result?.value;
    if (status === EXTRACTOR_INSTALL_STATUS.installed) {
      this.extractors.set(framework, "installed");
      this.deps.emit({
        kind: "extractor-installed",
        sessionId: this.deps.sessionId,
        projectId: this.deps.projectId,
        documentEpoch: epoch,
        framework,
      });
      return;
    }
    if (status === EXTRACTOR_INSTALL_STATUS.absent) {
      // No bootstrap of this install in the document: a navigation is replacing
      // it, and the epoch change that follows resets everything here. Not the
      // extractor's failure, and not retried.
      this.extractors.set(framework, "failed");
      return;
    }
    this.fail(
      epoch,
      framework,
      status === EXTRACTOR_INSTALL_STATUS.threw
        ? "the extractor threw while installing"
        : "the extractor did not register"
    );
  }

  private fail(epoch: number, framework: ElementPickerFramework, detail: string): void {
    this.extractors.set(framework, "failed");
    this.deps.emit({
      kind: "host-issue",
      sessionId: this.deps.sessionId,
      projectId: this.deps.projectId,
      documentEpoch: epoch,
      issue: { type: "runtimeIssue", code: "extractor-failed", framework, detail },
    });
  }

  setMode(mode: SitePreviewMode): Promise<void> {
    return this.callBootstrap(buildPickerModeSource(this.installId, mode));
  }

  clearSelection(): Promise<void> {
    return this.callBootstrap(buildPickerClearSelectionSource(this.installId));
  }

  clearHover(): Promise<void> {
    return this.callBootstrap(buildPickerClearHoverSource(this.installId));
  }

  /**
   * Asks the bootstrap this install put in the current document to select
   * again. False for anything short of its own yes: no install, a document
   * that changed before or during the call, a world that went with it, or a
   * page that answered something else.
   */
  async reselect(request: CoreGuestReselectRequest): Promise<boolean> {
    const contextId = this.contextId;
    const installId = this.installId;
    const epoch = this.epoch;
    if (contextId === null || installId === 0 || !this.isCurrent(epoch)) return false;
    let evaluated: EvaluateResult | undefined;
    try {
      evaluated = (await this.deps.send("Runtime.evaluate", {
        expression: buildPickerReselectSource(installId, request),
        contextId,
        returnByValue: true,
        timeout: this.deps.evaluateTimeoutMs,
      })) as EvaluateResult | undefined;
    } catch (err) {
      if (!isGoneContextError(err)) this.warn("reselect", err);
      return false;
    }
    // A yes from a document that has since been replaced selected nothing the view can use.
    if (!this.isCurrent(epoch) || evaluated?.exceptionDetails) return false;
    return evaluated?.result?.value === true;
  }

  /**
   * Best effort: disposing the bootstrap also tells the main-world extractors
   * installed for it to go. Matched on install id, so it can never take down a
   * bootstrap a later install put in the same world.
   */
  async disposeInGuest(): Promise<void> {
    this.invalidate();
    const installId = this.installId;
    await this.callBootstrap(buildPickerDisposeSource(installId));
    this.contextId = null;
  }

  /** Into the picker's world only; a world from a document that is gone simply refuses. */
  private async callBootstrap(expression: string): Promise<void> {
    const contextId = this.contextId;
    if (contextId === null || this.installId === 0) return;
    try {
      await this.deps.send("Runtime.evaluate", {
        expression,
        contextId,
        timeout: this.deps.evaluateTimeoutMs,
      });
    } catch (err) {
      if (!isGoneContextError(err)) this.warn("bootstrap call", err);
    }
  }

  private warn(what: string, err: unknown): void {
    console.warn(`[ElementPicker] ${what} failed:`, formatErrorMessage(err, `${what} failed`));
  }
}
