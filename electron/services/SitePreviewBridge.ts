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
  buildClearHoverSource,
  buildClearSelectionSource,
  buildReselectSource,
} from "./sitePreview/guestRuntime.js";
import {
  loadGuestAdapterSource,
  resolveGuestAdapter,
  type GuestAdapter,
} from "./sitePreview/guestAdapters.js";
import {
  DEFAULT_GUEST_ORIGIN_POLICY,
  originPolicyAllows,
  type GuestOriginPolicy,
} from "./sitePreview/originPolicy.js";
import { onWebContentsDestroyed } from "../window/webContentsDestroyed.js";
import type { CoreGuestAssetLoader } from "./elementPicker/guestAssets.js";
import type { CoreGuest } from "./elementPicker/coreGuest.js";
import type { ElementPickerPushPayload, ElementPickerSink } from "./elementPicker/types.js";

const DEV_PREVIEW_PANEL_KIND = "dev-preview";

/** Names a core picker binding wherever a plugin binding names its adapter, as in drop logs. */
export const ELEMENT_PICKER_GUEST_ID = "daintree.element-picker";

/** Kinds only a core picker binding emits; the plugin push channel never sees them. */
const CORE_ONLY_KINDS: ReadonlySet<string> = new Set([
  "picker-event",
  "frameworks-probed",
  "extractor-installed",
  "host-issue",
]);

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

/**
 * Where one binding's traffic goes. A guest observation carries the structure
 * of the user's page, what they selected in it and the source locations behind
 * that, so it is addressed to the view that asked for it rather than offered to
 * every view of the project: a second window on the same project, or any other
 * plugin view sharing that renderer realm, has no part in the binding.
 */
export interface SitePreviewPushRoute {
  /** The `WebContents` the bind call came from. */
  subscriberWebContentsId: number;
}

export interface SitePreviewBridgeDeps {
  /** Every live dev-preview guest, with the project that embeds it. */
  listGuests: () => GuestDescriptor[];
  getWebContents: (webContentsId: number) => Electron.WebContents | null;
  resolveWebContentsId: (panelId: string) => number | undefined;
  getPanelKind: (webContentsId: number) => string | undefined;
  /** The project that owns the view embedding this guest, resolved host-side. */
  resolveGuestProject: (wc: Electron.WebContents) => string | null;
  /**
   * Deliver one observation. The route is the host's, not the payload's: it
   * names the single view the binding was established from, and the transport
   * must send there and nowhere else. It is a second argument rather than a
   * field so nothing about the addressing crosses the wire.
   */
  push: (payload: SitePreviewPushPayload, route: SitePreviewPushRoute) => void;
  newSessionId: () => string;
  newBindingName: () => string;
  /** The guest runtime registry. Injected so tests need no real asset on disk. */
  resolveGuestAdapter: (
    adapterId: string
  ) => Pick<GuestAdapter, "id" | "pluginId" | "origins"> | null;
  loadGuestAdapterSource: (adapterId: string) => Promise<string>;
  /**
   * Whether the plugin that owns an adapter is loaded right now.
   *
   * Registration is a startup fact and says nothing about lifecycle: every
   * shipped adapter is registered whether or not its plugin is enabled, so
   * without this the host would load and evaluate a disabled plugin's guest
   * body for any caller authorised to name the panel. The UI hiding the tool is
   * a different guarantee, made in a different process.
   *
   * `projectId` is the binding's project as this process keys it; for a view
   * bound to a remote host that names the host, whose plugins are the ones the
   * view uses.
   */
  isPluginEnabled: (pluginId: string, projectId: string) => Promise<boolean>;
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
  /** The guest adapter this binding names, and the plugin that owns it; no plugin for the core picker. */
  adapterId: string;
  pluginId: string | null;
  /** The adapter's body, resolved host-side at bind time; empty for the core picker. */
  runtimeSource: string;
  /**
   * The core picker's guest, for a binding made through `bindElementPicker`.
   * Null for a plugin adapter binding, which keeps the plugin protocol intact.
   */
  core: CoreGuest | null;
  /** Where a core binding's traffic goes instead of the plugin push channel. */
  sink: ElementPickerSink | null;
  /** Where the adapter may run; checked against the guest's URL on every install. */
  origins: GuestOriginPolicy;
  /**
   * True while the guest shows a document outside `origins`. The binding stays
   * — the user's preview is still the same panel — but nothing is installed,
   * the CDP binding is removed, and guest traffic is ignored until a document
   * back inside the policy is installed.
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

  constructor(
    deps: Partial<SitePreviewBridgeDeps> & Pick<SitePreviewBridgeDeps, "push" | "isPluginEnabled">
  ) {
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
      loadCoreGuestAsset,
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
    /** The sender's WebContents; this binding's traffic goes there and nowhere else. */
    subscriberWebContentsId: number;
  }): Promise<SitePreviewBindingState> {
    return this.withPanelLock(input.panelId, () => this.bindLocked(input));
  }

  /** Per-plugin teardown counter; see {@link disposeForPlugin}. */
  private readonly disposeGenerations = new Map<string, number>();

  private async bindLocked(input: {
    projectId: string;
    panelId: string;
    adapterId: string;
    mode: SitePreviewMode;
    subscriberWebContentsId: number;
  }): Promise<SitePreviewBindingState> {
    const { projectId, panelId, adapterId, mode, subscriberWebContentsId } = input;

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

    const { webContentsId, wc } = this.resolveBindTarget(projectId, panelId);

    // Read before the first await that follows, so the comparison at the
    // commit point below is against what was true when this bind was allowed.
    const disposeGeneration = this.disposeGenerations.get(adapter.pluginId) ?? 0;

    // Asked before the body is read, so a disabled plugin's code is never even
    // loaded, let alone evaluated in the user's page.
    if (!(await this.deps.isPluginEnabled(adapter.pluginId, projectId))) {
      throw new AppError({
        code: "UNSUPPORTED",
        message: "The plugin that owns that site preview runtime is not enabled",
        context: { panelId, adapterId, pluginId: adapter.pluginId },
      });
    }

    // Loaded before anything is torn down: a failed read would otherwise leave
    // the panel with no binding at all.
    const runtimeSource = await this.deps.loadGuestAdapterSource(adapterId);
    // Asked again: the read above is an await, and a disable that landed under
    // it would otherwise be beaten by this bind.
    if (!(await this.deps.isPluginEnabled(adapter.pluginId, projectId))) {
      throw new AppError({
        code: "UNSUPPORTED",
        message: "The plugin that owns that site preview runtime is not enabled",
        context: { panelId, adapterId, pluginId: adapter.pluginId },
      });
    }
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

    // The commit point: everything above was awaited and could be stale, and
    // nothing below here awaits before the binding is in the map. A teardown
    // for this plugin that started at any point since this bind was allowed
    // means the bind was for a lifetime that has ended.
    if ((this.disposeGenerations.get(adapter.pluginId) ?? 0) !== disposeGeneration) {
      throw new AppError({
        code: "UNSUPPORTED",
        message: "The plugin that owns that site preview runtime is not enabled",
        context: { panelId, adapterId, pluginId: adapter.pluginId },
      });
    }

    const binding = this.newBinding({
      panelId,
      projectId,
      webContentsId,
      subscriberWebContentsId,
      adapterId,
      pluginId: adapter.pluginId,
      runtimeSource,
      origins: adapter.origins ?? DEFAULT_GUEST_ORIGIN_POLICY,
      mode,
      sink: null,
    });
    await this.commitBinding(binding, wc);
    return toState(binding);
  }

  /**
   * Bind the core Element Picker to a dev preview: an app-built bootstrap in
   * an isolated world, and per-framework extractors loaded only once the page
   * is seen to use their framework. No plugin is involved, so there is no
   * enablement to check.
   *
   * Main-process only until the dev preview panel subscribes to it (#13872):
   * traffic goes to `sink`, never to the plugin push channel. A panel holds one
   * binding either way — binding the core picker supersedes a plugin binding
   * on the same panel, exactly as a rebind does.
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

    const binding = this.newBinding({
      panelId,
      projectId,
      webContentsId,
      subscriberWebContentsId,
      adapterId: ELEMENT_PICKER_GUEST_ID,
      pluginId: null,
      runtimeSource: "",
      origins: DEFAULT_GUEST_ORIGIN_POLICY,
      mode,
      sink,
    });
    binding.core = new CoreGuest({
      sessionId: binding.sessionId,
      projectId,
      bindingName: binding.bindingName,
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
    });
    await this.commitBinding(binding, wc);
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
      | "panelId"
      | "projectId"
      | "webContentsId"
      | "subscriberWebContentsId"
      | "adapterId"
      | "pluginId"
      | "runtimeSource"
      | "origins"
      | "mode"
      | "sink"
    >
  ): Binding {
    return {
      ...init,
      sessionId: this.deps.newSessionId(),
      bindingName: this.deps.newBindingName(),
      core: null,
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
      scriptIdentifier: null,
      installId: 0,
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
    if (binding.core !== null) {
      await binding.core.setMode(mode);
      return toState(binding);
    }
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
    // The one op that carries data *into* the guest. A suspended binding is
    // showing a document the policy excluded, and these are worktree-relative
    // source paths: evaluating them there would hand a third-party page the
    // layout of the user's repository.
    if (binding.suspended) return false;
    // Source-location reselection is the plugin runtime's; the core picker
    // gains it with the framework extractors that know a location.
    if (binding.core !== null) return false;
    // `buildReselectSource` JSON-encodes every value, which is what keeps a
    // path from closing the literal it lands in. This bounds the shape as
    // well, so a caller that reaches the bridge without the IPC schema cannot
    // widen what gets embedded — an object with a `toJSON`, a non-finite
    // number, anything but a plain location.
    if (!isSourceLocation(loc)) return false;
    if (component !== null && !isSourceLocation(component)) return false;
    if (!Number.isSafeInteger(index) || index < 0) return false;
    if (occurrence !== null && !isPlainString(occurrence)) return false;
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
    // Nothing of ours is in a suspended binding's page, so this would only
    // poke whatever off-policy document is standing there.
    if (binding.suspended) return;
    if (binding.core !== null) {
      await binding.core.clearSelection();
      return;
    }
    const wc = this.deps.getWebContents(binding.webContentsId);
    if (!wc) return;
    await this.send(wc, "Runtime.evaluate", {
      expression: buildClearSelectionSource(),
      timeout: GUEST_EVALUATE_TIMEOUT_MS,
    });
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
    if (binding.core !== null) {
      await binding.core.clearHover();
      return;
    }
    const wc = this.deps.getWebContents(binding.webContentsId);
    if (!wc) return;
    await this.send(wc, "Runtime.evaluate", {
      expression: buildClearHoverSource(),
      timeout: GUEST_EVALUATE_TIMEOUT_MS,
    });
  }

  /**
   * Drop every binding a plugin's adapters back, because that plugin is no
   * longer loaded.
   *
   * The install-time check keeps a disabled plugin's runtime out of a *new*
   * document; this is what removes the one already in the page. Without it a
   * binding made while the plugin was enabled would keep reading the site and
   * pushing observations at a renderer whose plugin is gone, until the user
   * happened to navigate.
   */
  async disposeForPlugin(pluginId: string): Promise<void> {
    // Bumped synchronously, before the first await: `teardown` removes a
    // binding from the map before it awaits its CDP cleanup, so a bind sitting
    // on the predecessor's teardown would otherwise find an empty map here,
    // pass its own (already-read, now stale) enabled check, and install a
    // runtime that nothing is left to remove. A bind compares this counter
    // synchronously at the instant it commits; re-reading the boolean cannot
    // close the gap, because that read is itself an await.
    this.disposeGenerations.set(pluginId, (this.disposeGenerations.get(pluginId) ?? 0) + 1);
    for (const binding of [...this.bindings.values()]) {
      if (binding.pluginId !== pluginId) continue;
      await this.withPanelLock(binding.panelId, () => this.teardown(binding, "owner-disabled"));
    }
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
    const core = binding.core;
    const trusted =
      typeof contextId === "number" &&
      (core !== null ? core.isTrustedContext(contextId) : isTrustedContext(binding, contextId));
    if (!trusted) {
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

    if (core !== null) {
      this.handleCoreEnvelope(binding, core, payload);
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

    this.emit(binding, {
      kind: "guest-event",
      sessionId: binding.sessionId,
      panelId: binding.panelId,
      projectId: binding.projectId,
      documentEpoch: binding.documentEpoch,
      sequence: verdict.envelope.sequence,
      event: verdict.envelope.event,
    });
  }

  /**
   * A core picker envelope, admitted against the neutral contract. The plugin
   * validator would forward its events uninterpreted; here the host reads two
   * of them itself, because they decide what it injects next.
   */
  private handleCoreEnvelope(binding: Binding, core: CoreGuest, payload: string): void {
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
    if (event.type === DOCUMENT_READY) binding.guestReady = true;
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
   * The only way out of this class. Every push is addressed to the binding's
   * own subscriber, so a new event kind cannot reach a view that never bound:
   * what a guest observation carries — the page's structure, the user's
   * selection, source locations in their repository — belongs to the one view
   * that asked for it, not to every view of the project. A core picker
   * binding's traffic goes to its own sink instead, and the plugin channel
   * never carries a core-only kind.
   */
  private emit(binding: Binding, payload: SitePreviewPushPayload | ElementPickerPushPayload): void {
    if (binding.sink !== null) {
      if (payload.kind !== "guest-event") binding.sink(payload);
      return;
    }
    if (CORE_ONLY_KINDS.has(payload.kind)) return;
    this.deps.push(payload as SitePreviewPushPayload, {
      subscriberWebContentsId: binding.subscriberWebContentsId,
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
    // Before any await: an extractor install or probe still in flight was for
    // the document that just went, and must not land in this one.
    binding.core?.invalidate();

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
    // navigate anywhere, and the runtime goes only where the adapter said. It
    // is checked before the double-install guard below, because an install
    // that read its epoch under a navigation has satisfied that guard for a
    // document it never looked at.
    if (!originPolicyAllows(binding.origins, wc.getURL(), { initialDocument })) {
      await this.suspend(binding, wc);
      return;
    }
    // A navigation can queue a reinstall while the bind's own install is still
    // awaiting CDP; by the time both run they read the same epoch. Installing
    // twice for one epoch restarts the prelude's sequence at 0 and the host then
    // drops every message from the second runtime as a replay.
    if (
      binding.installedEpoch === binding.documentEpoch &&
      (binding.scriptIdentifier !== null || binding.core !== null)
    ) {
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

    if (binding.suspended) {
      // Cleared before the install, not after: the runtime reports
      // `documentReady` from inside the evaluate below, and a message arriving
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

    if (binding.core !== null) {
      await this.installCore(binding, binding.core);
      return;
    }

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
      // Travels with the script, because the script outlives the host's chance
      // to check: it runs in the next document before the navigation is seen.
      origins: binding.origins,
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

    // A navigation under the awaits above can have replaced the document with
    // one outside the policy. The reinstall it queued will remove the script
    // just registered; the evaluate is what would put the runtime into the
    // live document, and that is the one thing not to do.
    if (!originPolicyAllows(binding.origins, wc.getURL(), { initialDocument })) return;

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
      origins: binding.origins,
      frameId,
    });
    // Not installed means the document went under the install; the navigation
    // that replaced it queues its own, which this must not mark as done.
    if (!installed || binding.detached || this.closed) return;
    binding.installedEpoch = epoch;
    if (binding.mode !== installedMode) await core.setMode(binding.mode);
  }

  /**
   * Withhold the runtime from a document outside the adapter's origins. The
   * new-document script registered for the previous document has already run
   * in this one by the time the navigation is observed, so this is a removal,
   * not just a skipped install: the script goes, the CDP binding goes (which
   * is what closes the tap), and the runtime already in the page is told to
   * dispose itself, as on teardown. The binding itself survives, so a document
   * back inside the policy installs without the renderer rebinding.
   */
  private async suspend(binding: Binding, wc: Electron.WebContents): Promise<void> {
    // A second document outside the policy has nothing of ours in it: the
    // first suspension removed the script, so nothing ran there.
    if (binding.suspended) return;
    if (binding.scriptIdentifier) {
      await this.tryCdp(wc, "Page.removeScriptToEvaluateOnNewDocument", {
        identifier: binding.scriptIdentifier,
      });
      binding.scriptIdentifier = null;
    }
    binding.core?.invalidate();
    // Before the first install there is no lease, no binding and no runtime;
    // the CDP calls would only fail against a domain nothing enabled.
    if (binding.lease) {
      await this.tryCdp(wc, "Runtime.removeBinding", { name: binding.bindingName });
      await binding.core?.disposeInGuest();
      if (binding.installId > 0) {
        await this.tryCdp(wc, "Runtime.evaluate", {
          expression: buildDisposeSource(binding.installId),
          timeout: GUEST_EVALUATE_TIMEOUT_MS,
        });
      }
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
    binding.core?.invalidate();

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
      await binding.core?.disposeInGuest();
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

    this.emit(binding, {
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

export function getSitePreviewBridge(
  deps?: Partial<SitePreviewBridgeDeps> & Pick<SitePreviewBridgeDeps, "push" | "isPluginEnabled">
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

/**
 * The bridge if one exists, without creating it. For callers on a lifecycle
 * path — a plugin unloading — that must not bring the bridge into being just to
 * ask it to let go of something it was never holding.
 */
export function peekSitePreviewBridge(): SitePreviewBridge | null {
  return instance;
}

export function resetSitePreviewBridge(): void {
  instance = null;
}
