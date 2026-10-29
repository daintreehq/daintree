import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  SitePreviewBindingState,
  SitePreviewDetachReason,
  SitePreviewMode,
} from "@shared/types/ipc/sitePreview";
import {
  ELEMENT_PICKER_WORKSPACE_CLOSED,
  type ElementPickerBindRequest,
  type ElementPickerPushPayload,
  type ElementPickerReselectRequest,
  type ElementPickerSourceChangedPush,
  type ElementPickerSourceRevisionsResult,
  type ElementPickerWorkspaceOpenRequest,
  type ElementPickerWorkspaceOpenResult,
} from "@shared/types/ipc/elementPicker";
import type {
  ElementPickerEvent,
  ElementPickerProviderId,
  ProjectContextOutcome,
  ResolveRequest,
  ResolveResponse,
  SelectionObservation,
  SelectionScope,
} from "@shared/elementPicker";
import { RESOLVE_BUDGET_CEILINGS } from "@shared/elementPicker/resolver";
import type {
  DevPreviewToolSession,
  DevPreviewToolSessionContext,
} from "@/services/devPreviewTools/types";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import { cancelAgentRequests, watchPickerPreviews } from "./agentRequest.js";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { mismatchMessage, runtimeIssueMessage, wireFailureMessage } from "./copy.js";
import { usePanelStore } from "@/store/panelStore";
import { redactUrl } from "./pageText.js";
import {
  citedRevisions,
  displayLine,
  elementClaim,
  heldPaths,
  svelteEvidence,
  unionBounds,
  type ComponentSelectionMode,
  type ComponentTarget,
  type PageScreenshot,
  type PickedSelection,
  type SourcePoint,
  type Viewport,
} from "./selection.js";

/**
 * One controller per dev preview with the Element Picker switched on — the
 * host's tool session for that preview. It holds the preview binding, the
 * source workspace and the selection, and lives exactly as long as the host
 * keeps the picker on for the preview, surfaces or no surfaces.
 *
 * Every piece of preview state is keyed on the document epoch an observation
 * carries, never on arrival order: a reinstalled runtime's `documentReady` can
 * reach us before the `epoch-advanced` push for the same epoch.
 */

export interface ElementPickerApi {
  bind(request: ElementPickerBindRequest): Promise<SitePreviewBindingState>;
  reselect(request: ElementPickerReselectRequest): Promise<boolean>;
  openWorkspace(
    request: ElementPickerWorkspaceOpenRequest
  ): Promise<ElementPickerWorkspaceOpenResult>;
  closeWorkspace(request: { workspaceId: string }): Promise<{ closed: boolean }>;
  resolve(request: ResolveRequest): Promise<ResolveResponse>;
  describeProject(request: { workspaceId: string; url: string }): Promise<ProjectContextOutcome>;
  sourceRevisions(request: {
    workspaceId: string;
    paths: string[];
  }): Promise<ElementPickerSourceRevisionsResult>;
  onEvent(callback: (payload: ElementPickerPushPayload) => void): () => void;
  onSourceChanged(callback: (payload: ElementPickerSourceChangedPush) => void): () => void;
}

/** The site-preview bridge's binding lifecycle for the picker's bindings. */
export interface PreviewSessionApi {
  detach(request: { sessionId: string }): Promise<void>;
  setMode(request: { sessionId: string; mode: SitePreviewMode }): Promise<SitePreviewBindingState>;
  /** Drop the page's selection without observing anything. */
  clearSelection(request: { sessionId: string }): Promise<void>;
  clearHover(request: { sessionId: string }): Promise<void>;
}

export interface ElementCaptureApi {
  captureElement(
    panelId: string,
    request: {
      rect: { x: number; y: number; width: number; height: number };
      viewportWidth: number;
      viewportHeight: number;
    }
  ): Promise<
    | { status: "saved"; filePath: string; width: number; height: number }
    | { status: "offscreen" }
    | { status: "resized" }
  >;
}

export interface InspectorDeps {
  picker: ElementPickerApi;
  preview: PreviewSessionApi;
  now(): number;
  /** Takes the picture a selection carries; absent where the host offers none. */
  capture?: ElementCaptureApi;
  /** The window is attached to another machine, where a local picture's path means nothing. */
  remoteWindow?: () => boolean;
}

export interface InspectorContext {
  projectId: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
}

export type BindingState =
  | { status: "idle" }
  | { status: "binding"; panelId: string }
  | {
      status: "bound";
      sessionId: string;
      panelId: string;
      url: string | null;
      /**
       * The preview shows a document outside the picker's origins, so the
       * host withheld the runtime. Still bound: the next local document
       * installs on its own.
       */
      suspended: boolean;
    }
  | { status: "detached"; panelId: string; reason: SitePreviewDetachReason }
  /** `retrying`: an automatic attempt is scheduled; false once they have run out. */
  | { status: "failed"; message: string; retrying: boolean };

export type WorkspaceState =
  | { status: "idle" }
  | { status: "no-worktree" }
  | {
      status: "opening";
      /** The app the user just chose, when the opening is their choice. */
      appPath?: string;
      /** The candidates the choice was made from, kept on screen while it opens. */
      appPaths?: string[];
      serverCwd?: string | null;
    }
  | {
      status: "ready";
      workspaceId: string;
      /** The app reads are contained to, worktree-relative; `.` for the worktree itself. */
      appPath: string;
      /** Every app the worktree was found to hold. */
      appPaths: string[];
      scanComplete: boolean;
    }
  /** More than one app and nothing says which the preview serves: the user chooses. */
  | {
      status: "ambiguous";
      appPaths: string[];
      scanComplete: boolean;
      /** Where the preview's dev server runs, as the panel reports it; null when it doesn't. */
      serverCwd: string | null;
    }
  | { status: "failed"; reason: WorkspaceFailure; message: string };

/**
 * Why the source couldn't be opened, which decides the way forward: a read
 * error is retried, a remembered app that has gone is chosen again, and a
 * server running from another checkout can only be restarted from this one.
 */
export type WorkspaceFailure = "read-error" | "invalid-app" | "unknown-worktree" | "other-worktree";

export interface PageState {
  epoch: number;
  url: string;
  viewport: Viewport;
}

export type StaleReason = "document-changed" | "source-changed" | "preview-detached";

export type SelectionState =
  | { status: "none" }
  | { status: "resolving"; epoch: number; requestId: number }
  | {
      status: "ready";
      selection: PickedSelection;
      stale: StaleReason | null;
      /**
       * The page is being asked for this element again after a change, so the
       * stale reading is provisional: a surface holds its "select again" until
       * the answer is in.
       */
      reproving?: boolean;
      /**
       * The selections this one was proved again from, oldest first: the same
       * element on newer bytes, which a draft pinned to one of them follows.
       */
      supersedes?: string[];
    }
  /** The document moved on before the resolve finished. */
  | { status: "lost" }
  /**
   * A file the selection cites changed moments ago; the page may still show
   * the old markup. `retrying` while the click is being asked for again by itself.
   */
  | { status: "settling"; retrying?: boolean }
  | { status: "failed"; reason: SelectionFailure; message: string };

/**
 * Why a pick ended without a selection. A page still loading is routine
 * timing, not an error; a reported location the file contradicts has its own
 * way forward; anything else is the host failing, whose words are a diagnostic.
 */
export type SelectionFailure = "loading" | "mismatch" | "host";

/**
 * The last proven element, in the terms the page can be asked for it again:
 * by the id the page reported it under, while it is still that node, and by
 * the framework's locator, which a hot update cannot invalidate. Refreshed by
 * every proven resolution.
 */
interface Continuity {
  elementId: string;
  /**
   * The document `elementId` was minted in. The page mints ids afresh in every
   * new document, so after a reload the same id is some other element: it
   * names this one only while the epoch still matches.
   */
  epoch: number;
  /** Svelte's place for the element: the location it stamped, and which copy there. Null when it has none. */
  locator: { loc: SourcePoint; index: number } | null;
  /** The tag it was proved as, so an answer about a different element is refused. */
  tagName: string;
  /** How many copies shared its location, and what drew it, from where. */
  sameLocCount: number | null;
  chain: string;
}

/** What drew an element, from where, as one comparable value. */
function chainKey(observation: SelectionObservation): string {
  const evidence = svelteEvidence(observation);
  if (evidence) {
    return evidence.ancestry
      .map((frame) => `${frame.type}@${frame.file}:${frame.line}:${frame.column}`)
      .join(">");
  }
  return observation.componentChain.components
    .map((record) => {
      const site = record.sourceCandidates.find((entry) => entry.kind === "component-invocation");
      const at = site ? `${site.file}:${site.location.line}:${site.location.column}` : "";
      return `${record.name?.value ?? ""}@${at}`;
    })
    .join(">");
}

/** The call site the page reported for a component in an observation's chain. */
function invocationSite(
  observation: SelectionObservation,
  componentId: string
): SourcePoint | null {
  const record = observation.componentChain.components.find(
    (entry) => entry.componentId === componentId
  );
  const site = record?.sourceCandidates.find((entry) => entry.kind === "component-invocation");
  return site ? { file: site.file, line: site.location.line, column: site.location.column } : null;
}

/**
 * Svelte's own place for the element: where `__svelte_meta.loc` stamped it,
 * in the page's spelling, and which of the copies stamped there it is — the
 * terms the page finds it again by after a hot update replaced the node.
 */
function svelteLocator(observation: SelectionObservation): Continuity["locator"] {
  const evidence = svelteEvidence(observation);
  if (evidence?.locIndex === undefined) return null;
  const stamp = observation.sourceCandidates.find(
    (entry) => entry.framework === "svelte" && entry.kind === "template-location"
  );
  if (!stamp || stamp.kind !== "template-location" || stamp.location === null) return null;
  return {
    loc: { file: stamp.file, line: stamp.location.line, column: stamp.location.column },
    index: evidence.locIndex,
  };
}

/**
 * A selection the page is being asked for again after a hot update. An agent's
 * edit replaces the DOM nodes and changes the bytes the selection was proved
 * against, so every request used to end with "select again" — for the element
 * the user had just asked about. The identity is asked for once the page has
 * had time to catch up, and the answer is proved against the new bytes like
 * any pick.
 */
interface Reprove {
  record: Continuity;
  /** The component call site a component selection was widened to. */
  component: SourcePoint | null;
  /** A cited file changed, as opposed to the node simply leaving the page. */
  sourceChanged: boolean;
  /** The page reloaded under it: a failure is said as that, not as the element having gone. */
  reloaded: boolean;
  attempts: number;
  /** The page said it found it; its selection event is this reprove's answer. */
  awaiting: boolean;
}

/**
 * How far back a re-proved selection remembers what it replaced. A request can
 * sit in the queue through every edit the one ahead of it makes, and each of
 * those is a selection proved again; ids are short, and losing the thread
 * fails a request that did nothing wrong.
 */
const SUPERSEDES_KEPT = 64;

/**
 * Asks per change before the selection is left stale for the user to redo. One
 * a settle window: enough for a dev page to reload and hydrate, which is the
 * slow case.
 */
const REPROVE_ATTEMPTS = 6;

/**
 * The one thing the picker can do about an issue, recorded where the operation
 * is known rather than guessed at by the surface. Data, not a thunk: the state
 * stays comparable, the controller owns the operation and the notice owns the
 * words.
 */
export type IssueRecovery = { kind: "set-mode"; mode: SitePreviewMode } | { kind: "reconnect" };

export interface InspectorIssue {
  severity: "warning" | "error";
  message: string;
  /** The page's own verdict, when it came from the page. */
  code?: string;
  /** The framework the page's verdict is about, when it named one. */
  framework?: ElementPickerProviderId;
  /** What the verdict means for a request, in the product's words. */
  body?: string;
  /**
   * The diagnostic behind the title. Separate, because a raw error message is
   * evidence, not a headline, and the notice needs a headline to put a
   * recovery action under.
   */
  detail?: string;
  /**
   * Present on every issue that has a way forward. An error must offer one —
   * a mode change replays its target, and a fault inside the page is repaired
   * by rebuilding the session that carries the inspector. Warnings describe a
   * limitation nothing here can lift, so they carry no recovery and are
   * dismissed instead.
   */
  recovery?: IssueRecovery;
}

/** How long an agent request waits for the project's route files before going without them. */
const PROJECT_CONTEXT_TIMEOUT_MS = 3_000;
/** How long a selection's picture may take before the request goes without it. */
const CAPTURE_TIMEOUT_MS = 5_000;
/** Pictures kept for the selections a draft may still be about. */
const CAPTURES_KEPT = 16;
/**
 * Tells one picker session's selections from the next one's. A draft outlives
 * the session it was pinned in, and a count that starts again would give the
 * first element picked after reopening the id of the element it is about.
 */
let nextGeneration = 0;

/** Keep the newest of a per-selection record, dropping the oldest past the bound. */
function keepRecent<T>(records: Map<string, T>, selectionId: string, record: T): void {
  records.set(selectionId, record);
  while (records.size > CAPTURES_KEPT) {
    const oldest = records.keys().next();
    if (oldest.done === true) break;
    records.delete(oldest.value);
  }
}

/** Page verdicts that a traced element of the same framework disproves. */
const TRACING_ISSUES = new Set(["not-dev-build", "metadata-unavailable", "extractor-failed"]);

export interface InspectorState {
  binding: BindingState;
  mode: SitePreviewMode;
  modePending: boolean;
  /** Highest document epoch observed for the bound session. */
  epoch: number | null;
  page: PageState | null;
  workspace: WorkspaceState;
  /** What the app's layout says about the page, once the workspace has read it. */
  project: ProjectContextOutcome | null;
  selection: SelectionState;
  issue: InspectorIssue | null;
  /** Advances on every new selection, so a surface can start clean on one. */
  selectionGeneration: number;
}

export const INITIAL_INSPECTOR_STATE: InspectorState = {
  binding: { status: "idle" },
  // Turning the picker on is asking to pick something.
  mode: "select",
  modePending: false,
  epoch: null,
  page: null,
  workspace: { status: "idle" },
  project: null,
  selection: { status: "none" },
  issue: null,
  selectionGeneration: 0,
};

const MAX_BUFFERED_EVENTS = 64;

/** Detaches the host causes on its own, as opposed to the user or another inspector. */
const REATTACH_REASONS: ReadonlySet<SitePreviewDetachReason> = new Set([
  "guest-destroyed",
  "debugger-detached",
]);
const REATTACH_DELAY_MS = 300;
/** About two minutes in all: long enough for a cold dev server to serve its first page. */
const CONNECT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];
const CONNECT_RETRY_PAGE_READY_MAX_MS = 2000;

/** What one resolve may spend: the host's own ceilings, which are what a selection needs. */
const RESOLVE_BUDGET = {
  maxFiles: RESOLVE_BUDGET_CEILINGS.maxFiles,
  maxFileBytes: RESOLVE_BUDGET_CEILINGS.maxFileBytes,
  maxNetworkRequests: RESOLVE_BUDGET_CEILINGS.maxNetworkRequests,
  maxNetworkBytes: RESOLVE_BUDGET_CEILINGS.maxNetworkBytes,
  deadlineMs: RESOLVE_BUDGET_CEILINGS.deadlineMs,
};

/**
 * The host services for the picker of one dev preview. Source changes arrive
 * for every workspace this view holds open; the controller keeps only its own.
 */
export function defaultInspectorDeps(): InspectorDeps {
  return {
    picker: window.electron.elementPicker,
    preview: window.electron.sitePreview,
    now: () => Date.now(),
    capture: window.electron.webview,
    remoteWindow: isRemoteWindow,
  };
}

function isWithin(root: string, path: string): boolean {
  const base = trimSlash(root);
  const target = trimSlash(path);
  return target === base || target.startsWith(`${base}/`);
}

/** The directory a panel's process runs from, when the panel says. */
function panelCwd(panel: unknown): string | null {
  if (typeof panel !== "object" || panel === null || !("cwd" in panel)) return null;
  return typeof panel.cwd === "string" && panel.cwd.length > 0 ? panel.cwd : null;
}

/** The preview's origin, which source maps may be fetched from; null for anything but a plain HTTP(S) page. */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The host reports a workspace it no longer holds for this view — released,
 * evicted, or never this view's — as a `NOT_FOUND` naming the closed workspace.
 */
export function isWorkspaceClosed(error: unknown): boolean {
  if (!isClientAppError(error) || error.code !== "NOT_FOUND") return false;
  return clientErrorText(error, "").includes(ELEMENT_PICKER_WORKSPACE_CLOSED);
}

function trimSlash(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** How long after a source change a click may still land on the pre-HMR DOM. */
export const HMR_SETTLE_MS = 1000;

/** A selection made while the workspace was opening: resolved once it is open, if its document still stands. */
interface HeldSelection {
  request: number;
  epoch: number;
  observations: SelectionObservation[];
  scope: SelectionScope;
  /** Taken at the click: by the time the workspace opens the page may have moved. */
  picture: Promise<PageScreenshot>;
}

export class InspectorController implements DevPreviewToolSession {
  readonly panelId: string;
  private state: InspectorState = INITIAL_INSPECTOR_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private context: InspectorContext = { projectId: null, worktreeId: null, worktreePath: null };
  // Undefined until the first context arrives: a preview that starts with no
  // worktree has a null key, and must still be told so.
  private workspaceKey: string | null | undefined = undefined;
  private workspaceRequest = 0;
  private projectRequest = 0;
  private bindRequest = 0;
  /** The host's last word on whether the preview is showing a page, and which. */
  private pageReady = false;
  private pageUrl = "";
  private reattachTimer: ReturnType<typeof setTimeout> | null = null;
  private connectRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAttempts = 0;
  private selectionRequest = 0;
  private reprove: Reprove | null = null;
  private pointerLeft: (() => void) | null = null;
  private reproveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The reprove resolve that is out, while the state stays on the selection it is about. */
  private quietResolve: number | null = null;
  private bufferedEvents: ElementPickerPushPayload[] = [];
  /** Files the host reported changed while the current resolve was in flight. */
  private readonly changedDuringResolve = new Set<string>();
  /** Worktree-relative file → when it last changed, for the HMR settle window. */
  private readonly recentChanges = new Map<string, number>();
  private chosenAppPath: string | undefined;
  private recoveringWorkspace: string | null = null;
  private held: HeldSelection | null = null;
  private disposed = false;
  /** Kept apart from the rest: a closed picker still hears edits while its requests are out. */
  private offSourceChanged: (() => void) | null = null;
  private selectionCount = 0;
  private readonly generation = ++nextGeneration;
  /** Requests this controller made that are still on their way: a closed picker waits for them. */
  private pendingRequests = 0;
  private lingering: string | null = null;
  /** The last proven element, for asking the page for it again. */
  private continuity: Continuity | null = null;
  /** Each selection's picture, taken when it was made: oldest first, bounded. */
  private readonly captures = new Map<string, Promise<PageScreenshot>>();

  constructor(
    panelId: string,
    private readonly deps: InspectorDeps
  ) {
    this.panelId = panelId;
    watchPickerPreviews();
    this.unsubscribers.push(deps.picker.onEvent((payload) => this.handlePreviewPush(payload)));
    this.offSourceChanged = deps.picker.onSourceChanged((payload) =>
      this.handleSourceChanged(payload)
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): InspectorState => this.state;

  private patchState(patch: Partial<InspectorState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /* ------------------------------------------------------------------------ */
  /* Context and workspace                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * {@link DevPreviewToolSession}: the host says what this preview is showing,
   * for as long as the picker is switched on for it — including while none of
   * the picker's surfaces are mounted, which is when a bind that failed for
   * want of a page gets its retry.
   */
  update(context: DevPreviewToolSessionContext): void {
    const pageReady = context.isWebviewReady && context.url.length > 0;
    if (context.url.length > 0) this.pageUrl = context.url;
    this.updateContext({
      projectId: context.projectId,
      worktreeId: context.worktreeId,
      worktreePath: context.worktreePath,
    });
    // The page arriving is a new round whatever the binding is doing: a bind
    // already in flight when it arrives would otherwise fail into a budget
    // the wait for the server had spent, and stop trying beside a live page.
    if (pageReady && !this.pageReady) this.connectAttempts = 0;
    this.pageReady = pageReady;
    if (pageReady && this.state.binding.status === "failed") {
      // A fresh round, not the next step of the old one: the failures so far
      // were a preview with no page, and a bind that now loses a race with the
      // page registering itself would otherwise wait out a backoff grown for
      // a cold dev server — up to a minute of "waiting" beside a loaded page.
      void this.retryConnect();
    }
  }

  updateContext(context: InspectorContext): void {
    const worktreeChanged = context.worktreeId !== this.context.worktreeId;
    this.context = context;
    const binding = this.state.binding;
    if (binding.status === "idle") {
      void this.connect();
    } else if (worktreeChanged) {
      // A preview belongs to a worktree. Observations from the old one must
      // never resolve against the new worktree's source.
      if (binding.status === "bound") {
        void this.deps.preview.detach({ sessionId: binding.sessionId }).catch(() => undefined);
      }
      // A request still waiting on an agent was about the old worktree's source.
      cancelAgentRequests(this.panelId);
      void this.connect();
    }
    // The origin is part of what a workspace is: source maps are fetched from
    // it and nowhere else, so another server is another workspace.
    const origin = originOf(this.pageUrl) ?? "";
    const key =
      context.projectId && context.worktreeId && context.worktreePath
        ? `${context.projectId}\n${context.worktreeId}\n${context.worktreePath}\n${origin}`
        : null;
    if (key === this.workspaceKey) {
      if (key !== null && this.state.workspace.status === "idle") void this.openWorkspace();
      return;
    }
    // Only a server change keeps the app the user chose.
    const sameWorktree =
      key !== null &&
      typeof this.workspaceKey === "string" &&
      key.slice(0, key.lastIndexOf("\n")) ===
        this.workspaceKey.slice(0, this.workspaceKey.lastIndexOf("\n"));
    if (!sameWorktree) this.chosenAppPath = undefined;
    this.closeWorkspace();
    this.workspaceKey = key;
    if (key === null) {
      this.patchState({ workspace: { status: "no-worktree" } });
      this.releaseHeld();
      return;
    }
    void this.openWorkspace();
  }

  async openWorkspace(
    appPath: string | undefined = this.chosenAppPath,
    /** The candidates a choice was made from, when the workspace that listed them is already gone. */
    candidates?: string[]
  ): Promise<void> {
    this.chosenAppPath = appPath;
    const { projectId, worktreeId, worktreePath } = this.context;
    if (!projectId || !worktreeId || !worktreePath) return;
    const request = ++this.workspaceRequest;
    // A preview moved between worktrees keeps running its server from the old
    // one: the page would show one checkout while the agent works in another.
    const cwd = panelCwd(usePanelStore.getState().panelsById[this.panelId]);
    if (cwd !== null && !isWithin(worktreePath, cwd)) {
      this.patchState({
        workspace: { status: "failed", reason: "other-worktree", message: cwd },
      });
      this.releaseHeld();
      return;
    }
    // The candidates stay on screen while the choice opens: the list the user
    // chose from is where their focus is, and the drawer must not blink shut.
    const before = this.state.workspace;
    const listed =
      candidates ??
      (before.status === "ambiguous" || before.status === "ready" ? before.appPaths : undefined);
    this.patchState({
      workspace: {
        status: "opening",
        ...(appPath !== undefined && listed ? { appPath, appPaths: listed, serverCwd: cwd } : {}),
      },
      project: null,
    });
    // A window attached to another machine shows the page at this machine's
    // address, which on the machine holding the source names something else:
    // that workspace fetches no maps rather than the wrong ones.
    const origin = this.deps.remoteWindow?.() === true ? null : originOf(this.pageUrl);
    let result: ElementPickerWorkspaceOpenResult;
    try {
      result = await this.deps.picker.openWorkspace({
        panelId: this.panelId,
        worktreeId,
        ...(cwd !== null ? { serverCwd: cwd } : {}),
        ...(appPath !== undefined ? { appPath } : {}),
        ...(origin !== null ? { previewOrigin: origin } : {}),
      });
    } catch (error) {
      if (request !== this.workspaceRequest) return;
      this.patchState({
        workspace: {
          status: "failed",
          reason: "read-error",
          message: wireFailureMessage(error, "Couldn't open the source"),
        },
      });
      this.releaseHeld();
      return;
    }
    if (request !== this.workspaceRequest || this.disposed) {
      if (result.status === "ready") this.releaseWorkspace(result.workspaceId);
      return;
    }
    switch (result.status) {
      case "ready":
        this.patchState({
          workspace: {
            status: "ready",
            workspaceId: result.workspaceId,
            appPath: result.appPath,
            appPaths: result.appPaths,
            scanComplete: result.scanComplete,
          },
        });
        void this.refreshProject();
        this.resumeHeld();
        return;
      case "ambiguous":
        this.patchState({
          workspace: {
            status: "ambiguous",
            appPaths: result.appPaths,
            scanComplete: result.scanComplete,
            serverCwd: cwd,
          },
        });
        this.releaseHeld();
        return;
      case "unavailable":
        this.patchState({
          workspace: {
            status: "failed",
            reason: result.reason,
            message: appPath ?? "",
          },
        });
        this.releaseHeld();
        return;
    }
  }

  private releaseWorkspace(workspaceId: string): void {
    void this.deps.picker.closeWorkspace({ workspaceId }).catch(() => undefined);
  }

  /** Forget the remembered app and ask the host for the candidates again. */
  chooseAnotherApp(): void {
    // Cleared here, not passed: `openWorkspace(undefined)` takes the default,
    // which is the very choice that has gone.
    this.chosenAppPath = undefined;
    this.closeWorkspace();
    void this.openWorkspace();
  }

  /**
   * Point the picker at another app in the same worktree. The selection was
   * proven against the old one, so it belongs to it and goes.
   */
  switchApp(appPath: string): void {
    const workspace = this.state.workspace;
    if (workspace.status === "ready" && workspace.appPath === appPath) return;
    // A request on its way cites the old app's files; it must not land after the switch.
    cancelAgentRequests(this.panelId);
    // So does a click still waiting for the old app's source: it is not the
    // other app's to resolve.
    if (this.held !== null) {
      this.held = null;
      this.selectionRequest++;
    }
    // The candidates go with the workspace being released; the switch keeps
    // them on screen while the new app opens, as a first choice does.
    const candidates = workspace.status === "ready" ? workspace.appPaths : undefined;
    this.closeWorkspace();
    void this.openWorkspace(appPath, candidates);
  }

  private closeWorkspace(): void {
    this.workspaceRequest++;
    this.projectRequest++;
    this.continuity = null;
    this.endReprove();
    const workspace = this.state.workspace;
    if (workspace.status === "ready") this.releaseWorkspace(workspace.workspaceId);
    // Source identity belongs to the workspace that minted it. A click still
    // waiting for a workspace waits for the next one instead.
    const selection = this.state.selection;
    this.patchState({
      workspace: { status: "idle" },
      project: null,
      selection:
        this.held !== null ||
        selection.status === "none" ||
        (selection.status === "ready" && selection.selection.workspaceId === null)
          ? selection
          : { status: "none" },
    });
  }

  private currentWorkspaceId(): string | null {
    const workspace = this.state.workspace;
    return workspace.status === "ready" ? workspace.workspaceId : null;
  }

  /**
   * The host no longer holds our workspace, so the selection it proved is gone
   * too. Reopen once per lost workspace; a second failure is reported, not
   * looped on.
   */
  private recoverClosedWorkspace(workspaceId: string): void {
    if (this.disposed || this.currentWorkspaceId() !== workspaceId) return;
    if (this.recoveringWorkspace === workspaceId) return;
    this.recoveringWorkspace = workspaceId;
    this.selectionRequest++;
    this.endReprove();
    this.patchState({ workspace: { status: "idle" }, selection: { status: "none" } });
    void this.openWorkspace();
  }

  /**
   * What the app's layout says about the page the preview shows: its route
   * files and toolchain. Beside the selection, never on its path.
   */
  private async refreshProject(): Promise<void> {
    const workspaceId = this.currentWorkspaceId();
    const url = this.state.page?.url ?? this.pageUrl;
    if (workspaceId === null || url === "") return;
    const request = ++this.projectRequest;
    let outcome: ProjectContextOutcome;
    try {
      outcome = await this.deps.picker.describeProject({ workspaceId, url });
    } catch {
      return;
    }
    if (request !== this.projectRequest || this.currentWorkspaceId() !== workspaceId) return;
    this.patchState({ project: outcome });
  }

  /* ------------------------------------------------------------------------ */
  /* Preview binding                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Attach to the dev preview this controller lives in. Fails (and says so)
   * while the preview has no page yet; the host calls again once it does.
   */
  async connect(): Promise<void> {
    await this.bindTo(this.panelId);
  }

  async bindTo(previewPanelId: string): Promise<void> {
    const request = ++this.bindRequest;
    const previous = this.state.binding;
    if (previous.status === "bound" && previous.panelId !== previewPanelId) {
      void this.deps.preview.detach({ sessionId: previous.sessionId }).catch(() => undefined);
    }
    this.bufferedEvents = [];
    this.releaseHeld();
    this.patchState({
      binding: { status: "binding", panelId: previewPanelId },
      epoch: null,
      page: null,
      issue: null,
      ...this.staleSelectionPatch("preview-detached"),
    });

    // Always a fresh bind, never adoption of an existing session: its page
    // snapshot can't be replayed, and a session on the panel isn't proof it
    // was this controller's.
    let state: SitePreviewBindingState;
    try {
      state = await this.deps.picker.bind({ panelId: previewPanelId, mode: this.state.mode });
    } catch (error) {
      if (request !== this.bindRequest) return;
      this.bufferedEvents = [];
      // Most failures are a preview that has no page yet: it is starting, or
      // the grid is recreating it. Keep trying for a while rather than leaving
      // the user to guess when to press Retry.
      const retrying = this.scheduleConnectRetry(previewPanelId, request);
      this.patchState({
        binding: {
          status: "failed",
          message: clientErrorText(error, "Couldn't connect to the dev preview"),
          retrying,
        },
      });
      return;
    }
    this.connectAttempts = 0;
    if (request !== this.bindRequest || this.disposed) {
      // Superseded or disposed while binding: the session we just got is nobody's.
      void this.deps.preview.detach({ sessionId: state.sessionId }).catch(() => undefined);
      return;
    }

    // The page behind a selection that went stale on disconnect is gone; once
    // we're attached again it's an old warning about nothing on screen.
    const selection = this.state.selection;
    const clearedSelection =
      selection.status === "ready" && selection.stale === "preview-detached"
        ? { selection: { status: "none" } as const }
        : {};
    this.patchState({
      binding: {
        status: "bound",
        sessionId: state.sessionId,
        panelId: state.panelId,
        url: null,
        suspended: state.suspended,
      },
      mode: state.mode,
      epoch: null,
      ...clearedSelection,
    });
    this.noteEpoch(state.documentEpoch);
    // Pushes for this session can land before `bind` resolves.
    const buffered = this.bufferedEvents;
    this.bufferedEvents = [];
    for (const payload of buffered) this.handlePreviewPush(payload);
  }

  /**
   * The grid recreates a preview's page when panels are added or moved, and
   * that detaches the session exactly as a closed preview would. Reattach to
   * the same panel shortly after; if the page isn't back yet, the bind failure
   * hands over to the connection backoff, so there is one retry schedule, not
   * two cancelling each other. When DevTools really does own the page, every
   * attempt fails and the strip offers Retry.
   */
  private scheduleReattach(panelId: string): void {
    if (this.disposed) return;
    const request = this.bindRequest;
    this.clearReattach();
    this.connectAttempts = 0;
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = null;
      const binding = this.state.binding;
      if (this.disposed || request !== this.bindRequest) return;
      if (binding.status !== "detached" || binding.panelId !== panelId) return;
      void this.bindTo(panelId);
    }, REATTACH_DELAY_MS);
  }

  private scheduleConnectRetry(previewPanelId: string, request: number): boolean {
    if (this.disposed || this.connectAttempts >= CONNECT_RETRY_DELAYS_MS.length) return false;
    // The long steps wait for a dev server to serve its first page. Once the
    // host says a page is showing there is nothing left to wait that long for.
    const delay = Math.min(
      CONNECT_RETRY_DELAYS_MS[this.connectAttempts]!,
      this.pageReady ? CONNECT_RETRY_PAGE_READY_MAX_MS : Infinity
    );
    this.connectAttempts++;
    this.clearConnectRetry();
    this.connectRetryTimer = setTimeout(() => {
      this.connectRetryTimer = null;
      if (this.disposed || request !== this.bindRequest) return;
      if (this.state.binding.status !== "failed") return;
      void this.bindTo(previewPanelId);
    }, delay);
    return true;
  }

  private clearConnectRetry(): void {
    if (this.connectRetryTimer !== null) clearTimeout(this.connectRetryTimer);
    this.connectRetryTimer = null;
  }

  /** Try again now, starting a fresh round of automatic retries. */
  async retryConnect(): Promise<void> {
    this.connectAttempts = 0;
    this.clearConnectRetry();
    await this.connect();
  }

  private clearReattach(): void {
    if (this.reattachTimer !== null) clearTimeout(this.reattachTimer);
    this.reattachTimer = null;
  }

  async detach(): Promise<void> {
    const binding = this.state.binding;
    this.bindRequest++;
    // Superseding the request silences any retry waiting on it, so the state
    // must stop promising one.
    this.clearConnectRetry();
    if (binding.status === "failed" && binding.retrying) {
      this.patchState({ binding: { ...binding, retrying: false } });
    }
    if (binding.status !== "bound") return;
    this.releaseHeld();
    this.patchState({
      binding: { status: "detached", panelId: binding.panelId, reason: "requested" },
      ...this.staleSelectionPatch("preview-detached"),
    });
    await this.deps.preview.detach({ sessionId: binding.sessionId }).catch(() => undefined);
  }

  async setMode(mode: SitePreviewMode): Promise<void> {
    const binding = this.state.binding;
    if (binding.status !== "bound" || mode === this.state.mode) return;
    const previous = this.state.mode;
    this.patchState({ mode, modePending: true });
    try {
      const next = await this.deps.preview.setMode({ sessionId: binding.sessionId, mode });
      if (!this.isBoundTo(binding.sessionId)) return;
      this.noteEpoch(next.documentEpoch);
      this.patchState({ mode: next.mode, modePending: false });
      this.resumeReprove();
    } catch (error) {
      if (!this.isBoundTo(binding.sessionId)) return;
      this.patchState({
        mode: previous,
        modePending: false,
        issue: {
          severity: "error",
          // The error's own words belong in the body: used as the title they
          // put a raw diagnostic where the headline goes.
          message: "Couldn't switch the preview mode",
          detail: formatErrorMessage(error, "") || undefined,
          // The target, not the reverted current mode: retrying has to ask for
          // the switch that failed.
          recovery: { kind: "set-mode", mode },
        },
      });
      this.resumeReprove();
    }
  }

  private isBoundTo(sessionId: string): boolean {
    const binding = this.state.binding;
    return binding.status === "bound" && binding.sessionId === sessionId;
  }

  private handlePreviewPush(payload: ElementPickerPushPayload): void {
    const binding = this.state.binding;
    if (binding.status === "binding") {
      // Hover traffic is worthless after the fact; keep the newest of the
      // rest, since readiness and epoch pushes are what the replay needs most.
      if (payload.kind === "picker-event" && payload.event.type === "hoverChanged") return;
      this.bufferedEvents.push(payload);
      if (this.bufferedEvents.length > MAX_BUFFERED_EVENTS) this.bufferedEvents.shift();
      return;
    }
    if (binding.status !== "bound" || payload.sessionId !== binding.sessionId) return;

    switch (payload.kind) {
      case "detached":
        this.bindRequest++;
        this.releaseHeld();
        this.patchState({
          binding: { status: "detached", panelId: binding.panelId, reason: payload.reason },
          ...this.staleSelectionPatch("preview-detached"),
        });
        if (REATTACH_REASONS.has(payload.reason)) this.scheduleReattach(binding.panelId);
        return;
      case "epoch-advanced":
        this.noteEpoch(payload.documentEpoch);
        return;
      case "origin-policy":
        // A suspension always follows a navigation, and that epoch advance is
        // what retires the selection; nothing here is stale on its own.
        this.noteEpoch(payload.documentEpoch);
        if (binding.suspended !== payload.suspended) {
          this.patchState({ binding: { ...binding, suspended: payload.suspended } });
        }
        return;
      case "picker-event":
        this.handleGuestEvent(payload.documentEpoch, payload.event);
        return;
      case "host-issue":
        if (this.state.epoch !== null && payload.documentEpoch < this.state.epoch) return;
        this.raiseRuntimeIssue(payload.issue);
        return;
      case "frameworks-probed":
      case "extractor-installed":
        return;
    }
  }

  /**
   * Raise the known epoch. Only a strictly higher epoch invalidates anything,
   * which is what makes a late `epoch-advanced` for an epoch whose
   * `documentReady` already arrived a no-op.
   */
  private noteEpoch(epoch: number): void {
    const current = this.state.epoch;
    if (current !== null && epoch <= current) return;
    const patch: Partial<InspectorState> = { epoch };
    if (this.state.page && this.state.page.epoch < epoch) patch.page = null;
    if (this.held !== null && this.held.epoch < epoch) this.held = null;
    const selection = this.state.selection;
    if (
      selection.status === "ready" &&
      selection.selection.documentEpoch < epoch &&
      (selection.stale === null || this.reprove !== null)
    ) {
      // A reload is what an edit does as often as a hot update — a class the
      // stylesheet has never held reloads the page — so it is not the end of
      // the selection either. The new page is asked for the same element under
      // the same checks; only if it can't vouch for it does the selection say
      // the page reloaded.
      if (this.state.issue) patch.issue = null;
      this.patchState(patch);
      // An answer still being resolved is about the old document.
      this.selectionRequest++;
      this.quietResolve = null;
      if (!this.beginReprove(this.reprove?.sourceChanged ?? false, true)) {
        this.patchState(this.staleSelectionPatch("document-changed"));
      }
      return;
    }
    if (selection.status === "resolving" && selection.epoch < epoch) {
      patch.selection = { status: "lost" };
    }
    if (this.state.issue) patch.issue = null;
    this.patchState(patch);
  }

  private handleGuestEvent(epoch: number, event: ElementPickerEvent): void {
    // Epoch bookkeeping comes off the envelope, which the host validated.
    this.noteEpoch(epoch);
    if (this.state.epoch !== null && epoch < this.state.epoch) return;

    switch (event.type) {
      case "documentReady": {
        const previousUrl = this.state.page?.url ?? null;
        const patch: Partial<InspectorState> = {
          page: { epoch, url: event.url, viewport: event.viewport },
        };
        const binding = this.state.binding;
        if (binding.status === "bound") patch.binding = { ...binding, url: event.url };
        this.patchState(patch);
        // The route around the page changes with the page.
        if (previousUrl !== event.url) void this.refreshProject();
        return;
      }
      case "selectionChanged":
        this.clearDisprovedIssue(event.observations);
        void this.handleSelection(epoch, event.observations, event.scope, event.cause);
        return;
      case "runtimeIssue":
        this.raiseRuntimeIssue(event);
        return;
      case "hoverChanged":
        if (event.observation !== null) this.clearDisprovedIssue([event.observation]);
        this.watchPointerLeaving(event.observation !== null);
        return;
      case "frameworksDetected":
        return;
    }
  }

  private raiseRuntimeIssue(event: Extract<ElementPickerEvent, { type: "runtimeIssue" }>): void {
    const message = runtimeIssueMessage(event.code, event.framework, event.detail);
    this.patchState({
      issue: {
        severity: event.code === "internal" ? "error" : "warning",
        message: message?.title ?? event.detail,
        ...(message?.body ? { body: message.body } : {}),
        code: event.code,
        ...(event.framework ? { framework: event.framework } : {}),
        // The page's own words, under ours. A known code has a headline that
        // says what kind of thing happened; the detail is the only thing that
        // says which one.
        ...(message === null || event.detail === "" ? {} : { detail: event.detail }),
        // The other codes name a limitation of the page itself, which nothing
        // here can lift; an internal fault is the guest runtime failing, and a
        // fresh session is what replaces it.
        ...(event.code === "internal" ? { recovery: { kind: "reconnect" } as const } : {}),
      },
    });
  }

  /**
   * An element the page traced is proof of that framework's dev metadata,
   * whatever the page concluded earlier — a verdict reached while it was
   * still hydrating must not sit above a selection that plainly traced.
   */
  private clearDisprovedIssue(
    observations: ReadonlyArray<Pick<SelectionObservation, "sourceCandidates" | "componentChain">>
  ): void {
    const issue = this.state.issue;
    if (issue?.code === undefined || !TRACING_ISSUES.has(issue.code)) return;
    const traced = observations.some(
      (observation) =>
        observation.sourceCandidates.some(
          (candidate) => issue.framework === undefined || candidate.framework === issue.framework
        ) ||
        observation.componentChain.components.some(
          (record) => issue.framework === undefined || record.framework === issue.framework
        )
    );
    if (traced) this.patchState({ issue: null });
  }

  /* ------------------------------------------------------------------------ */
  /* Selection                                                                */
  /* ------------------------------------------------------------------------ */

  private nextSelection(
    epoch: number,
    page: PageState,
    observations: SelectionObservation[],
    scope: SelectionScope,
    workspace: { workspaceId: string; appPath: string } | null,
    results: PickedSelection["results"]
  ): PickedSelection {
    const binding = this.state.binding;
    this.selectionCount += 1;
    return {
      selectionId: `${this.panelId}:${this.generation}:${epoch}:${this.selectionCount}`,
      previewPanelId: this.panelId,
      sessionId: binding.status === "bound" ? binding.sessionId : "",
      documentEpoch: epoch,
      workspaceId: workspace?.workspaceId ?? null,
      appPath: workspace?.appPath ?? null,
      displayedUrl: redactUrl(page.url),
      viewport: page.viewport,
      observations,
      results,
      scope,
      capturedAt: new Date(this.deps.now()).toISOString(),
    };
  }

  private async handleSelection(
    epoch: number,
    observations: SelectionObservation[],
    scope: SelectionScope,
    cause: "user" | "document" | "reselect",
    taken?: Promise<PageScreenshot>
  ): Promise<void> {
    const request = ++this.selectionRequest;
    this.held = null;
    this.quietResolve = null;
    this.changedDuringResolve.clear();
    // The page's answer to a reprove. It resolves behind the selection it is
    // about, which stays on screen; only a proven answer replaces it. Only an
    // answer that was asked for counts: a crumb pick answers through the same
    // event, and must resolve as the user's choice it is.
    const pending = cause === "reselect" && this.reprove?.awaiting ? this.reprove : null;
    const reproving = pending !== null;
    if (pending !== null) pending.awaiting = false;
    if (observations.length === 0) {
      // A node the page was showing left the document. After a hot update that
      // is the same element drawn again, so it is asked for before it is
      // given up.
      if (cause === "document" && this.beginReprove(false)) return;
      // A click being held for the page to catch up named a node the update
      // has now replaced; that is the update it was waiting for.
      const settling = this.state.selection;
      if (
        cause === "document" &&
        settling.status === "settling" &&
        settling.retrying &&
        this.reprove
      ) {
        this.scheduleReprove();
        return;
      }
      // The user cleared it (Escape), or there is nothing to ask for.
      this.endReprove();
      this.continuity = null;
      this.patchState({ selection: { status: "none" } });
      return;
    }
    // A pick of the user's own outranks one being asked for on their behalf.
    if (!reproving) this.endReprove();
    const primary = observations[0]!;
    /** Where a pick that can't be proved ends: said, or for a reprove, retried. */
    const refuse = (next: SelectionState, retry: boolean): void => {
      if (!reproving) {
        this.patchState({ selection: next });
        return;
      }
      this.quietResolve = null;
      if (retry) this.scheduleReprove();
      else this.failReprove();
    };
    /**
     * The page hasn't caught up with a change to a file. The click is kept
     * and asked for again once it has, rather than handed back to the user.
     */
    const settle = (): void => {
      if (reproving) {
        refuse({ status: "settling" }, true);
        return;
      }
      // Asked for again by its id in this document, or by Svelte's locator
      // once a reload has replaced it.
      const record = this.continuityOf(primary, epoch);
      const retrying =
        (observations.length === 1 || scope.kind === "component") &&
        this.startReprove({
          record,
          component: scope.kind === "component" ? invocationSite(primary, scope.componentId) : null,
          sourceChanged: true,
          reloaded: false,
          attempts: 0,
          awaiting: false,
        });
      this.patchState({ selection: { status: "settling", retrying } });
    };
    if (pending !== null && !this.answersReprove(pending, primary, scope, epoch)) {
      // Something else now sits where the element was written, or the page
      // can no longer tell. A selection is not re-pointed at what took its
      // place, and the page stops outlining the stand-in.
      this.failReprove(true);
      return;
    }
    const page = this.state.page;
    const binding = this.state.binding;
    if (binding.status !== "bound") return;
    if (!page || page.epoch !== epoch) {
      refuse({ status: "failed", reason: "loading", message: "" }, true);
      return;
    }

    const workspace = this.state.workspace;
    // What a selection is about is decided per selection: a click with nothing
    // the page could trace is the page's account of the element, whichever
    // app the worktree holds, and asking the host would name that app's files
    // for an element it never drew.
    const traced = observations.some(
      (observation) =>
        observation.sourceCandidates.length > 0 || observation.componentChain.components.length > 0
    );
    // The picture first: publishing the selection opens the drawer, which
    // takes its width from the page and moves the element out of the box just
    // measured.
    const picture = taken ?? this.takePicture(binding.panelId, page.viewport, observations);
    if (traced && workspace.status === "opening" && !reproving) {
      this.held = { request, epoch, observations, scope, picture };
      this.patchState({ selection: { status: "resolving", epoch, requestId: request } });
      return;
    }
    if (!traced || workspace.status !== "ready") {
      if (reproving) {
        refuse({ status: "lost" }, false);
        return;
      }
      const selection = this.nextSelection(epoch, page, observations, scope, null, {});
      this.keepPicture(selection.selectionId, picture);
      this.publish(selection, null);
      return;
    }

    if (reproving) this.quietResolve = request;
    else this.patchState({ selection: { status: "resolving", epoch, requestId: request } });
    await this.resolveSelection(request, epoch, page, observations, scope, workspace, picture, {
      reproving,
      refuse,
      settle,
    });
  }

  private async resolveSelection(
    request: number,
    epoch: number,
    page: PageState,
    observations: SelectionObservation[],
    scope: SelectionScope,
    workspace: Extract<WorkspaceState, { status: "ready" }>,
    picture: Promise<PageScreenshot>,
    outcome: {
      reproving: boolean;
      refuse: (next: SelectionState, retry: boolean) => void;
      settle: () => void;
    }
  ): Promise<void> {
    const { reproving, refuse, settle } = outcome;
    const binding = this.state.binding;
    if (binding.status !== "bound") return;
    let response: ResolveResponse;
    try {
      response = await this.deps.picker.resolve({
        requestId: `${binding.sessionId}:${request}`,
        sessionId: binding.sessionId,
        documentEpoch: epoch,
        workspaceId: workspace.workspaceId,
        // The host traces source; what the page says the element looks like is
        // the renderer's to quote, and has no business in that payload.
        observations: observations.map(({ context: _context, ...observation }) => observation),
        knownRevisions: [],
        budget: RESOLVE_BUDGET,
      });
    } catch (error) {
      if (!this.isCurrentResolve(request, reproving)) return;
      if (isWorkspaceClosed(error)) {
        this.endReprove();
        this.recoverClosedWorkspace(workspace.workspaceId);
        return;
      }
      refuse(
        {
          status: "failed",
          reason: "host",
          message: clientErrorText(error, "Couldn't find the source for this element"),
        },
        false
      );
      return;
    }
    if (!this.isCurrentResolve(request, reproving)) return;
    if (
      response.documentEpoch !== epoch ||
      this.state.epoch !== epoch ||
      this.currentWorkspaceId() !== workspace.workspaceId
    ) {
      refuse({ status: "lost" }, true);
      return;
    }
    const results: Record<string, PickedSelection["results"][string]> = {};
    for (const entry of response.outcomes) results[entry.elementId] = entry.results;
    const selection = this.nextSelection(
      epoch,
      page,
      observations,
      scope,
      { workspaceId: workspace.workspaceId, appPath: workspace.appPath },
      results
    );
    const primary = observations[0]!;
    const claim = elementClaim(selection, primary);
    const changed = (path: string) =>
      this.changedDuringResolve.has(path) || this.changedRecently(path);
    if (claim?.result?.state === "stale") {
      // The host read newer bytes than the page is showing; give it a moment.
      if (changed(claim.result.held.target.file.path)) settle();
      else refuse({ status: "lost" }, true);
      return;
    }
    if (claim?.result?.state === "unavailable" && claim.result.reason === "mismatch") {
      // The page's location for the element and the file disagree. When the
      // file is known to have just changed, that is the page still catching
      // up; otherwise nothing moved, "select again" would be the same click
      // for the same answer, and the notice says what was seen instead.
      const read = claim.result.read?.file.path;
      if (read !== undefined && changed(read)) {
        settle();
        return;
      }
      const at = claim.candidate.kind === "file-hint" ? null : claim.candidate.location;
      refuse(
        {
          status: "failed",
          reason: "mismatch",
          message: mismatchMessage({
            tagName: primary.tagName,
            file: claim.candidate.file,
            line: at === null ? 0 : displayLine(at),
          }),
        },
        false
      );
      return;
    }
    // The observation predates the change, but the host resolved it against
    // the newer bytes; the pairing can't be trusted, so it is asked for again
    // once the page has caught up.
    if ([...heldPaths(selection)].some(changed)) {
      settle();
      return;
    }
    this.keepPicture(selection.selectionId, picture);
    this.publish(selection, reproving ? this.state.selection : null);
  }

  /** Put a proven selection on screen, superseding the one it was asked again for. */
  private publish(selection: PickedSelection, before: SelectionState | null): void {
    const supersedes =
      before?.status === "ready"
        ? [...(before.supersedes ?? []), before.selection.selectionId].slice(-SUPERSEDES_KEPT)
        : undefined;
    this.continuity = this.continuityOf(selection.observations[0]!, selection.documentEpoch);
    this.endReprove();
    this.patchState({
      selection: {
        status: "ready",
        selection,
        stale: null,
        ...(supersedes ? { supersedes } : {}),
      },
      selectionGeneration: this.state.selectionGeneration + 1,
    });
  }

  private continuityOf(observation: SelectionObservation, epoch: number): Continuity {
    return {
      elementId: observation.elementId,
      epoch,
      locator: svelteLocator(observation),
      tagName: observation.tagName,
      sameLocCount: svelteEvidence(observation)?.sameLocCount ?? null,
      chain: chainKey(observation),
    };
  }

  /** A selection made while the workspace opened, now that it has. */
  private resumeHeld(): void {
    const held = this.held;
    this.held = null;
    if (held === null || held.request !== this.selectionRequest) return;
    const selection = this.state.selection;
    if (selection.status !== "resolving" || selection.requestId !== held.request) return;
    if (this.state.epoch !== held.epoch) {
      this.patchState({ selection: { status: "lost" } });
      return;
    }
    void this.handleSelection(held.epoch, held.observations, held.scope, "user", held.picture);
  }

  /** The workspace did not open: a held selection is the page's account of the element after all. */
  private releaseHeld(): void {
    const held = this.held;
    this.held = null;
    if (held === null || held.request !== this.selectionRequest) return;
    const selection = this.state.selection;
    if (selection.status !== "resolving" || selection.requestId !== held.request) return;
    const page = this.state.page;
    const binding = this.state.binding;
    if (page === null || page.epoch !== held.epoch || binding.status !== "bound") {
      this.patchState({ selection: { status: "lost" } });
      return;
    }
    const next = this.nextSelection(held.epoch, page, held.observations, held.scope, null, {});
    this.keepPicture(next.selectionId, held.picture);
    this.publish(next, null);
  }

  /* ------------------------------------------------------------------------ */
  /* Proving a selection again                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Ask the page again for the ready selection, which a change has just put in
   * doubt. It is marked stale either way — a request must not cite it until it
   * is proved — but as provisional, so no surface asks the user to redo a click
   * the page may be able to answer itself. False when there is nothing to ask
   * for: no ready selection, or one the page could not find again.
   */
  private beginReprove(sourceChanged: boolean, reloaded = false): boolean {
    const selection = this.state.selection;
    const record = this.continuity;
    if (selection.status !== "ready" || record === null) return false;
    // A selection the preview dropped or the page reloaded past is not this
    // page's to answer for.
    if (selection.stale !== null && this.reprove === null) return false;
    // An untraced selection cites nothing that could have changed.
    if (selection.selection.workspaceId === null) return false;
    // The page is asked for one element, or one component's roots; a hand-built
    // set of several would come back as its first.
    if (
      selection.selection.observations.length > 1 &&
      selection.selection.scope.kind !== "component"
    ) {
      return false;
    }
    // After a reload only the framework's own locator can find it again.
    if (reloaded && record.locator === null) return false;
    const scope = selection.selection.scope;
    const primary = selection.selection.observations[0];
    const started = this.startReprove({
      record,
      component:
        scope.kind === "component" && primary ? invocationSite(primary, scope.componentId) : null,
      sourceChanged: sourceChanged || (this.reprove?.sourceChanged ?? false),
      reloaded: reloaded || (this.reprove?.reloaded ?? false),
      attempts: 0,
      awaiting: false,
    });
    if (!started) return false;
    this.patchState({
      selection: {
        ...selection,
        stale: reloaded
          ? "document-changed"
          : (selection.stale ?? (sourceChanged ? "source-changed" : "document-changed")),
        // In Browse the ask waits for the user, so the notice is theirs to see.
        reproving: this.state.mode === "select",
      },
    });
    return true;
  }

  /**
   * Whether the page's answer is the element that was proved. The same node
   * (its element id, in the same document) is; one found again by position
   * is only when nothing about its position's meaning moved — same tag, same
   * number of copies at that location, same chain — and a component selection
   * must come back as that component, not as the element it was reached
   * through. What this cannot see is a same-tag element written into the exact
   * line and column the original was pushed out of.
   */
  private answersReprove(
    reprove: Reprove,
    observation: SelectionObservation,
    scope: SelectionScope,
    epoch: number
  ): boolean {
    const wanted = reprove.component;
    if (wanted !== null) {
      if (scope.kind !== "component") return false;
      const site = invocationSite(observation, scope.componentId);
      if (
        site === null ||
        site.file !== wanted.file ||
        site.line !== wanted.line ||
        site.column !== wanted.column
      ) {
        return false;
      }
    } else if (scope.kind !== "element") {
      return false;
    }
    if (observation.tagName.toLowerCase() !== reprove.record.tagName.toLowerCase()) return false;
    // The same node, which only an id from the same document can say.
    if (epoch === reprove.record.epoch && observation.elementId === reprove.record.elementId) {
      return true;
    }
    const count = svelteEvidence(observation)?.sameLocCount ?? null;
    return (
      reprove.record.sameLocCount !== null &&
      count === reprove.record.sameLocCount &&
      chainKey(observation) === reprove.record.chain
    );
  }

  /** Mode has settled: an ask parked in Browse goes out, one in Select shows as waiting again. */
  private resumeReprove(): void {
    if (this.reprove === null) return;
    const selection = this.state.selection;
    const asking = this.state.mode === "select";
    if (selection.status === "ready" && selection.stale !== null) {
      this.patchState({ selection: { ...selection, reproving: asking } });
    }
    if (asking) this.scheduleReprove();
  }

  private startReprove(reprove: Reprove): boolean {
    if (this.disposed || this.state.binding.status !== "bound") return false;
    this.reprove = reprove;
    this.scheduleReprove();
    return true;
  }

  /** One settle window from now; every further change pushes it back. */
  private scheduleReprove(): void {
    if (this.reproveTimer !== null) clearTimeout(this.reproveTimer);
    this.reproveTimer = setTimeout(() => {
      this.reproveTimer = null;
      void this.attemptReprove();
    }, HMR_SETTLE_MS);
  }

  /** What the page is asked for an element by: its id while it is still that node, else its locator. */
  private reselectRequest(
    sessionId: string,
    record: Continuity,
    component: SourcePoint | null,
    reveal: boolean
  ): ElementPickerReselectRequest | null {
    const sameDocument = record.epoch === this.state.epoch;
    if (!sameDocument && record.locator === null) return null;
    return {
      sessionId,
      // Never an id from another document: there it is some other element.
      ...(sameDocument ? { elementId: record.elementId } : {}),
      ...(record.locator !== null
        ? {
            framework: "svelte" as const,
            locator: { ...record.locator, ...(component ? { component } : {}) },
          }
        : {}),
      ...(reveal ? { reveal: true } : {}),
    };
  }

  private async attemptReprove(): Promise<void> {
    const reprove = this.reprove;
    const binding = this.state.binding;
    if (this.disposed || reprove === null) return;
    if (binding.status !== "bound") {
      this.failReprove();
      return;
    }
    // The page answers only in Inspect mode; the ask waits for it to come back.
    if (this.state.mode !== "select" || this.state.modePending) return;
    // An answer is still being resolved: this firing is only its deadline.
    if (this.quietResolve !== null) {
      this.scheduleReprove();
      return;
    }
    if (reprove.attempts >= REPROVE_ATTEMPTS) {
      this.failReprove();
      return;
    }
    const request = this.reselectRequest(
      binding.sessionId,
      reprove.record,
      reprove.component,
      false
    );
    if (request === null) {
      this.failReprove();
      return;
    }
    reprove.attempts += 1;
    reprove.awaiting = true;
    let found: boolean;
    try {
      found = await this.deps.picker.reselect(request);
    } catch {
      found = false;
    }
    if (this.reprove !== reprove) return;
    if (!found) reprove.awaiting = false;
    // Found: the page reports it as a selection, which resolves as any pick
    // does — and if that report never arrives, this is its deadline. Not
    // found: the update may simply not have landed yet.
    if (this.reproveTimer === null) this.scheduleReprove();
  }

  /**
   * The page could not vouch for it: the selection stays stale, and now says
   * so. `standIn` when the page answered with some other element, which it is
   * then outlining.
   */
  private failReprove(standIn = false): void {
    const reprove = this.reprove;
    this.endReprove();
    if (reprove === null) return;
    const selection = this.state.selection;
    const binding = this.state.binding;
    if (standIn && binding.status === "bound") {
      void this.deps.preview
        .clearSelection({ sessionId: binding.sessionId })
        .catch(() => undefined);
    }
    if (selection.status === "settling") {
      this.patchState({ selection: { status: "settling" } });
      return;
    }
    if (selection.status !== "ready") return;
    if (!reprove.sourceChanged && !reprove.reloaded) {
      // Nothing was edited; the element just left the page.
      this.continuity = null;
      this.patchState({ selection: { status: "none" } });
      return;
    }
    this.patchState({ selection: { ...selection, reproving: false } });
  }

  /**
   * The page or the preview the ask was for is gone: a reload mints new
   * element ids, and a detached preview answers nothing.
   */
  private abandonReprove(): void {
    if (this.reprove === null) return;
    this.selectionRequest++;
    this.endReprove();
    const selection = this.state.selection;
    if (selection.status === "settling") this.patchState({ selection: { status: "settling" } });
  }

  /**
   * The page is not reliably told when the pointer crosses into the host — it
   * can get no leave, out or move at all — so its hover label stayed up over
   * the page for as long as the pointer was in the drawer. The host does know:
   * a pointer event in this document is a pointer that is not over the
   * preview. One listener while the page is hovering something, one call.
   */
  private watchPointerLeaving(hovering: boolean): void {
    if (typeof document === "undefined") return;
    if (!hovering || this.disposed) {
      if (this.pointerLeft !== null) {
        document.removeEventListener("pointermove", this.pointerLeft, true);
      }
      this.pointerLeft = null;
      return;
    }
    if (this.pointerLeft !== null) return;
    const left = (): void => {
      document.removeEventListener("pointermove", left, true);
      if (this.pointerLeft === left) this.pointerLeft = null;
      const binding = this.state.binding;
      if (binding.status !== "bound") return;
      void this.deps.preview.clearHover({ sessionId: binding.sessionId }).catch(() => undefined);
    };
    this.pointerLeft = left;
    document.addEventListener("pointermove", left, true);
  }

  private endReprove(): void {
    if (this.reproveTimer !== null) clearTimeout(this.reproveTimer);
    this.reproveTimer = null;
    this.reprove = null;
    this.quietResolve = null;
  }

  /** Drop the selection, here and on the page. */
  async clearSelection(): Promise<void> {
    this.selectionRequest++;
    this.held = null;
    this.endReprove();
    this.continuity = null;
    this.patchState({ selection: { status: "none" } });
    const binding = this.state.binding;
    if (binding.status !== "bound") return;
    await this.deps.preview.clearSelection({ sessionId: binding.sessionId }).catch(() => undefined);
  }

  /**
   * The workspace a selection's files can be read through now: its own, or the
   * one this picker opened on the same app since — a draft kept while the
   * picker was closed was pinned in a workspace that is gone. Null when
   * nothing open now reads the same files.
   */
  private workspaceFor(selection: PickedSelection): string | null {
    const workspace = this.state.workspace;
    if (workspace.status !== "ready") return null;
    if (workspace.workspaceId === selection.workspaceId) return workspace.workspaceId;
    return workspace.appPath === selection.appPath ? workspace.workspaceId : null;
  }

  /**
   * Whether every file a request cites still has the bytes its claims were
   * checked against. Asked of the workspace open now: one the picker has
   * since let go of cannot vouch for anything.
   */
  async sourcesUnchanged(selection: PickedSelection): Promise<boolean> {
    // Nothing was resolved, so nothing is cited that could have changed.
    if (selection.workspaceId === null) return true;
    const workspaceId = this.workspaceFor(selection);
    if (workspaceId === null) return false;
    const own = workspaceId === selection.workspaceId;
    const revisions = citedRevisions(selection);
    // A claim held without its file being read carries no revision to compare,
    // but an edit reported to that file since the selection was made still
    // moves the line it names.
    const captured = Date.parse(selection.capturedAt);
    for (const path of heldPaths(selection)) {
      if (path in revisions) continue;
      // Edits made before this workspace opened were never heard here.
      if (!own) return false;
      const changed = this.recentChanges.get(path);
      // The same millisecond reads as after: a pick can't vouch for bytes it may not have seen.
      if (changed !== undefined && changed >= captured) return false;
    }
    const paths = Object.keys(revisions);
    if (paths.length === 0) return true;
    if (paths.some((path) => revisions[path] === null)) return false;
    let now: ElementPickerSourceRevisionsResult;
    try {
      now = await this.deps.picker.sourceRevisions({ workspaceId, paths: paths.slice(0, 128) });
    } catch (error) {
      if (isWorkspaceClosed(error)) this.recoverClosedWorkspace(workspaceId);
      return false;
    }
    // The app may have been switched while the read was out: its answer is
    // about files the picker no longer has open.
    if (this.currentWorkspaceId() !== workspaceId) return false;
    const current = new Map(now.revisions.map((entry) => [entry.path, entry.revision]));
    return paths.every((path) => current.get(path) === revisions[path]);
  }

  private changedRecently(file: string): boolean {
    const at = this.recentChanges.get(file);
    return at !== undefined && this.deps.now() - at < HMR_SETTLE_MS;
  }

  private noteChanged(file: string): void {
    this.recentChanges.set(file, this.deps.now());
    // A resolve that is out when a change lands must be invalidated here,
    // however long it then takes.
    if (this.state.selection.status === "resolving" || this.quietResolve !== null) {
      this.changedDuringResolve.add(file);
    }
  }

  private isCurrentResolve(request: number, quiet = false): boolean {
    if (request !== this.selectionRequest) return false;
    if (quiet) return this.quietResolve === request && this.reprove !== null;
    const selection = this.state.selection;
    return selection.status === "resolving" && selection.requestId === request;
  }

  private staleSelectionPatch(reason: StaleReason): Partial<InspectorState> {
    if (reason !== "source-changed") this.abandonReprove();
    const selection = this.state.selection;
    const patch: Partial<InspectorState> = {};
    if (selection.status === "ready" && (selection.stale === null || selection.reproving)) {
      patch.selection = { ...selection, stale: reason, reproving: false };
    } else if (selection.status === "resolving") {
      this.selectionRequest++;
      patch.selection = { status: "lost" };
    }
    return patch;
  }

  private handleSourceChanged(push: ElementPickerSourceChangedPush): void {
    const workspaceId = this.currentWorkspaceId();
    if (workspaceId === null || push.workspaceId !== workspaceId) return;
    const path = push.file.path;
    this.noteChanged(path);
    // A closed picker only keeps the record a waiting request is checked against.
    if (this.disposed) return;
    const selection = this.state.selection;
    if (
      selection.status === "ready" &&
      selection.selection.workspaceId === workspaceId &&
      heldPaths(selection.selection).has(path)
    ) {
      if (!this.beginReprove(true)) this.patchState(this.staleSelectionPatch("source-changed"));
    } else if (this.reprove !== null && this.reproveTimer !== null) {
      // Still being written: wait out this change too.
      this.scheduleReprove();
    }
  }

  /**
   * How a component on the trail can be selected right now, if at all — the
   * one rule the crumbs and {@link selectComponent} share, so a crumb is never
   * a button that does nothing. The page only answers a selection request in
   * Select mode, and a stale trail describes an element the page no longer
   * shows. Svelte's locator finds a component by its call site; any other
   * page by the id it gave the component, which names it only in the
   * document the element was proved in.
   */
  componentSelection(): ComponentSelectionMode | null {
    const state = this.state;
    const record = this.continuity;
    if (
      state.binding.status !== "bound" ||
      state.mode !== "select" ||
      state.selection.status !== "ready" ||
      state.selection.stale !== null ||
      record === null
    ) {
      return null;
    }
    if (record.locator !== null) return "site";
    return record.epoch === state.epoch ? "id" : null;
  }

  canSelectComponent(): boolean {
    return this.componentSelection() !== null;
  }

  /**
   * Select the component a crumb in the trail names, the way Option/Alt+Up
   * would, aimed: the page re-selects the element it last proved and widens it
   * to that invocation, and the answer resolves as any fresh pick does. False
   * when the pick can't be made ({@link componentSelection}), the target can't
   * be asked for that way, or the page no longer has the element.
   */
  async selectComponent(target: ComponentTarget): Promise<boolean> {
    const record = this.continuity;
    const binding = this.state.binding;
    const by = this.componentSelection();
    if (record === null || binding.status !== "bound" || by === null) return false;
    let request: ElementPickerReselectRequest | null;
    if (by === "site") {
      request =
        target.usedAt === null
          ? null
          : this.reselectRequest(binding.sessionId, record, target.usedAt, true);
    } else {
      request = target.rendered
        ? {
            sessionId: binding.sessionId,
            elementId: record.elementId,
            framework: target.framework,
            componentId: target.componentId,
            reveal: true,
          }
        : null;
    }
    if (request === null) return false;
    try {
      return await this.deps.picker.reselect(request);
    } catch {
      return false;
    }
  }

  /**
   * The live selection standing for `selectionId` — itself, or one proved again
   * from it after an edit — for a request that was made about it and is only
   * now going out. "pending" while that is still being established. Null when
   * nothing live stands for it: the user selected something else, or the page
   * could not vouch for it. The request is then held to the selection it was
   * made about, and fails honestly if that has changed.
   */
  followSelection(selectionId: string): PickedSelection | "pending" | null {
    const state = this.state.selection;
    if (state.status !== "ready") return null;
    const stands =
      state.selection.selectionId === selectionId ||
      (state.supersedes?.includes(selectionId) ?? false);
    if (!stands) return null;
    if (this.reprove !== null) return "pending";
    if (state.stale !== null) return null;
    return state.selection;
  }

  dismissIssue(): void {
    this.patchState({ issue: null });
  }

  /**
   * Take the notice's one way forward. Cleared first, so a fresh issue raised by
   * the attempt itself — or pushed while it is in flight — is the one left on
   * screen rather than being wiped by the state this call started from.
   */
  async recoverFromIssue(): Promise<void> {
    const recovery = this.state.issue?.recovery;
    if (recovery === undefined) return;
    this.patchState({ issue: null });
    if (recovery.kind === "set-mode") {
      await this.setMode(recovery.mode);
      return;
    }
    await this.retryConnect();
  }

  /**
   * Where the selected page sits in the project, for an agent request: the
   * app, its toolchain, and the route files serving the page's address. Read
   * fresh — routes are exactly what an agent adds while the panel is open.
   * Null when it can't be read in time; the request then goes without.
   */
  async projectFor(selection: PickedSelection): Promise<ProjectContextOutcome | null> {
    const workspaceId = this.workspaceFor(selection);
    if (workspaceId === null) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Optional context: a slow read must not hold the request up. The host
      // bounds its own walk; this only stops listening.
      return await Promise.race([
        this.deps.picker.describeProject({ workspaceId, url: selection.displayedUrl }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PROJECT_CONTEXT_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The picture is taken now, while the page still shows what was clicked,
   * not when a request is sent: by then the page may have scrolled, and the
   * boxes the guest measured would frame something else.
   */
  private takePicture(
    previewPanelId: string,
    viewport: { width: number; height: number },
    observations: SelectionObservation[]
  ): Promise<PageScreenshot> {
    const capture = this.deps.capture;
    const omitted = (reason: string): Promise<PageScreenshot> =>
      Promise.resolve({ status: "omitted", reason });
    const rect = unionBounds(observations.flatMap((observation) => observation.bounds));
    if (capture === undefined) return omitted("this host can't capture the preview");
    if (this.deps.remoteWindow?.() === true) {
      return omitted("this window is attached to another machine");
    }
    if (rect === null) return omitted("the element has no size on screen");
    const taken = capture
      .captureElement(previewPanelId, {
        rect,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      })
      .then(
        (result): PageScreenshot => {
          switch (result.status) {
            case "saved":
              return { status: "attached", path: result.filePath };
            case "offscreen":
              return { status: "omitted", reason: "the element is outside the visible page" };
            case "resized":
              return {
                status: "omitted",
                reason: "the preview changed size before it could be captured",
              };
          }
        },
        (): PageScreenshot => ({ status: "omitted", reason: "the preview couldn't be captured" })
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<PageScreenshot>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "omitted", reason: "capturing the preview took too long" }),
        CAPTURE_TIMEOUT_MS
      );
    });
    return Promise.race([taken, deadline]).finally(() => clearTimeout(timer));
  }

  private keepPicture(selectionId: string, picture: Promise<PageScreenshot>): void {
    keepRecent(this.captures, selectionId, picture);
  }

  /** The picture taken of a selection, or why a request about it goes without one. */
  pagePicture(selectionId: string): Promise<PageScreenshot> {
    return (
      this.captures.get(selectionId) ??
      Promise.resolve({ status: "omitted", reason: "the selection is too old to have a picture" })
    );
  }

  dispose(): void {
    if (this.disposed) return;
    // Switching the picker off puts it away. What was typed stays in the
    // composer's memory, and a request still on its way keeps going: only the
    // preview ending, or the user, cancels it.
    this.clearReattach();
    this.clearConnectRetry();
    this.endReprove();
    this.watchPointerLeaving(false);
    this.held = null;
    this.bindRequest++;
    const binding = this.state.binding;
    if (binding.status === "bound") {
      void this.deps.preview.detach({ sessionId: binding.sessionId }).catch(() => undefined);
    }
    const workspace = this.state.workspace;
    if (workspace.status === "ready" && this.pendingRequests > 0) {
      // Requests on their way are checked against this workspace before they
      // go in, so it stays open, and keeps hearing edits, until they settle.
      this.workspaceRequest++;
      this.projectRequest++;
      this.continuity = null;
      this.lingering = workspace.workspaceId;
    } else {
      this.closeWorkspace();
    }
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.listeners.clear();
    if (this.lingering === null) this.stopHearingSource();
  }

  /**
   * Keep what `request` is checked against for as long as it is on its way,
   * picker open or not. Only this controller's own requests hold it: one made
   * through an earlier session is that session's to wait for.
   */
  holdWhile(request: Promise<void>): void {
    this.pendingRequests++;
    const done = () => {
      this.pendingRequests--;
      if (this.pendingRequests > 0 || this.lingering === null) return;
      this.releaseWorkspace(this.lingering);
      this.lingering = null;
      this.stopHearingSource();
    };
    request.then(done, done);
  }

  private stopHearingSource(): void {
    this.offSourceChanged?.();
    this.offSourceChanged = null;
  }
}

/**
 * The picker for one dev preview, as the dev preview's session for it. The
 * host owns its lifetime — created when the picker is switched on, kept across
 * surface unmounts, disposed when the picker goes off or the preview does — so
 * nothing here reconstructs those events.
 */
export function createElementPickerSession(
  context: DevPreviewToolSessionContext,
  deps: () => InspectorDeps = defaultInspectorDeps
): InspectorController {
  // The chunk can land after the host let this preview go: nothing is built,
  // so nothing binds or opens a workspace for a picker nobody switched on.
  if (context.signal.aborted) {
    throw new Error("The Element Picker was switched off while it loaded");
  }
  const controller = new InspectorController(context.panelId, deps());
  controller.update(context);
  return controller;
}
