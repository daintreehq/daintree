/**
 * SitePreviewBridge: binds the Element Picker to a running dev-preview guest,
 * installs its bootstrap inside it over CDP, and turns the guest's push traffic
 * into validated, epoch-stamped observations.
 *
 * Why CDP and not a preload: `will-attach-webview` in `electron/window/createWindow.ts`
 * strips `preload` and forces `sandbox` + `contextIsolation` on every `<webview>`,
 * deliberately. The guest therefore has no privileged bridge of its own and the
 * only way in is the debugger session. `Runtime.addBinding` gives the reverse
 * direction.
 *
 * Trust model. The guest is a page the user is building and is assumed hostile:
 * a compromise there can call the binding with anything. So the session id
 * scopes traffic, it does not authorise it; epoch and sequence establish that a
 * message describes the *current* document rather than a replay from a previous
 * one; and nothing the guest says about files, paths or revisions is acted on
 * here. What survives validation is an observation, forwarded as such.
 *
 * There is intentionally no "evaluate this script in the guest" operation, and
 * no caller-supplied body either: what runs in the guest is loaded by the host
 * itself, from the picker's asset catalog or a registered provider's entry.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { webContents as electronWebContents } from "electron";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type {
  SitePreviewBindingState,
  SitePreviewDetachReason,
  SitePreviewMode,
} from "../../shared/types/ipc/sitePreview.js";
import type { ElementPickerRejection } from "../../shared/elementPicker/protocol.js";
import { isExpectedCdpError } from "../utils/webContentsLifecycle.js";
import { acquireCdpLease, type CdpLease } from "./cdp/WebContentsCdpService.js";
import { AppError } from "../utils/errorTypes.js";
import { getWebviewDialogService } from "./WebviewDialogService.js";
import { getProjectForWebContents } from "../window/webContentsRegistry.js";
import { DEFAULT_GUEST_ORIGIN_POLICY, originPolicyAllows } from "./sitePreview/originPolicy.js";
import { onWebContentsDestroyed } from "../window/webContentsDestroyed.js";
import type { CoreGuestAssetLoader } from "./elementPicker/guestAssets.js";
import type { CoreGuest, CoreGuestReselectRequest } from "./elementPicker/coreGuest.js";
import type { ElementPickerReselectRequest } from "../../shared/types/ipc/elementPicker.js";
import type { ElementPickerPushPayload, ElementPickerSink } from "./elementPicker/types.js";

const DEV_PREVIEW_PANEL_KIND = "dev-preview";

/** Why the bridge refused a guest envelope: the picker's own verdicts, plus the two it decides itself. */
type GuestEnvelopeRejection = ElementPickerRejection | "foreign-context" | "rate-limited";

/**
 * Ceiling on envelopes one binding will *parse* per second. A hostile page can
 * call the binding in a tight loop, and JSON + schema parsing a 256 KiB body is
 * the expensive half; without this the guest sets the main process's CPU budget.
 * Well above what hover and selection traffic produce.
 */
const MAX_ENVELOPES_PER_SECOND = 240;

/** Floor between two drop warnings, so a spamming page cannot flood the log. */
const DROP_LOG_INTERVAL_MS = 5_000;

/**
 * Ceiling on a `Runtime.evaluate` in the guest. The expression runs on the
 * page's main thread, and a hostile document can poison anything it touches
 * (`JSON.stringify`, `Object.defineProperty`) into never returning. Without a
 * bound, teardown would wait on that forever.
 */
const GUEST_EVALUATE_TIMEOUT_MS = 5_000;

/**
 * Sustained invalid traffic detaches the binding. Stopping at "count and
 * discard" leaves CDP still delivering every string into main; removing the
 * binding is the only thing that actually closes the tap.
 */
const ABUSE_DROP_THRESHOLD = 5_000;

/**
 * The breaker counts drops per window, not over the binding's lifetime: a
 * long-lived session legitimately sheds the odd stale-epoch message on every
 * navigation, and those must never add up to a detach.
 */
const ABUSE_WINDOW_MS = 10_000;

/**
 * Monotonic across the process. Baked into every installed runtime so a guest
 * that is briefly running two of them can tell which one is current, including
 * across a rebind that resets the document epoch to 0.
 */
let installCounter = 0;

export interface SitePreviewBridgeDeps {
  getWebContents: (webContentsId: number) => Electron.WebContents | null;
  resolveWebContentsId: (panelId: string) => number | undefined;
  getPanelKind: (webContentsId: number) => string | undefined;
  /** The project that owns the view embedding this guest, resolved host-side. */
  resolveGuestProject: (wc: Electron.WebContents) => string | null;
  newSessionId: () => string;
  newBindingName: () => string;
  /** The core picker's fixed asset catalog. Injected so tests need no build output. */
  loadCoreGuestAsset: CoreGuestAssetLoader;
}

interface Binding {
  sessionId: string;
  panelId: string;
  projectId: string;
  webContentsId: number;
  /**
   * The view that established this binding, and the only recipient of its
   * observations. Recorded at bind time from the IPC sender, which is the one
   * thing about the caller the host can actually prove.
   */
  subscriberWebContentsId: number;
  bindingName: string;
  /** The picker's guest: its bootstrap, the extractors it installs, and its commands. */
  core: CoreGuest;
  /** Where this binding's traffic goes: the view that made it, through the picker's push route. */
  sink: ElementPickerSink;
  /**
   * True while the guest shows a document outside the origin policy. The
   * binding stays — the user's preview is still the same panel — but nothing is
   * installed, the CDP binding is removed, and guest traffic is ignored until a
   * document back inside the policy is installed.
   */
  suspended: boolean;
  mode: SitePreviewMode;
  documentEpoch: number;
  /** Highest sequence accepted in the current epoch; -1 before the first. */
  lastSequence: number;
  guestReady: boolean;
  droppedMessages: number;
  rateWindowStart: number;
  rateWindowCount: number;
  lastDropLogAt: number;
  abuseWindowStart: number;
  abuseWindowDrops: number;
  /**
   * Page + Runtime lease. The bridge does not own those domains — the console
   * capture instruments the same guest — and the lease is also where the
   * execution-context snapshot and the main frame id are read from.
   */
  lease: CdpLease | null;
  disposers: Array<() => void>;
  detached: boolean;
  /**
   * Serialises the CDP work a binding does. Reloads arrive in bursts, and two
   * overlapping reinstalls would interleave and leave the guest running a
   * bootstrap the host no longer tracks.
   */
  queue: Promise<void>;
  /** True while a reinstall is queued; further navigations fold into it. */
  reinstallQueued: boolean;
  /**
   * The epoch the live runtime was installed for, or null before the first
   * install. Two installs for one epoch both start the prelude's sequence at 0,
   * so the second one's messages are rejected as replays and the inspector goes
   * silent; this is what lets a redundant install be skipped instead.
   */
  installedEpoch: number | null;
}

// Behind a dynamic import like the rest of elementPicker/: main must not
// evaluate the picker's code until a core bind first asks for an asset.
const loadCoreGuestAsset: CoreGuestAssetLoader = async (id) =>
  (await import("./elementPicker/guestAssets.js")).loadCoreGuestAsset(id);

/**
 * A `<webview>` guest is never itself a registered project view, so its project
 * is the one owning its embedder. Resolving it host-side is what keeps a caller
 * from naming a preview belonging to some other project's view.
 */
function resolveEmbedderProject(wc: Electron.WebContents): string | null {
  const host = wc.hostWebContents;
  if (!host || host.isDestroyed()) return null;
  return getProjectForWebContents(host.id);
}

export class SitePreviewBridge {
  private readonly deps: SitePreviewBridgeDeps;
  private readonly bindings = new Map<string, Binding>();
  /**
   * Serialises the whole lifecycle of one panel's binding — bind AND detach.
   * Binds alone is not enough: an explicit detach racing a rebind deletes the
   * predecessor from the map before its install settles, so the successor sees
   * nothing to await and the retiring install can displace it.
   */
  private readonly panelLocks = new Map<string, Promise<unknown>>();
  /** Set once the owning handler is disposing; no new work is accepted after. */
  private closed = false;

  constructor(deps: Partial<SitePreviewBridgeDeps> = {}) {
    this.deps = {
      getWebContents: (id) => {
        const wc = electronWebContents.fromId(id);
        return wc && !wc.isDestroyed() ? wc : null;
      },
      resolveWebContentsId: (panelId) => getWebviewDialogService().getWebContentsId(panelId),
      getPanelKind: (id) => getWebviewDialogService().getPanelKind(id),
      resolveGuestProject: resolveEmbedderProject,
      newSessionId: () => randomUUID(),
      // Unguessable so an unrelated script in the page does not stumble onto the
      // binding by name. It is obfuscation, not authorisation — anything running
      // in the document can enumerate globals and find it either way.
      newBindingName: () => `__daintreeSitePreview_${randomBytes(8).toString("hex")}`,
      loadCoreGuestAsset,
      ...deps,
    };
  }

  getState(projectId: string, sessionId: string): SitePreviewBindingState | null {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.projectId !== projectId) return null;
    return toState(binding);
  }

  private withPanelLock<T>(panelId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.panelLocks.get(panelId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const gate = run.catch(() => undefined);
    this.panelLocks.set(panelId, gate);
    return run.finally(() => {
      // Drop the entry only if nothing queued behind this call, so a waiting
      // caller keeps its place in line.
      if (this.panelLocks.get(panelId) === gate) this.panelLocks.delete(panelId);
    });
  }

  /**
   * Bind the core Element Picker to a dev preview: an app-built bootstrap in
   * an isolated world, and per-framework extractors loaded only once the page
   * is seen to use their framework.
   *
   * Traffic goes to `sink`, addressed to the view that bound. A panel holds
   * one binding: binding it again supersedes the previous one.
   */
  async bindElementPicker(input: {
    projectId: string;
    panelId: string;
    mode: SitePreviewMode;
    subscriberWebContentsId: number;
    sink: ElementPickerSink;
  }): Promise<SitePreviewBindingState> {
    return this.withPanelLock(input.panelId, () => this.bindElementPickerLocked(input));
  }

  private async bindElementPickerLocked(input: {
    projectId: string;
    panelId: string;
    mode: SitePreviewMode;
    subscriberWebContentsId: number;
    sink: ElementPickerSink;
  }): Promise<SitePreviewBindingState> {
    const { projectId, panelId, mode, subscriberWebContentsId, sink } = input;
    this.assertOpen(panelId);
    const { webContentsId, wc } = this.resolveBindTarget(projectId, panelId);

    // Loaded on the first core bind, so an app that never opens the picker
    // never evaluates its schemas.
    const { CoreGuest } = await import("./elementPicker/coreGuest.js");
    this.assertOpen(panelId);

    for (const existing of [...this.bindings.values()]) {
      if (existing.panelId === panelId) {
        await this.teardown(existing, "rebound");
      }
    }
    this.assertOpen(panelId);

    const base = this.newBinding({
      panelId,
      projectId,
      webContentsId,
      subscriberWebContentsId,
      mode,
      sink,
    });
    // The guest's callbacks close over the finished binding; none of them runs
    // before `commitBinding` publishes it.
    const binding: Binding = {
      ...base,
      core: new CoreGuest({
        sessionId: base.sessionId,
        projectId,
        bindingName: base.bindingName,
        send: (method, params) => this.send(wc, method, params),
        enqueue: (work) => this.enqueue(binding, work),
        loadAsset: this.deps.loadCoreGuestAsset,
        emit: (payload) => this.emit(binding, payload),
        liveEpoch: () =>
          binding.detached || binding.suspended || this.closed ? null : binding.documentEpoch,
        mainWorld: () =>
          binding.lease === null
            ? null
            : {
                uniqueId: binding.lease.mainWorldUniqueId(),
                generation: binding.lease.navigationGeneration,
              },
        evaluateTimeoutMs: GUEST_EVALUATE_TIMEOUT_MS,
      }),
    };
    await this.commitBinding(binding, wc);
    // The install's own awaits are where a shutdown most often lands. The
    // shutdown owns this binding's teardown; handing back its session would give
    // the caller a binding that is gone or going.
    this.assertOpen(panelId);
    return toState(binding);
  }

  /** The bridge is closing; a bind that awaited past that point must not add a binding. */
  private assertOpen(panelId: string): void {
    if (this.closed) {
      throw new AppError({
        code: "CANCELLED",
        message: "The site preview bridge is shutting down",
        context: { panelId },
      });
    }
  }

  /**
   * The guest a bind may attach to: a live dev preview, in the project the
   * caller named. The caller states a project; the host proves it. Without
   * this a renderer could name a panel id belonging to another project's view
   * and receive its guest traffic.
   */
  private resolveBindTarget(
    projectId: string,
    panelId: string
  ): { webContentsId: number; wc: Electron.WebContents } {
    const webContentsId = this.deps.resolveWebContentsId(panelId);
    if (webContentsId === undefined) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "No dev preview is available on that panel",
        context: { panelId },
      });
    }
    if (this.deps.getPanelKind(webContentsId) !== DEV_PREVIEW_PANEL_KIND) {
      throw new AppError({
        code: "UNSUPPORTED",
        message: "That panel is not a dev preview",
        context: { panelId },
      });
    }
    const wc = this.deps.getWebContents(webContentsId);
    if (!wc) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "The dev preview guest is no longer available",
        context: { panelId, webContentsId },
      });
    }
    if (this.deps.resolveGuestProject(wc) !== projectId) {
      throw new AppError({
        code: "PERMISSION",
        message: "That dev preview belongs to a different project",
        context: { panelId, projectId },
      });
    }
    return { webContentsId, wc };
  }

  private newBinding(
    init: Pick<
      Binding,
      "panelId" | "projectId" | "webContentsId" | "subscriberWebContentsId" | "mode" | "sink"
    >
  ): Omit<Binding, "core"> {
    return {
      ...init,
      sessionId: this.deps.newSessionId(),
      bindingName: this.deps.newBindingName(),
      suspended: false,
      documentEpoch: 0,
      lastSequence: -1,
      guestReady: false,
      droppedMessages: 0,
      rateWindowStart: 0,
      rateWindowCount: 0,
      lastDropLogAt: 0,
      abuseWindowStart: 0,
      abuseWindowDrops: 0,
      lease: null,
      disposers: [],
      detached: false,
      queue: Promise.resolve(),
      reinstallQueued: false,
      installedEpoch: null,
    };
  }

  /** Publishes the binding and installs its guest; a failed install takes the binding down again. */
  private async commitBinding(binding: Binding, wc: Electron.WebContents): Promise<void> {
    this.bindings.set(binding.sessionId, binding);
    try {
      this.attachListeners(binding, wc);
      await this.enqueue(binding, () => this.installRuntime(binding, wc));
    } catch (err) {
      await this.teardown(binding, "install-failed");
      if (err instanceof AppError) throw err;
      throw new AppError({
        code: "INTERNAL",
        message: "Failed to install the site preview runtime",
        context: { panelId: binding.panelId, webContentsId: binding.webContentsId },
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  async detach(projectId: string, sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.projectId !== projectId) return;
    await this.withPanelLock(binding.panelId, () => this.teardown(binding, "requested"));
  }

  async setMode(
    projectId: string,
    sessionId: string,
    mode: SitePreviewMode
  ): Promise<SitePreviewBindingState> {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.projectId !== projectId) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "No site preview binding for that session",
        context: { sessionId },
      });
    }
    binding.mode = mode;
    // Recorded but not poked: a suspended binding has no runtime of ours in
    // the page, and the document standing there is one the policy excluded.
    // The next install bakes the mode in from `binding.mode`.
    if (binding.suspended) return toState(binding);
    await binding.core.setMode(mode);
    return toState(binding);
  }

  /**
   * Select again, in a core picker binding's page, the element the view had
   * selected: by the id the page reported while it is still the same node,
   * else by the framework's locator. False when the page found nothing, and
   * while suspended: a locator is a path in the user's repository, and the
   * document standing there is one the policy excluded.
   */
  async reselectElementPicker(
    projectId: string,
    sessionId: string,
    request: ElementPickerReselectRequest
  ): Promise<boolean> {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.projectId !== projectId) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "No site preview binding for that session",
        context: { sessionId },
      });
    }
    if (binding.suspended) return false;
    const plain = plainReselectRequest(request);
    if (plain === null) return false;
    return binding.core.reselect(plain);
  }

  /** Drop the guest's selection so the page stops highlighting what the drawer refused. */
  async clearSelection(projectId: string, sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.projectId !== projectId) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "No site preview binding for that session",
        context: { sessionId },
      });
    }
    // Nothing of ours is in a suspended binding's page, so this would only
    // poke whatever off-policy document is standing there.
    if (binding.suspended) return;
    await binding.core.clearSelection();
  }

  /** The pointer left the preview for the host; the guest stops drawing what it hovered. */
  async clearHover(projectId: string, sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.projectId !== projectId) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "No site preview binding for that session",
        context: { sessionId },
      });
    }
    // As above: a suspended binding has no runtime to tell.
    if (binding.suspended) return;
    await binding.core.clearHover();
  }

  /**
   * Closes the bridge synchronously, then cleans up. The synchronous half
   * matters: a bind already queued behind a resolved lock would otherwise
   * install into a guest nothing owns any more.
   */
  async disposeAll(): Promise<void> {
    // Set before any await: binds and `installRuntime` both check it, so
    // a bind already queued behind a resolved lock cannot install into a guest
    // nothing owns any more.
    this.closed = true;
    for (const binding of [...this.bindings.values()]) {
      await this.teardown(binding, "host-shutdown");
    }
  }

  /* ---------------------------------------------------------------------- */

  private attachListeners(binding: Binding, wc: Electron.WebContents): void {
    const onMessage = (
      _event: Electron.Event,
      method: string,
      params: Record<string, unknown>
    ): void => {
      try {
        this.handleCdpMessage(binding, method, params);
      } catch (err) {
        console.warn(
          "[SitePreviewBridge] CDP message handling failed:",
          formatErrorMessage(err, "CDP message handling failed")
        );
      }
    };
    wc.debugger.on("message", onMessage);
    binding.disposers.push(() => wc.debugger.off("message", onMessage));

    // A document replacement resets the guest's sequence counter, so the epoch
    // is what tells a reset apart from a replay. Reinstalling on the freshly
    // committed document is what puts the new epoch in the guest's hands.
    const onNavigate = (): void => {
      void this.advanceEpoch(binding);
    };
    wc.on("did-navigate", onNavigate);
    binding.disposers.push(() => wc.off("did-navigate", onNavigate));

    const onDestroyed = (): void => {
      void this.teardown(binding, "guest-destroyed").catch(() => undefined);
    };
    wc.once("destroyed", onDestroyed);
    binding.disposers.push(() => wc.off("destroyed", onDestroyed));

    // The debugger can be detached out from under us (DevTools opening on the
    // guest, another consumer detaching) while the page lives on. The binding is
    // dead at that point, and saying so beats going quiet.
    const onDebuggerDetach = (): void => {
      void this.teardown(binding, "debugger-detached").catch(() => undefined);
    };
    wc.debugger.on("detach", onDebuggerDetach);
    binding.disposers.push(() => wc.debugger.off("detach", onDebuggerDetach));

    // The subscriber is usually the view embedding the guest, and dies with it.
    // It need not be: a second window on the same project can bind to a preview
    // hosted in the first. When that view goes, the binding has no consumer left
    // — every push is addressed to it — so the runtime in the page would keep
    // observing the user's site with nothing listening. Through the shared
    // per-view watcher: a view can subscribe to several previews, and a listener
    // each would run its `destroyed` count past the dev build's limit.
    const subscriber = this.deps.getWebContents(binding.subscriberWebContentsId);
    if (subscriber && subscriber !== wc) {
      const onSubscriberDestroyed = (): void => {
        void this.teardown(binding, "subscriber-destroyed").catch(() => undefined);
      };
      binding.disposers.push(onWebContentsDestroyed(subscriber, onSubscriberDestroyed));
    }
  }

  private handleCdpMessage(
    binding: Binding,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (binding.detached) return;
    // The CDP binding is removed on suspension, so nothing should arrive; a
    // call that raced the removal is from a document the policy excluded, and
    // it is not even worth counting.
    if (binding.suspended) return;

    // Execution contexts are tracked by the CDP lease service, not here: the
    // `Runtime.enable` that replays them is sent once, by whichever consumer
    // turned the domain on, and that may not be this binding.
    if (method !== "Runtime.bindingCalled") return;

    if (params.name !== binding.bindingName) return;
    const contextId = params.executionContextId;
    if (typeof contextId !== "number" || !binding.core.isTrustedContext(contextId)) {
      this.drop(binding, "foreign-context");
      return;
    }
    const payload = params.payload;
    if (typeof payload !== "string") {
      this.drop(binding, "malformed");
      return;
    }
    if (!this.admitForParsing(binding)) {
      this.drop(binding, "rate-limited");
      return;
    }
    this.handleEnvelope(binding, payload);
  }

  /**
   * An envelope admitted against the picker's contract. The host reads two of
   * its events itself, because they decide what it injects next.
   */
  private handleEnvelope(binding: Binding, payload: string): void {
    const core = binding.core;
    const verdict = core.admit(payload, {
      sessionId: binding.sessionId,
      documentEpoch: binding.documentEpoch,
      lastSequence: binding.lastSequence,
    });
    if (!verdict.ok) {
      this.drop(binding, verdict.reason);
      return;
    }
    binding.lastSequence = verdict.envelope.sequence;
    const event = verdict.envelope.event;
    if (event.type === "documentReady") binding.guestReady = true;
    this.emit(binding, {
      kind: "picker-event",
      sessionId: binding.sessionId,
      panelId: binding.panelId,
      projectId: binding.projectId,
      documentEpoch: binding.documentEpoch,
      sequence: verdict.envelope.sequence,
      event,
    });
    core.onGuestEvent(binding.documentEpoch, event);
  }

  /**
   * The only way out of this class. Every push goes to the binding's own sink,
   * which is addressed to the view that bound: what a guest observation carries
   * — the page's structure, the user's selection, source locations in their
   * repository — belongs to the one view that asked for it, not to every view
   * of the project.
   */
  private emit(binding: Binding, payload: ElementPickerPushPayload): void {
    binding.sink(payload);
  }

  private admitForParsing(binding: Binding): boolean {
    const now = Date.now();
    if (now - binding.rateWindowStart >= 1000) {
      binding.rateWindowStart = now;
      binding.rateWindowCount = 0;
    }
    binding.rateWindowCount++;
    return binding.rateWindowCount <= MAX_ENVELOPES_PER_SECOND;
  }

  private drop(binding: Binding, reason: GuestEnvelopeRejection): void {
    binding.droppedMessages++;
    // Time-based, not count-based: a page that spams rejects must not be able to
    // turn the host's log into its own write amplifier.
    const now = Date.now();
    if (now - binding.lastDropLogAt >= DROP_LOG_INTERVAL_MS) {
      binding.lastDropLogAt = now;
      console.warn("[SitePreviewBridge] dropped guest envelope", {
        sessionId: binding.sessionId,
        panelId: binding.panelId,
        reason,
        droppedMessages: binding.droppedMessages,
      });
    }

    if (now - binding.abuseWindowStart >= ABUSE_WINDOW_MS) {
      binding.abuseWindowStart = now;
      binding.abuseWindowDrops = 0;
    }
    binding.abuseWindowDrops++;
    if (binding.abuseWindowDrops >= ABUSE_DROP_THRESHOLD) {
      // Counting and discarding still leaves CDP marshalling every string into
      // main. Removing the binding is what actually stops the ingress.
      void this.teardown(binding, "guest-flooding").catch(() => undefined);
    }
  }

  private async advanceEpoch(binding: Binding): Promise<void> {
    if (binding.detached) return;
    binding.documentEpoch++;
    binding.lastSequence = -1;
    binding.guestReady = false;
    // Before any await: an extractor install or probe still in flight was for
    // the document that just went, and must not land in this one.
    binding.core.invalidate();

    const wc = this.deps.getWebContents(binding.webContentsId);
    if (!wc) return;
    // A page can reload in a loop. One queued reinstall is enough: it reads the
    // epoch when it runs, so it always installs the latest one.
    if (binding.reinstallQueued) {
      this.emit(binding, {
        kind: "epoch-advanced",
        sessionId: binding.sessionId,
        projectId: binding.projectId,
        documentEpoch: binding.documentEpoch,
      });
      return;
    }
    binding.reinstallQueued = true;
    try {
      await this.enqueue(binding, async () => {
        binding.reinstallQueued = false;
        await this.installRuntime(binding, wc);
      });
    } catch (err) {
      if (!isExpectedCdpError(err)) {
        console.warn(
          "[SitePreviewBridge] runtime reinstall after navigation failed:",
          formatErrorMessage(err, "runtime reinstall failed")
        );
      }
    }
    if (binding.detached) return;
    // Sent after the reinstall, so the new runtime's own `documentReady` for this
    // epoch can reach a consumer *before* this. Consumers must key state on the
    // epoch carried by each event, not on the order these two arrive in.
    this.emit(binding, {
      kind: "epoch-advanced",
      sessionId: binding.sessionId,
      projectId: binding.projectId,
      documentEpoch: binding.documentEpoch,
    });
  }

  private enqueue(binding: Binding, work: () => Promise<void>): Promise<void> {
    const next = binding.queue.then(work, work);
    // The chain must survive a rejected step, or one failed reinstall would
    // wedge every later one behind a permanently rejected promise.
    binding.queue = next.catch(() => undefined);
    return next;
  }

  private async installRuntime(binding: Binding, wc: Electron.WebContents): Promise<void> {
    // The binding can be torn down, or the bridge closed, while this call sits
    // in the queue; installing then leaves a runtime in the guest that nothing
    // owns or removes.
    if (binding.detached || this.closed) return;
    // Whether the guest is still showing the document it was created with. A
    // blank preview is installed on so the runtime is in place for the dev
    // server's first document; a blank document reached by navigating is not
    // the same thing, because it inherits the origin that sent it there, so
    // the allowance ends the moment anything commits.
    const initialDocument = binding.documentEpoch === 0 && binding.installedEpoch === null;
    // The policy is checked per document, not per binding: the preview can
    // navigate anywhere, and the runtime goes only where the policy allows. It
    // is checked before the double-install guard below, because an install
    // that read its epoch under a navigation has satisfied that guard for a
    // document it never looked at.
    if (!originPolicyAllows(DEFAULT_GUEST_ORIGIN_POLICY, wc.getURL(), { initialDocument })) {
      await this.suspend(binding, wc);
      return;
    }
    // A navigation can queue a reinstall while the bind's own install is still
    // awaiting CDP; by the time both run they read the same epoch. Installing
    // twice for one epoch restarts the bootstrap's sequence at 0 and the host
    // then drops every message from the second one as a replay.
    if (binding.installedEpoch === binding.documentEpoch) return;
    // `Page` carries the frame tree and the isolated world the bootstrap runs
    // in. `Runtime` carries both the binding calls and the execution contexts.
    //
    // Leased, not enabled: the console capture instruments the same guest, and
    // whichever of the two enables `Runtime` first is the only one CDP replays
    // the contexts to — which is why the snapshot is read from the lease rather
    // than collected here.
    if (!binding.lease) {
      const lease = await acquireCdpLease(wc, ["Page", "Runtime"], {
        onInvalidated: () => {
          void this.teardown(binding, "debugger-detached").catch(() => undefined);
        },
      });
      // Teardown waits on this queue only so long. An acquisition that outran
      // that wait has nothing left to serve, and a lease parked on a torn-down
      // binding would hold the domains on for good.
      if (binding.detached || this.closed) {
        await lease.release().catch(() => undefined);
        return;
      }
      binding.lease = lease;
    }
    // Re-read per install, so the main frame id is refreshed on bind and after
    // every navigation.
    await binding.lease.refreshMainFrameId();
    // Teardown's bounded wait can expire under that read; it has released the
    // lease by then, and a binding added now would outlive everything else.
    if (binding.detached || this.closed) return;

    if (binding.suspended) {
      // Cleared before the install, not after: the bootstrap reports
      // `documentReady` from inside the install below, and a message arriving
      // on a still-suspended binding would be ignored.
      binding.suspended = false;
      this.emit(binding, {
        kind: "origin-policy",
        sessionId: binding.sessionId,
        projectId: binding.projectId,
        documentEpoch: binding.documentEpoch,
        suspended: false,
      });
    }

    await this.installCore(binding, binding.core);
  }

  /**
   * The core picker installs into the current document only — no new-document
   * script — because its bootstrap does not need to run before the page's own
   * code, and a registration that outlives the document is how an old epoch's
   * guest would end up in the next one.
   */
  private async installCore(binding: Binding, core: CoreGuest): Promise<void> {
    const frameId = binding.lease?.mainFrameId ?? null;
    if (frameId === null) {
      throw new AppError({
        code: "INTERNAL",
        message: "The dev preview's main frame could not be read",
        context: { panelId: binding.panelId },
      });
    }
    const installId = ++installCounter;
    // Read once: both can change across the awaits below.
    const epoch = binding.documentEpoch;
    const installedMode = binding.mode;
    const installed = await core.install({
      epoch,
      installId,
      mode: installedMode,
      origins: DEFAULT_GUEST_ORIGIN_POLICY,
      frameId,
    });
    // Not installed means the document went under the install; the navigation
    // that replaced it queues its own, which this must not mark as done.
    if (!installed || binding.detached || this.closed) return;
    binding.installedEpoch = epoch;
    if (binding.mode !== installedMode) await core.setMode(binding.mode);
  }

  /**
   * Withhold the runtime from a document outside the origin policy. The CDP
   * binding goes (which is what closes the tap), and anything of ours still in
   * the page is told to dispose itself, as on teardown. The binding itself
   * survives, so a document back inside the policy installs without the
   * renderer rebinding.
   */
  private async suspend(binding: Binding, wc: Electron.WebContents): Promise<void> {
    // A second document outside the policy has nothing of ours in it.
    if (binding.suspended) return;
    binding.core.invalidate();
    // Before the first install there is no lease, no binding and no runtime;
    // the CDP calls would only fail against a domain nothing enabled.
    if (binding.lease) {
      await this.tryCdp(wc, "Runtime.removeBinding", { name: binding.bindingName });
      await binding.core.disposeInGuest();
    }
    binding.guestReady = false;
    if (binding.detached || this.closed) return;
    binding.suspended = true;
    this.emit(binding, {
      kind: "origin-policy",
      sessionId: binding.sessionId,
      projectId: binding.projectId,
      documentEpoch: binding.documentEpoch,
      suspended: true,
    });
  }

  private async send(
    wc: Electron.WebContents,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    return wc.debugger.sendCommand(method, params);
  }

  /** Teardown-path CDP call: never throws, never blocks the next removal. */
  private async tryCdp(
    wc: Electron.WebContents,
    method: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.send(wc, method, params);
    } catch (err) {
      if (isExpectedCdpError(err)) return;
      console.warn(
        `[SitePreviewBridge] ${method} during teardown failed:`,
        formatErrorMessage(err, "CDP teardown call failed")
      );
    }
  }

  private async teardown(binding: Binding, reason: SitePreviewDetachReason): Promise<void> {
    if (binding.detached) return;
    binding.detached = true;
    this.bindings.delete(binding.sessionId);
    binding.core.invalidate();

    for (const dispose of binding.disposers.reverse()) {
      try {
        dispose();
      } catch (err) {
        console.warn(
          "[SitePreviewBridge] listener teardown failed:",
          formatErrorMessage(err, "listener teardown failed")
        );
      }
    }
    binding.disposers.length = 0;

    // Let an install that is already past its detached-guard settle, so what is
    // disposed below is what was actually installed — but never wait on it
    // indefinitely: its `Runtime.evaluate` runs in a page that may be hostile.
    await Promise.race([
      binding.queue.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, GUEST_EVALUATE_TIMEOUT_MS).unref?.()),
    ]);

    const wc = this.deps.getWebContents(binding.webContentsId);
    if (wc) {
      // Each removal stands alone: one failure must not skip the other, and
      // removing the binding is the one that actually closes the tap.
      await this.tryCdp(wc, "Runtime.removeBinding", { name: binding.bindingName });
      await binding.core.disposeInGuest();
    }
    // Released last: `Runtime.removeBinding` and the disposal evaluate above
    // both need the domain still enabled.
    const lease = binding.lease;
    binding.lease = null;
    await lease?.release().catch(() => undefined);

    this.emit(binding, {
      kind: "detached",
      sessionId: binding.sessionId,
      projectId: binding.projectId,
      reason,
    });
  }
}

/**
 * A compiled source location, checked by shape rather than by type. The IPC
 * schema bounds these already; this is the bridge refusing to interpolate
 * anything it has not looked at itself, whatever path reached it.
 */
function isSourceLocation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const loc = value as { file?: unknown; line?: unknown; column?: unknown };
  return (
    typeof loc.file === "string" &&
    loc.file.length > 0 &&
    Number.isSafeInteger(loc.line) &&
    Number.isSafeInteger(loc.column)
  );
}

function isPlainString(value: unknown): boolean {
  return typeof value === "string";
}

/**
 * The reselect request rebuilt from fields the bridge has looked at: it is
 * JSON-encoded into host-authored guest source, and nothing it carries is the
 * caller's to shape beyond these.
 */
function plainReselectRequest(
  request: ElementPickerReselectRequest
): CoreGuestReselectRequest | null {
  const out: CoreGuestReselectRequest = {};
  if (request.elementId !== undefined) {
    if (!isPlainString(request.elementId)) return null;
    out.elementId = request.elementId;
  }
  if (request.framework !== undefined) {
    if (!isPlainString(request.framework)) return null;
    out.framework = request.framework;
  }
  if (request.locator !== undefined) {
    const { loc, index, component } = request.locator;
    if (!isSourceLocation(loc) || !Number.isSafeInteger(index) || index < 0) return null;
    if (component !== undefined && !isSourceLocation(component)) return null;
    out.locator = {
      loc: { file: loc.file, line: loc.line, column: loc.column },
      index,
      ...(component === undefined
        ? {}
        : { component: { file: component.file, line: component.line, column: component.column } }),
    };
  }
  if (request.reveal !== undefined) {
    if (typeof request.reveal !== "boolean") return null;
    out.reveal = request.reveal;
  }
  return out;
}

function toState(binding: Binding): SitePreviewBindingState {
  return {
    sessionId: binding.sessionId,
    panelId: binding.panelId,
    projectId: binding.projectId,
    documentEpoch: binding.documentEpoch,
    mode: binding.mode,
    guestReady: binding.guestReady,
    droppedMessages: binding.droppedMessages,
    suspended: binding.suspended,
  };
}

let instance: SitePreviewBridge | null = null;

export function getSitePreviewBridge(deps?: Partial<SitePreviewBridgeDeps>): SitePreviewBridge {
  if (!instance) {
    if (!deps) {
      throw new AppError({
        code: "INTERNAL",
        message: "SitePreviewBridge accessed before its IPC handlers registered",
      });
    }
    instance = new SitePreviewBridge(deps);
  }
  return instance;
}

export function resetSitePreviewBridge(): void {
  instance = null;
}
