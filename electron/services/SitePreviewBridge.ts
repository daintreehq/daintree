/**
 * SitePreviewBridge: binds a caller to a running dev-preview guest, installs an
 * approved runtime inside it over CDP, and turns the guest's push traffic into
 * validated, epoch-stamped observations.
 *
 * Why CDP and not a preload: `will-attach-webview` in `electron/window/createWindow.ts`
 * strips `preload` and forces `sandbox` + `contextIsolation` on every `<webview>`,
 * deliberately. The guest therefore has no privileged bridge of its own and the
 * only way in is the debugger session. `Runtime.addBinding` gives the reverse
 * direction; the script must run in the MAIN world because `__svelte_meta` is a
 * DOM-node expando and expandos are per-world.
 *
 * Trust model. The guest is a page the user is building and is assumed hostile:
 * a compromise there can call the binding with anything. So the session id
 * scopes traffic, it does not authorise it; epoch and sequence establish that a
 * message describes the *current* document rather than a replay from a previous
 * one; and nothing the guest says about files, paths or revisions is acted on
 * here. What survives validation is an observation, forwarded as such.
 *
 * There is intentionally no "evaluate this script in the guest" operation, and
 * no caller-supplied body either: a bind names a host-registered guest adapter
 * (`sitePreview/guestAdapters.ts`) and the host loads that adapter's text
 * itself. The only other thing evaluated is a fixed host-authored mode poke.
 * See `sitePreview/guestRuntime.ts`.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { webContents as electronWebContents } from "electron";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type {
  SitePreviewBindingState,
  SitePreviewCandidate,
  SitePreviewDetachReason,
  SitePreviewMode,
  SitePreviewPushPayload,
} from "../../shared/types/ipc/sitePreview.js";
import { isExpectedCdpError } from "../utils/webContentsLifecycle.js";
import { acquireCdpLease, type CdpLease } from "./cdp/WebContentsCdpService.js";
import { AppError } from "../utils/errorTypes.js";
import { getWebviewDialogService } from "./WebviewDialogService.js";
import { getProjectForWebContents } from "../window/webContentsRegistry.js";
import {
  DOCUMENT_READY,
  validateGuestEnvelope,
  type GuestEnvelopeRejection,
} from "./sitePreview/guestProtocol.js";
import {
  buildDisposeSource,
  buildGuestRuntimeSource,
  buildModeUpdateSource,
  buildClearSelectionSource,
  buildReselectSource,
} from "./sitePreview/guestRuntime.js";
import {
  loadGuestAdapterSource,
  resolveGuestAdapter,
  type GuestAdapter,
} from "./sitePreview/guestAdapters.js";

const DEV_PREVIEW_PANEL_KIND = "dev-preview";

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

interface GuestDescriptor {
  webContentsId: number;
  panelId: string;
  projectId: string | null;
  url: string | null;
}

export interface SitePreviewBridgeDeps {
  /** Every live dev-preview guest, with the project that embeds it. */
  listGuests: () => GuestDescriptor[];
  getWebContents: (webContentsId: number) => Electron.WebContents | null;
  resolveWebContentsId: (panelId: string) => number | undefined;
  getPanelKind: (webContentsId: number) => string | undefined;
  /** The project that owns the view embedding this guest, resolved host-side. */
  resolveGuestProject: (wc: Electron.WebContents) => string | null;
  push: (payload: SitePreviewPushPayload) => void;
  newSessionId: () => string;
  newBindingName: () => string;
  /** The guest runtime registry. Injected so tests need no real asset on disk. */
  resolveGuestAdapter: (adapterId: string) => Pick<GuestAdapter, "id" | "pluginId"> | null;
  loadGuestAdapterSource: (adapterId: string) => Promise<string>;
}

interface Binding {
  sessionId: string;
  panelId: string;
  projectId: string;
  webContentsId: number;
  bindingName: string;
  /** The guest adapter this binding names, and the plugin that owns it. */
  adapterId: string;
  pluginId: string;
  /** The adapter's body, resolved host-side at bind time. */
  runtimeSource: string;
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
  scriptIdentifier: string | null;
  /** Install id of the runtime currently in the guest, for a matched disposal. */
  installId: number;
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
   * overlapping reinstalls would interleave remove/add and leave the guest
   * running a script whose identifier the host no longer holds.
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

function defaultListGuests(): GuestDescriptor[] {
  const dialogs = getWebviewDialogService();
  const out: GuestDescriptor[] = [];
  for (const wc of electronWebContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    if (dialogs.getPanelKind(wc.id) !== DEV_PREVIEW_PANEL_KIND) continue;
    const panelId = dialogs.getPanelId(wc.id);
    if (!panelId) continue;
    out.push({
      webContentsId: wc.id,
      panelId,
      projectId: resolveEmbedderProject(wc),
      url: wc.getURL() || null,
    });
  }
  return out;
}

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

  constructor(deps: Partial<SitePreviewBridgeDeps> & Pick<SitePreviewBridgeDeps, "push">) {
    this.deps = {
      listGuests: defaultListGuests,
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
      resolveGuestAdapter,
      loadGuestAdapterSource,
      ...deps,
    };
  }

  /** Dev-preview panels the given project could bind to. */
  listCandidates(projectId: string): SitePreviewCandidate[] {
    const boundByPanel = new Map<string, string>();
    for (const binding of this.bindings.values()) {
      if (binding.projectId === projectId) boundByPanel.set(binding.panelId, binding.sessionId);
    }
    return this.deps
      .listGuests()
      .filter((guest) => guest.projectId === projectId)
      .map((guest) => ({
        panelId: guest.panelId,
        url: guest.url,
        boundSessionId: boundByPanel.get(guest.panelId) ?? null,
      }));
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

  async bind(input: {
    projectId: string;
    panelId: string;
    adapterId: string;
    mode: SitePreviewMode;
  }): Promise<SitePreviewBindingState> {
    return this.withPanelLock(input.panelId, () => this.bindLocked(input));
  }

  private async bindLocked(input: {
    projectId: string;
    panelId: string;
    adapterId: string;
    mode: SitePreviewMode;
  }): Promise<SitePreviewBindingState> {
    const { projectId, panelId, adapterId, mode } = input;

    if (this.closed) {
      throw new AppError({
        code: "CANCELLED",
        message: "The site preview bridge is shutting down",
        context: { panelId },
      });
    }

    const adapter = this.deps.resolveGuestAdapter(adapterId);
    if (!adapter) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "No guest runtime is registered under that id",
        context: { panelId, adapterId },
      });
    }

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
    // The caller states a project; the host proves it. Without this a renderer
    // could name a panel id belonging to another project's view and receive its
    // guest traffic.
    if (this.deps.resolveGuestProject(wc) !== projectId) {
      throw new AppError({
        code: "PERMISSION",
        message: "That dev preview belongs to a different project",
        context: { panelId, projectId },
      });
    }

    // Loaded before anything is torn down: a failed read would otherwise leave
    // the panel with no binding at all.
    const runtimeSource = await this.deps.loadGuestAdapterSource(adapterId);
    // The read is the first await a bind performs, so a shutdown can complete
    // underneath it. `disposeAll` has already walked the bindings map by then
    // and would never see the one this call is about to add.
    if (this.closed) {
      throw new AppError({
        code: "CANCELLED",
        message: "The site preview bridge is shutting down",
        context: { panelId },
      });
    }

    // Rebinding the same panel supersedes the previous session rather than
    // running two runtimes that would fight over the global.
    for (const existing of [...this.bindings.values()]) {
      if (existing.panelId === panelId) {
        await this.teardown(existing, "rebound");
      }
    }
    // The predecessor's teardown is another await a shutdown can finish
    // under, and it removed the predecessor from the map first — so the
    // shutdown's walk saw nothing, and a successor added now would outlive it.
    if (this.closed) {
      throw new AppError({
        code: "CANCELLED",
        message: "The site preview bridge is shutting down",
        context: { panelId },
      });
    }

    const binding: Binding = {
      sessionId: this.deps.newSessionId(),
      panelId,
      projectId,
      webContentsId,
      bindingName: this.deps.newBindingName(),
      adapterId,
      pluginId: adapter.pluginId,
      runtimeSource,
      mode,
      documentEpoch: 0,
      lastSequence: -1,
      guestReady: false,
      droppedMessages: 0,
      rateWindowStart: 0,
      rateWindowCount: 0,
      lastDropLogAt: 0,
      abuseWindowStart: 0,
      abuseWindowDrops: 0,
      scriptIdentifier: null,
      installId: 0,
      lease: null,
      disposers: [],
      detached: false,
      queue: Promise.resolve(),
      reinstallQueued: false,
      installedEpoch: null,
    };

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
        context: { panelId, webContentsId },
        cause: err instanceof Error ? err : undefined,
      });
    }
    return toState(binding);
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
    const wc = this.deps.getWebContents(binding.webContentsId);
    if (wc) {
      // Fixed host-authored source with one enum member interpolated — the guest
      // never gets to choose what runs here. No `contextId`, so it lands in the
      // main frame's default world, which is the only one the runtime runs in.
      await this.send(wc, "Runtime.evaluate", {
        expression: buildModeUpdateSource(mode),
        timeout: GUEST_EVALUATE_TIMEOUT_MS,
      });
    }
    return toState(binding);
  }

  /**
   * Closes the bridge synchronously, then cleans up. The synchronous half
   * matters: a bind already queued behind a resolved lock would otherwise
   * install into a guest nothing owns any more.
   */
  /**
   * Select the element compiled from `loc` in the guest, as a click would, so
   * the runtime re-observes it and the view re-resolves it with fresh proof.
   * False when the runtime found nothing — the caller keeps its stale state.
   */
  async reselect(
    projectId: string,
    sessionId: string,
    loc: { file: string; line: number; column: number },
    index = 0,
    component: { file: string; line: number; column: number } | null = null,
    occurrence: string | null = null
  ): Promise<boolean> {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.projectId !== projectId) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "No site preview binding for that session",
        context: { sessionId },
      });
    }
    const wc = this.deps.getWebContents(binding.webContentsId);
    if (!wc) return false;
    const result = (await this.send(wc, "Runtime.evaluate", {
      expression: buildReselectSource(loc, index, component, occurrence),
      returnByValue: true,
      timeout: GUEST_EVALUATE_TIMEOUT_MS,
    })) as { result?: { value?: unknown } } | undefined;
    return result?.result?.value === true;
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
    const wc = this.deps.getWebContents(binding.webContentsId);
    if (!wc) return;
    await this.send(wc, "Runtime.evaluate", {
      expression: buildClearSelectionSource(),
      timeout: GUEST_EVALUATE_TIMEOUT_MS,
    });
  }

  async disposeAll(): Promise<void> {
    // Set before any await: `bindLocked` and `installRuntime` both check it, so
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
  }

  private handleCdpMessage(
    binding: Binding,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (binding.detached) return;

    // Execution contexts are tracked by the CDP lease service, not here: the
    // `Runtime.enable` that replays them is sent once, by whichever consumer
    // turned the domain on, and that may not be this binding.
    if (method !== "Runtime.bindingCalled") return;

    if (params.name !== binding.bindingName) return;
    const contextId = params.executionContextId;
    if (typeof contextId !== "number" || !isTrustedContext(binding, contextId)) {
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

    const verdict = validateGuestEnvelope(payload, {
      sessionId: binding.sessionId,
      documentEpoch: binding.documentEpoch,
      lastSequence: binding.lastSequence,
    });
    if (!verdict.ok) {
      this.drop(binding, verdict.reason);
      return;
    }

    binding.lastSequence = verdict.envelope.sequence;
    // The one payload fact the host acts on. Everything else in the event is
    // the adapter's to validate, and is forwarded uninterpreted.
    if (verdict.envelope.event.type === DOCUMENT_READY) binding.guestReady = true;

    this.deps.push({
      kind: "guest-event",
      sessionId: binding.sessionId,
      panelId: binding.panelId,
      projectId: binding.projectId,
      documentEpoch: binding.documentEpoch,
      sequence: verdict.envelope.sequence,
      event: verdict.envelope.event,
    });
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
        // Which runtime is misbehaving, and whose it is.
        adapterId: binding.adapterId,
        pluginId: binding.pluginId,
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

    const wc = this.deps.getWebContents(binding.webContentsId);
    if (!wc) return;
    // A page can reload in a loop. One queued reinstall is enough: it reads the
    // epoch when it runs, so it always installs the latest one.
    if (binding.reinstallQueued) {
      this.deps.push({
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
    this.deps.push({
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
    // A navigation can queue a reinstall while the bind's own install is still
    // awaiting CDP; by the time both run they read the same epoch. Installing
    // twice for one epoch restarts the prelude's sequence at 0 and the host then
    // drops every message from the second runtime as a replay.
    if (binding.installedEpoch === binding.documentEpoch && binding.scriptIdentifier !== null) {
      return;
    }
    // `Page` is what makes `Page.addScriptToEvaluateOnNewDocument` take effect
    // at all — without the domain enabled it still returns an identifier and the
    // script silently never installs. `Runtime` carries both the binding calls
    // and the execution contexts that tell the main frame's world apart from an
    // iframe's.
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

    await this.send(wc, "Runtime.addBinding", { name: binding.bindingName });

    if (binding.scriptIdentifier) {
      await this.send(wc, "Page.removeScriptToEvaluateOnNewDocument", {
        identifier: binding.scriptIdentifier,
      });
      binding.scriptIdentifier = null;
    }

    const installId = ++installCounter;
    // Read once: both can change across the awaits below, and the source bakes
    // in whatever was read here.
    const epoch = binding.documentEpoch;
    const installedMode = binding.mode;
    const source = buildGuestRuntimeSource({
      sessionId: binding.sessionId,
      installId,
      documentEpoch: epoch,
      bindingName: binding.bindingName,
      mode: installedMode,
      runtimeSource: binding.runtimeSource,
    });

    const added = (await this.send(wc, "Page.addScriptToEvaluateOnNewDocument", { source })) as
      { identifier?: string } | undefined;
    const identifier = added?.identifier ?? null;
    // Re-check after the await: a teardown that ran while this was in flight has
    // already removed whatever it knew about, so this registration would outlive
    // the binding unless it is undone here.
    if (binding.detached || this.closed) {
      if (identifier) {
        await this.send(wc, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(
          () => undefined
        );
      }
      return;
    }
    binding.scriptIdentifier = identifier;
    binding.installId = installId;

    // The new-document script only runs on the *next* document, so evaluate it
    // once into the current one. Without this, binding would require a reload.
    const evaluated = (await this.send(wc, "Runtime.evaluate", {
      expression: source,
      timeout: GUEST_EVALUATE_TIMEOUT_MS,
    })) as { exceptionDetails?: { text?: string } } | undefined;
    if (evaluated?.exceptionDetails) {
      // A throw here means the runtime never took hold in the live document, so
      // reporting the bind as successful would be a lie. The new-document copy
      // is removed by the caller's failure path.
      throw new AppError({
        code: "INTERNAL",
        message: "The site preview runtime threw while initialising in the guest",
        context: { panelId: binding.panelId, detail: evaluated.exceptionDetails.text },
      });
    }
    binding.installedEpoch = epoch;

    // `setMode` runs outside this queue, so a switch made while the install was
    // awaiting CDP poked a runtime that did not exist yet, and the source above
    // baked in the old mode. Left alone, the host reports Browse while the page
    // is still intercepting clicks.
    if (binding.mode !== installedMode && !binding.detached && !this.closed) {
      await this.send(wc, "Runtime.evaluate", {
        expression: buildModeUpdateSource(binding.mode),
        timeout: GUEST_EVALUATE_TIMEOUT_MS,
      });
    }
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

    // Let an install that is already past its detached-guard settle, so the
    // identifier removed below is the one actually installed — but never wait on
    // it indefinitely: its `Runtime.evaluate` runs in a page that may be hostile.
    await Promise.race([
      binding.queue.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, GUEST_EVALUATE_TIMEOUT_MS).unref?.()),
    ]);

    const wc = this.deps.getWebContents(binding.webContentsId);
    if (wc) {
      // Each removal stands alone: one failure must not skip the others, and
      // removing the binding is the one that actually closes the tap.
      if (binding.scriptIdentifier) {
        await this.tryCdp(wc, "Page.removeScriptToEvaluateOnNewDocument", {
          identifier: binding.scriptIdentifier,
        });
      }
      await this.tryCdp(wc, "Runtime.removeBinding", { name: binding.bindingName });
      if (binding.installId > 0) {
        // Best effort, and matched on install id so a detach cannot kill a newer
        // runtime that already took the global. The guest's own listeners and
        // overlay would otherwise outlive the binding.
        await this.tryCdp(wc, "Runtime.evaluate", {
          expression: buildDisposeSource(binding.installId),
          timeout: GUEST_EVALUATE_TIMEOUT_MS,
        });
      }
    }
    binding.scriptIdentifier = null;
    // Released last: `Runtime.removeBinding` and the disposal evaluate above
    // both need the domain still enabled.
    const lease = binding.lease;
    binding.lease = null;
    await lease?.release().catch(() => undefined);

    this.deps.push({
      kind: "detached",
      sessionId: binding.sessionId,
      projectId: binding.projectId,
      reason,
    });
  }
}

/**
 * A sub-frame gets the binding too — CDP exposes it target-wide — so an
 * embedded third-party iframe can call it. Only the main frame's default world
 * is the page that was bound. Before the frame tree is known, a default-world
 * context is provisionally trusted: the alternative is dropping the guest's
 * whole first document.
 */
function isTrustedContext(binding: Binding, contextId: number): boolean {
  const lease = binding.lease;
  // No context knowledge at all — nothing has announced a context since the
  // domain came on. Degrade to the unfiltered behaviour rather than dropping
  // every observation: this check is defence in depth, not the load-bearing
  // boundary. A sub-frame that forges a call still has to match the session,
  // epoch and sequence, and the worst it achieves is desynchronising the
  // inspector for its own page.
  if (!lease || lease.contexts.size === 0) return true;
  if (!lease.contexts.has(contextId)) return false;
  // With the frame tree unread (`Page.getFrameTree` failed), a default world is
  // the best signal available; with it read, the main frame's world is the only
  // one that counts.
  if (!lease.mainFrameId) return true;
  return lease.contexts.get(contextId) === lease.mainFrameId;
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
  };
}

let instance: SitePreviewBridge | null = null;

export function getSitePreviewBridge(
  deps?: Partial<SitePreviewBridgeDeps> & Pick<SitePreviewBridgeDeps, "push">
): SitePreviewBridge {
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
