import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  SiteGuestNodeObservation,
  SitePreviewBindingState,
  SitePreviewCandidate,
  SitePreviewDetachReason,
  SitePreviewMode,
  SitePreviewPushPayload,
} from "@shared/types/ipc/sitePreview";
import type {
  DevPreviewToolSession,
  DevPreviewToolSessionContext,
} from "@/registry/devPreviewToolRegistry";
import { cancelAgentRequests } from "./agentRequest.js";
import {
  callSiteKey,
  citedFiles,
  componentCallSites,
  type SourceRevisions,
  type ComponentDefinitions,
  type CallSite,
  type PickedComponent,
  type PagePlace,
} from "./agentTask.js";
import { forgetComposerMemories } from "./composerMemory.js";
import { mismatchMessage, wireFailureMessage } from "./copy.js";
import { usePanelStore } from "@/store/panelStore";
import {
  CHANNELS,
  ComponentDefinitionsResultSchema,
  GUEST_ADAPTER_ID,
  GuestEventSchema,
  SourceRevisionsResultSchema,
  ProjectModelResultSchema,
  IssuePushSchema,
  PLUGIN_ID,
  PUSH_CHANNELS,
  SelectionResolveResultSchema,
  SourceChangedPushSchema,
  WorkspaceOpenResultSchema,
  type SupportVerdict,
} from "../shared/protocol.js";
import type { SiteSelection, Viewport } from "../shared/model.js";

/**
 * One controller per dev preview with the Site Builder switched on — the
 * host's tool session for that preview. It holds the preview binding, the
 * source workspace and the selection, and lives exactly as long as the host
 * keeps the builder on for the preview, surfaces or no surfaces.
 *
 * Every piece of preview state is keyed on the document epoch an observation
 * carries, never on arrival order: a reinstalled runtime's `documentReady` can
 * reach us before the `epoch-advanced` push for the same epoch.
 */

export interface SitePreviewApi {
  listCandidates(): Promise<SitePreviewCandidate[]>;
  bind(request: {
    panelId: string;
    /** Names a host-registered guest runtime; the host loads its body. */
    adapterId: string;
    mode?: SitePreviewMode;
  }): Promise<SitePreviewBindingState>;
  detach(request: { sessionId: string }): Promise<void>;
  setMode(request: { sessionId: string; mode: SitePreviewMode }): Promise<SitePreviewBindingState>;
  /** Select the element compiled from `loc` in the page; false when it is not there. */
  reselect(request: {
    sessionId: string;
    loc: { file: string; line: number; column: number };
    /** Which of the elements sharing `loc`, in document order. */
    index?: number;
    /** The component call site to select the element as a member of. */
    component?: { file: string; line: number; column: number };
    /** The id the page reported the element under, to ask for it by identity while it is still that node. */
    occurrence?: string;
  }): Promise<boolean>;
  /** Drop the page's selection without observing anything. */
  clearSelection(request: { sessionId: string }): Promise<void>;
  getState(request: { sessionId: string }): Promise<SitePreviewBindingState | null>;
  onEvent(callback: (payload: SitePreviewPushPayload) => void): () => void;
}

export interface InspectorDeps {
  sitePreview: SitePreviewApi;
  invoke(channel: string, args: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
  now(): number;
}

export interface InspectorContext {
  projectId: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
}

export type BindingState =
  | { status: "idle" }
  | { status: "binding"; panelId: string }
  | { status: "bound"; sessionId: string; panelId: string; url: string | null }
  | { status: "detached"; panelId: string; reason: SitePreviewDetachReason }
  /** `retrying`: an automatic attempt is scheduled; false once they have run out. */
  | { status: "failed"; message: string; retrying: boolean };

export type WorkspaceState =
  | { status: "idle" }
  | { status: "no-worktree" }
  | { status: "opening" }
  | {
      status: "ready";
      workspaceSessionId: string;
      appRoot: string;
      /** Whether this app's Svelte and Kit versions are ones we parse. */
      support: SupportVerdict;
      /** Every app the worktree holds, when there is more than one to switch between. */
      appRoots: string[];
    }
  | { status: "ambiguous"; appRoots: string[] }
  | { status: "no-app" }
  | { status: "failed"; message: string };

/** A frame the trail can hand to a crumb: a component invocation with a tag. */
function namesComponent(frame: { type: string; componentTag?: string }): boolean {
  return frame.type === "component" && frame.componentTag !== undefined;
}

export interface PageState {
  epoch: number;
  routeId: string | null;
  url: string;
  viewport: Viewport;
  /**
   * What the page's Svelte dev metadata turned out to support, or null until
   * the page has probed it. `ancestry` false means the trail can name elements
   * but never the components above them, so a component cannot be picked.
   */
  metadata: { locations: boolean; ancestry: boolean } | null;
}

export type StaleReason = "document-changed" | "source-changed" | "preview-detached";

export type SelectionState =
  | { status: "none" }
  | { status: "resolving"; epoch: number; requestId: number }
  /** Seen in the page, but no source identity can be resolved for it. */
  | { status: "observed"; epoch: number; node: SiteGuestNodeObservation; nodeCount: number }
  | {
      status: "ready";
      selection: SiteSelection;
      /** Worktree-relative file that owns the primary node's markup, when known. */
      file: string | null;
      stale: StaleReason | null;
      /** A whole component invocation (its rendered roots) rather than one element. */
      scope: "element" | "component";
      /** For a component selection: the selected component's call site. */
      component: PickedComponent | null;
      /**
       * Where each component on the chain is written, read from source by main.
       * Null until main answers; a component scope without a file can't be sent.
       */
      definitions: ComponentDefinitions;
      /** The revisions every cited file had when its claims were read; null until then. */
      revisions: SourceRevisions;
    }
  /** The document moved on before the resolve finished. */
  | { status: "lost" }
  /** The owning file changed moments ago; the page may still show the old markup. */
  | { status: "settling" }
  | { status: "failed"; message: string };

/**
 * The last proven element, in the terms the page can be asked for it again:
 * what {@link InspectorController.selectComponent} names when the user picks a
 * component out of the trail. Refreshed by every proven resolution, and null
 * for a copy the page could not place — "the first one" would be a guess, and
 * past the page's scan bound even a count of one is only a floor.
 */
interface Continuity {
  loc: { file: string; line: number; column: number };
  locIndex: number;
  /** What the page reported the element as; the reselect names it first. */
  occurrence: string;
}

export interface InspectorIssue {
  severity: "warning" | "error";
  message: string;
  /** The page's own verdict, when it came from the page. */
  code?: string;
}

/** How long an agent request waits for the route files before going without them. */
const PAGE_PLACE_TIMEOUT_MS = 3_000;

/** Page verdicts that a traced element disproves. */
const MAPPING_ISSUES = new Set(["no-svelte-meta", "not-dev-build", "metadata-shape"]);
/** Cleared by a selection whose page reported a component chain after all. */
const ANCESTRY_ISSUE = "no-ancestry";

export interface InspectorState {
  binding: BindingState;
  mode: SitePreviewMode;
  modePending: boolean;
  /** Highest document epoch observed for the bound session. */
  epoch: number | null;
  page: PageState | null;
  workspace: WorkspaceState;
  selection: SelectionState;
  issue: InspectorIssue | null;
  /** Advances on every new selection, so a surface can start clean on one. */
  selectionGeneration: number;
}

export const INITIAL_INSPECTOR_STATE: InspectorState = {
  binding: { status: "idle" },
  // Turning the builder on is asking to pick something.
  mode: "select",
  modePending: false,
  epoch: null,
  page: null,
  workspace: { status: "idle" },
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

const RUNTIME_ISSUE_COPY: Record<string, string> = {
  "no-svelte-meta":
    "This page carries no Svelte source locations. Run the app with the Vite dev server to select elements.",
  "not-dev-build": "This preview is a production build, so elements can't be traced to source",
  "overlay-blocked": "The page blocked the selection overlay",
  internal: "The inspector hit a problem inside the page",
  "metadata-shape":
    "This page's Svelte metadata has a shape the builder doesn't recognise, so elements can't be traced to source. Check the Svelte version against the supported baseline.",
  [ANCESTRY_ISSUE]:
    "This Svelte version reports where elements come from but not the components above them, so the trail names elements only.",
};

/**
 * The host services for the builder of one dev preview. Pushes are subscribed
 * per panel: main addresses each one to the preview whose workspace it is
 * about, so nothing another preview's workspace reports arrives here.
 */
export function defaultInspectorDeps(previewPanelId: string): InspectorDeps {
  return {
    sitePreview: window.electron.sitePreview,
    invoke: (channel, args) => window.electron.plugin.invoke(PLUGIN_ID, channel, args),
    on: (channel, callback) =>
      window.electron.plugin.onPanel(PLUGIN_ID, channel, previewPanelId, callback),
    now: () => Date.now(),
  };
}

/**
 * Worktree-relative path of the file that owns a node. `__svelte_meta` paths are
 * relative to the Vite root, which is the app root — not necessarily the
 * worktree root in a monorepo.
 */
/**
 * The app a dev preview's server runs: its working directory's own app, or the
 * nearest app containing it. Null when the preview's directory is above every
 * app (a monorepo root script), which only the user can resolve.
 */
function isWithin(root: string, path: string): boolean {
  const base = trimSlash(root);
  const target = trimSlash(path);
  return target === base || target.startsWith(`${base}/`);
}

export function appRunningIn(appRoots: readonly string[], panel: unknown): string | null {
  const cwd = (panel as { kind?: string; cwd?: unknown } | undefined)?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const directory = trimSlash(cwd);
  let best: string | null = null;
  for (const appRoot of appRoots) {
    const root = trimSlash(appRoot);
    const contains = directory === root || directory.startsWith(`${root}/`);
    if (contains && (best === null || root.length > trimSlash(best).length)) best = appRoot;
  }
  return best;
}

export function ownerFile(selection: SiteSelection, worktreePath: string | null): string | null {
  const node = selection.nodes[0];
  if (!node?.definition) return null;
  return worktreeRelative(selection.appRoot, worktreePath, node.definition.location.file);
}

export function worktreeRelative(
  appRoot: string,
  worktreePath: string | null,
  appRelativeFile: string
): string | null {
  if (!worktreePath) return appRelativeFile;
  const root = trimSlash(worktreePath);
  const app = trimSlash(appRoot);
  if (app === root) return appRelativeFile;
  if (!app.startsWith(root + "/")) return null;
  return `${app.slice(root.length + 1)}/${appRelativeFile}`;
}

/**
 * Main reports a workspace it no longer holds — after the plugin was disabled
 * or its worker restarted — as a thrown `WORKSPACE_CLOSED`, or as an
 * `OUT_OF_SCOPE`/unavailable result naming the closed workspace.
 */
export function isWorkspaceClosed(value: unknown): boolean {
  let text: string;
  if (typeof value === "object" && value !== null && !(value instanceof Error)) {
    const record = value as { message?: unknown; reason?: unknown };
    text = String(record.message ?? record.reason ?? "");
  } else {
    text = formatErrorMessage(value, "");
  }
  return text.includes("WORKSPACE_CLOSED") || text.includes("source workspace is not open");
}

function trimSlash(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** How long after a source change a click may still land on the pre-HMR DOM. */
export const HMR_SETTLE_MS = 1000;

export class InspectorController implements DevPreviewToolSession {
  readonly panelId: string;
  private state: InspectorState = INITIAL_INSPECTOR_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private context: InspectorContext = { projectId: null, worktreeId: null, worktreePath: null };
  private workspaceKey: string | null = null;
  private workspaceRequest = 0;
  private bindRequest = 0;
  private reattachTimer: ReturnType<typeof setTimeout> | null = null;
  private connectRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAttempts = 0;
  private selectionRequest = 0;
  private bufferedEvents: SitePreviewPushPayload[] = [];
  /** Files main reported changed while the current resolve was in flight. */
  private readonly changedDuringResolve = new Set<string>();
  /** Worktree-relative file → when it last changed, for the HMR settle window. */
  private readonly recentChanges = new Map<string, number>();
  private chosenAppRoot: string | undefined;
  private recoveringWorkspace: string | null = null;
  private disposed = false;
  private warnedUnusableGuestEvent = false;

  constructor(
    panelId: string,
    private readonly deps: InspectorDeps
  ) {
    this.panelId = panelId;
    this.unsubscribers.push(
      deps.sitePreview.onEvent((payload) => this.handlePreviewPush(payload)),
      deps.on(PUSH_CHANNELS.sourceChanged, (payload) => this.handleSourceChanged(payload)),
      deps.on(PUSH_CHANNELS.issue, (payload) => this.handleIssue(payload))
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
   * for as long as the builder is switched on for it — including while none of
   * the builder's surfaces are mounted, which is when a bind that failed for
   * want of a page gets its retry.
   */
  update(context: DevPreviewToolSessionContext): void {
    this.updateContext({
      projectId: context.projectId,
      worktreeId: context.worktreeId,
      worktreePath: context.worktreePath,
    });
    if (context.isWebviewReady && context.url && this.state.binding.status === "failed") {
      void this.connect();
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
        void this.deps.sitePreview.detach({ sessionId: binding.sessionId }).catch(() => undefined);
      }
      // A request still waiting on an agent was about the old worktree's source.
      cancelAgentRequests(this.panelId);
      void this.connect();
    }
    const key =
      context.projectId && context.worktreeId && context.worktreePath
        ? `${context.projectId}\n${context.worktreeId}\n${context.worktreePath}`
        : null;
    if (key === this.workspaceKey) {
      if (key !== null && this.state.workspace.status === "idle") void this.openWorkspace();
      return;
    }
    this.chosenAppRoot = undefined;
    this.knownAppRoots = [];
    this.closeWorkspace();
    this.workspaceKey = key;
    if (key === null) {
      this.patchState({ workspace: { status: "no-worktree" } });
      return;
    }
    void this.openWorkspace();
  }

  /** The last proven element, for asking the page for it again. */
  private continuity: Continuity | null = null;
  /** The apps a worktree offered when it held more than one. */
  private knownAppRoots: string[] = [];

  async openWorkspace(appRoot: string | undefined = this.chosenAppRoot): Promise<void> {
    this.chosenAppRoot = appRoot;
    const { projectId, worktreeId, worktreePath } = this.context;
    if (!projectId || !worktreeId || !worktreePath) return;
    const request = ++this.workspaceRequest;
    // A preview moved between worktrees keeps running its server from the old
    // one: the page would show one checkout while the agent works in another.
    const cwd = (usePanelStore.getState().panelsById[this.panelId] as { cwd?: unknown } | undefined)
      ?.cwd;
    if (typeof cwd === "string" && cwd.length > 0 && !isWithin(worktreePath, cwd)) {
      this.patchState({
        workspace: {
          status: "failed",
          message:
            "This preview's dev server runs from another worktree. Restart it from this worktree to trace elements.",
        },
      });
      return;
    }
    this.patchState({ workspace: { status: "opening" } });
    try {
      const raw = await this.deps.invoke(CHANNELS.workspaceOpen, {
        projectId,
        worktreeId,
        worktreePath,
        previewPanelId: this.panelId,
        ...(appRoot ? { appRoot } : {}),
      });
      const result = WorkspaceOpenResultSchema.parse(raw);
      if (request !== this.workspaceRequest) {
        if (result.status === "ready") this.releaseWorkspace(result.workspaceSessionId);
        return;
      }
      switch (result.status) {
        case "ready":
          this.patchState({
            workspace: {
              status: "ready",
              workspaceSessionId: result.workspaceSessionId,
              appRoot: result.appRoot,
              support: result.support,
              appRoots: this.knownAppRoots.includes(result.appRoot) ? this.knownAppRoots : [],
            },
          });
          return;
        case "ambiguous": {
          this.knownAppRoots = result.appRoots;
          // The dev server runs in one of them: that is the app this preview shows.
          const running = appRunningIn(
            result.appRoots,
            usePanelStore.getState().panelsById[this.panelId]
          );
          if (running && appRoot === undefined) {
            void this.openWorkspace(running);
            return;
          }
          this.patchState({ workspace: { status: "ambiguous", appRoots: result.appRoots } });
          return;
        }
        case "no-app":
          this.patchState({ workspace: { status: "no-app" } });
          return;
      }
    } catch (error) {
      if (request !== this.workspaceRequest) return;
      this.patchState({
        workspace: {
          status: "failed",
          message: wireFailureMessage(error, "Couldn't open the site source"),
        },
      });
    }
  }

  private releaseWorkspace(workspaceSessionId: string): void {
    void this.deps.invoke(CHANNELS.workspaceClose, { workspaceSessionId }).catch(() => undefined);
  }

  /**
   * Point the builder at another app in the same worktree. The selection was
   * proven against the old one, so it belongs to it and goes.
   */
  switchApp(appRoot: string): void {
    const workspace = this.state.workspace;
    if (workspace.status === "ready" && workspace.appRoot === appRoot) return;
    // A request on its way cites the old app's files; it must not land after the switch.
    cancelAgentRequests(this.panelId);
    this.closeWorkspace();
    void this.openWorkspace(appRoot);
  }

  private closeWorkspace(): void {
    this.workspaceRequest++;
    this.continuity = null;
    const workspace = this.state.workspace;
    if (workspace.status === "ready") this.releaseWorkspace(workspace.workspaceSessionId);
    // Source identity belongs to the workspace that minted it.
    this.patchState({
      workspace: { status: "idle" },
      selection: this.state.selection.status === "none" ? this.state.selection : { status: "none" },
    });
  }

  private currentWorkspaceId(): string | null {
    const workspace = this.state.workspace;
    return workspace.status === "ready" ? workspace.workspaceSessionId : null;
  }

  /**
   * Main no longer holds our workspace (plugin disabled and re-enabled, or its
   * worker restarted), so the selection it proved is gone too. Reopen once per
   * lost session; a second failure is reported, not looped on.
   */
  private recoverClosedWorkspace(workspaceSessionId: string): void {
    if (this.currentWorkspaceId() !== workspaceSessionId) return;
    if (this.recoveringWorkspace === workspaceSessionId) return;
    this.recoveringWorkspace = workspaceSessionId;
    this.selectionRequest++;
    this.patchState({ workspace: { status: "idle" }, selection: { status: "none" } });
    void this.openWorkspace();
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
      void this.deps.sitePreview.detach({ sessionId: previous.sessionId }).catch(() => undefined);
    }
    this.bufferedEvents = [];
    this.warnedUnusableGuestEvent = false;
    this.patchState({
      binding: { status: "binding", panelId: previewPanelId },
      epoch: null,
      page: null,
      issue: null,
      ...this.staleSelectionPatch("preview-detached"),
    });

    // Always a fresh bind, never adoption of a listed session: `getState` can't
    // replay the page snapshot a selection needs, and a session listed on the
    // candidate isn't proof it was this panel's.
    let state: SitePreviewBindingState;
    try {
      state = await this.deps.sitePreview.bind({
        panelId: previewPanelId,
        adapterId: GUEST_ADAPTER_ID,
        mode: this.state.mode,
      });
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
          message: formatErrorMessage(error, "Couldn't connect to the dev preview"),
          retrying,
        },
      });
      return;
    }
    this.connectAttempts = 0;
    if (request !== this.bindRequest || this.disposed) {
      // Superseded or disposed while binding: the session we just got is nobody's.
      void this.deps.sitePreview.detach({ sessionId: state.sessionId }).catch(() => undefined);
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
   * the same panel a few times before leaving it to the user; when DevTools
   * really does own the page, every attempt fails fast and the notice stays.
   */
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
    const delay = CONNECT_RETRY_DELAYS_MS[this.connectAttempts]!;
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
    if (binding.status !== "bound") return;
    this.patchState({
      binding: { status: "detached", panelId: binding.panelId, reason: "requested" },
      ...this.staleSelectionPatch("preview-detached"),
    });
    await this.deps.sitePreview.detach({ sessionId: binding.sessionId }).catch(() => undefined);
  }

  async setMode(mode: SitePreviewMode): Promise<void> {
    const binding = this.state.binding;
    if (binding.status !== "bound" || mode === this.state.mode) return;
    const previous = this.state.mode;
    this.patchState({ mode, modePending: true });
    try {
      const next = await this.deps.sitePreview.setMode({ sessionId: binding.sessionId, mode });
      if (!this.isBoundTo(binding.sessionId)) return;
      this.noteEpoch(next.documentEpoch);
      this.patchState({ mode: next.mode, modePending: false });
    } catch (error) {
      if (!this.isBoundTo(binding.sessionId)) return;
      this.patchState({
        mode: previous,
        modePending: false,
        issue: {
          severity: "error",
          message: formatErrorMessage(error, "Couldn't switch the preview mode"),
        },
      });
    }
  }

  /**
   * Said once per binding attempt: a page emitting one unusable event will emit
   * thousands, and the first is the only informative one. Scoped to the
   * binding, not the controller's whole life, so junk from one document cannot
   * silence the next one's.
   */
  private warnUnusableGuestEvent(type: string): void {
    if (this.warnedUnusableGuestEvent) return;
    this.warnedUnusableGuestEvent = true;
    console.warn(
      `[site-builder] dropped a guest "${type}" event whose payload did not match the adapter schema; further ones are silent`
    );
  }

  private isBoundTo(sessionId: string): boolean {
    const binding = this.state.binding;
    return binding.status === "bound" && binding.sessionId === sessionId;
  }

  private handlePreviewPush(payload: SitePreviewPushPayload): void {
    const binding = this.state.binding;
    if (binding.status === "binding") {
      if (payload.kind === "guest-event") {
        // Hover traffic is worthless after the fact; keep the newest of the
        // rest, since readiness and epoch pushes are what the replay needs
        // most.
        if (payload.event.type === "hoverChanged") return;
        // An event whose body we cannot read is never worth a buffer slot: it
        // would evict a readiness push and then be dropped on replay anyway.
        // The replay parses again rather than carrying the parsed value, which
        // keeps one parse the authority for everything downstream of it.
        if (!GuestEventSchema.safeParse(payload.event).success) {
          this.warnUnusableGuestEvent(String(payload.event.type));
          return;
        }
      }
      this.bufferedEvents.push(payload);
      if (this.bufferedEvents.length > MAX_BUFFERED_EVENTS) this.bufferedEvents.shift();
      return;
    }
    if (binding.status !== "bound" || payload.sessionId !== binding.sessionId) return;

    switch (payload.kind) {
      case "detached":
        this.bindRequest++;
        this.patchState({
          binding: { status: "detached", panelId: binding.panelId, reason: payload.reason },
          ...this.staleSelectionPatch("preview-detached"),
        });
        if (REATTACH_REASONS.has(payload.reason)) this.scheduleReattach(binding.panelId);
        return;
      case "epoch-advanced":
        this.noteEpoch(payload.documentEpoch);
        return;
      case "guest-event":
        this.handleGuestEvent(payload);
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
    const selection = this.state.selection;
    if (
      (selection.status === "ready" &&
        selection.selection.documentEpoch < epoch &&
        selection.stale === null) ||
      (selection.status === "observed" && selection.epoch < epoch)
    ) {
      Object.assign(patch, this.staleSelectionPatch("document-changed"));
    } else if (selection.status === "resolving" && selection.epoch < epoch) {
      patch.selection = { status: "lost" };
    }
    if (this.state.issue) patch.issue = null;
    this.patchState(patch);
  }

  private handleGuestEvent(
    payload: Extract<SitePreviewPushPayload, { kind: "guest-event" }>
  ): void {
    const epoch = payload.documentEpoch;
    // Epoch bookkeeping comes off the envelope, which the host validated, so it
    // holds even for an event whose body turns out to be unusable.
    this.noteEpoch(epoch);
    if (this.state.epoch !== null && epoch < this.state.epoch) return;

    // The host validated the envelope and that the event has a `type`; the body
    // is ours to prove. Nothing below may read a field before this parse.
    const parsed = GuestEventSchema.safeParse(payload.event);
    if (!parsed.success) {
      this.warnUnusableGuestEvent(String(payload.event.type));
      return;
    }

    const event = parsed.data;
    switch (event.type) {
      case "documentReady": {
        // The page reports itself again on a client-side navigation or a
        // resize, within the same document; its metadata has not changed and
        // the probe that described it will not run again.
        const current = this.state.page;
        const patch: Partial<InspectorState> = {
          page: {
            epoch,
            routeId: event.routeId,
            url: event.url,
            viewport: event.viewport,
            metadata: current !== null && current.epoch === epoch ? current.metadata : null,
          },
        };
        const binding = this.state.binding;
        if (binding.status === "bound") patch.binding = { ...binding, url: event.url };
        this.patchState(patch);
        return;
      }
      case "selectionChanged":
        this.clearDisprovedMappingIssue(event.nodes);
        void this.handleSelection(
          epoch,
          event.nodes,
          event.scope ?? "element",
          event.component ?? null
        );
        return;
      case "runtimeIssue":
        this.patchState({
          issue: {
            severity: event.code === "internal" ? "error" : "warning",
            message: RUNTIME_ISSUE_COPY[event.code] ?? event.detail,
            code: event.code,
          },
        });
        return;
      case "hoverChanged":
        if (event.node !== null) this.clearDisprovedMappingIssue([event.node]);
        return;
      case "mappingRevisionSeen":
        return;
      case "metadataProbed": {
        const page = this.state.page;
        if (page === null || page.epoch !== epoch) return;
        const metadata = { locations: event.locations, ancestry: event.ancestry };
        const patch: Partial<InspectorState> = { page: { ...page, metadata } };
        // A page that hydrated late can be probed after the audit already
        // called it a production build; the probe's answer is the newer fact.
        const code = this.state.issue?.code;
        if (event.locations && code !== undefined && MAPPING_ISSUES.has(code)) patch.issue = null;
        // A shape the runtime could not read is said once, up front, rather
        // than discovered click by click; a chain it could not follow narrows
        // the trail and says why.
        if (!event.locations) {
          patch.issue = {
            severity: "warning",
            message: RUNTIME_ISSUE_COPY["metadata-shape"]!,
            code: "metadata-shape",
          };
        } else if (!event.ancestry) {
          patch.issue = {
            severity: "warning",
            message: RUNTIME_ISSUE_COPY[ANCESTRY_ISSUE]!,
            code: ANCESTRY_ISSUE,
          };
        }
        this.patchState(patch);
        return;
      }
    }
  }

  /**
   * An element with a source location is proof of dev metadata, whatever the
   * page concluded earlier — a verdict reached while it was still hydrating
   * must not sit above a selection that plainly traced.
   */
  private clearDisprovedMappingIssue(nodes: SiteGuestNodeObservation[]): void {
    const traced = nodes.some((node) => node.loc !== null);
    // A chain is only a chain the trail can use when it names a component: a
    // block frame on its own gives a crumb nothing to select.
    const chained = nodes.some((node) => node.ancestry.some(namesComponent));
    const patch: Partial<InspectorState> = {};
    // What the page shows outranks what its probe sampled: a chain the sample
    // lacked can turn up on a deeper element, whether or not the notice about
    // it is still on screen.
    const page = this.state.page;
    const metadata = page?.metadata ?? null;
    if (metadata && ((traced && !metadata.locations) || (chained && !metadata.ancestry))) {
      patch.page = {
        ...page!,
        metadata: {
          locations: metadata.locations || traced,
          ancestry: metadata.ancestry || chained,
        },
      };
    }
    const code = this.state.issue?.code;
    if (code !== undefined) {
      if (MAPPING_ISSUES.has(code) && traced) patch.issue = null;
      if (code === ANCESTRY_ISSUE && chained) patch.issue = null;
    }
    if (Object.keys(patch).length > 0) this.patchState(patch);
  }

  /* ------------------------------------------------------------------------ */
  /* Selection                                                                */
  /* ------------------------------------------------------------------------ */

  private async handleSelection(
    epoch: number,
    nodes: SiteGuestNodeObservation[],
    scope: "element" | "component" = "element",
    component: PickedComponent | null = null
  ): Promise<void> {
    const request = ++this.selectionRequest;
    this.changedDuringResolve.clear();
    if (nodes.length === 0) {
      // The page has nothing selected — the user cleared it (Escape, a click on
      // nothing), or the node it was showing left the document.
      this.continuity = null;
      this.patchState({ selection: { status: "none" } });
      return;
    }
    const workspace = this.state.workspace;
    const page = this.state.page;
    const binding = this.state.binding;
    // An untested toolchain is still traced, and its selection can still go to
    // an agent: the verdict is about which compiler proved the range, not about
    // what the drawer offers.
    if (workspace.status !== "ready" || binding.status !== "bound") {
      this.patchState({
        selection: { status: "observed", epoch, node: nodes[0]!, nodeCount: nodes.length },
      });
      return;
    }
    if (!page || page.epoch !== epoch) {
      this.patchState({
        selection: { status: "failed", message: "The page is still loading — select again" },
      });
      return;
    }

    // HMR doesn't advance the epoch, so right after an agent's write the page
    // can still show the old markup while main resolves the click against the
    // new bytes — and lands on a different element of the same tag.
    const clickedFiles = nodes.flatMap((node) =>
      node.loc
        ? [worktreeRelative(workspace.appRoot, this.context.worktreePath, node.loc.file)]
        : []
    );
    if (clickedFiles.some((file) => file !== null && this.changedRecently(file))) {
      this.patchState({ selection: { status: "settling" } });
      return;
    }

    this.patchState({ selection: { status: "resolving", epoch, requestId: request } });
    let raw: unknown;
    try {
      raw = await this.deps.invoke(CHANNELS.selectionResolve, {
        workspaceSessionId: workspace.workspaceSessionId,
        previewPanelId: binding.panelId,
        documentEpoch: epoch,
        routeId: page.routeId,
        url: page.url,
        viewport: page.viewport,
        nodes,
      });
    } catch (error) {
      if (!this.isCurrentResolve(request)) return;
      if (isWorkspaceClosed(error)) {
        this.recoverClosedWorkspace(workspace.workspaceSessionId);
        return;
      }
      this.patchState({
        selection: {
          status: "failed",
          message: formatErrorMessage(error, "Couldn't find the source for this element"),
        },
      });
      return;
    }
    if (!this.isCurrentResolve(request)) return;
    const parsed = SelectionResolveResultSchema.safeParse(raw);
    if (!parsed.success) {
      this.patchState({
        selection: { status: "failed", message: "Couldn't find the source for this element" },
      });
      return;
    }
    const result = parsed.data;
    // The page's location for the element and the file disagree. When the
    // file is known to have just changed, that is the page still catching up
    // and the usual notices apply; otherwise nothing moved, "select again"
    // would be the same click for the same answer, and the notice says what
    // was seen instead.
    if (result.status === "stale" && result.mismatch !== undefined) {
      const changed = worktreeRelative(
        workspace.appRoot,
        this.context.worktreePath,
        result.mismatch.file
      );
      if (changed !== null && this.changedDuringResolve.has(changed)) {
        this.patchState({ selection: { status: "lost" } });
        return;
      }
      if (changed !== null && this.changedRecently(changed)) {
        this.patchState({ selection: { status: "settling" } });
        return;
      }
      this.patchState({
        selection: { status: "failed", message: mismatchMessage(result.mismatch) },
      });
      return;
    }
    if (
      result.status === "stale" ||
      this.state.epoch !== epoch ||
      result.selection.documentEpoch !== epoch ||
      result.selection.workspaceSessionId !== workspace.workspaceSessionId
    ) {
      this.patchState({ selection: { status: "lost" } });
      return;
    }
    const selection = result.selection;
    const file = ownerFile(selection, this.context.worktreePath);
    // The observation predates the change, but main resolved it against the
    // newer bytes; the pairing can't be trusted, so the user selects again.
    if (file !== null && this.changedDuringResolve.has(file)) {
      this.patchState({ selection: { status: "lost" } });
      return;
    }
    if (file !== null && this.changedRecently(file)) {
      this.patchState({ selection: { status: "settling" } });
      return;
    }
    const after = selection.nodes[0]?.definition ?? null;
    const location = after?.location ?? null;
    const pickedOccurrence = nodes[0]?.locIndex;
    this.continuity =
      location !== null && pickedOccurrence !== undefined
        ? {
            loc: { ...location },
            locIndex: pickedOccurrence,
            occurrence: nodes[0]!.runtimeOccurrenceId,
          }
        : null;
    this.patchState({
      selection: {
        status: "ready",
        selection,
        file,
        stale: null,
        scope,
        component,
        definitions: null,
        revisions: null,
      },
      selectionGeneration: this.state.selectionGeneration + 1,
    });
    void this.resolveDefinitions(selection, component);
  }

  private async resolveDefinitions(
    selection: SiteSelection,
    component: PickedComponent | null
  ): Promise<void> {
    // The live selection always settles: unanswerable means unproven, and a
    // file whose revision couldn't be read can't vouch for anything.
    const facts = (await this.lookupDefinitions(selection, component)) ?? {
      definitions: Object.fromEntries(
        componentCallSites(selection, component).map((site) => [callSiteKey(site), null])
      ),
      revisions: {},
    };
    const current = this.state.selection;
    if (current.status !== "ready" || current.selection.selectionId !== selection.selectionId) {
      return;
    }
    this.patchState({ selection: { ...current, ...facts } });
  }

  /**
   * What a request about a selection may claim: where its components are
   * written, read from source by main, and the revision of every file those
   * claims come from. Asked through the workspace open now — a draft pinned to
   * an older selection may carry a session that has since closed. Null when
   * there is nobody to ask yet (no open workspace for that app, or it closed
   * mid-request), so the caller can try again.
   */
  async lookupDefinitions(
    selection: SiteSelection,
    component: PickedComponent | null
  ): Promise<{
    definitions: Record<string, string | null>;
    revisions: Record<string, string | null>;
  } | null> {
    const workspace = this.state.workspace;
    if (workspace.status !== "ready" || workspace.appRoot !== selection.appRoot) return null;
    const callSites = componentCallSites(selection, component).slice(0, 64);
    const definitions: Record<string, string | null> = {};
    // Revisions come from the very reads the answers were drawn from, so a
    // file edited in between can't lend its newer hash to an older mapping.
    const revisions: Record<string, string | null> = {};
    const record = (file: string, revision: string | null) => {
      // Two reads of one file that disagree prove neither.
      revisions[file] = file in revisions && revisions[file] !== revision ? null : revision;
    };
    if (callSites.length > 0) {
      try {
        const parsed = ComponentDefinitionsResultSchema.safeParse(
          await this.deps.invoke(CHANNELS.componentDefinitions, {
            workspaceSessionId: workspace.workspaceSessionId,
            callSites,
          })
        );
        if (parsed.success) {
          for (const entry of parsed.data.definitions) {
            definitions[callSiteKey(entry)] = entry.definedIn;
            record(entry.file, entry.revision);
            if (entry.definedIn) record(entry.definedIn, entry.definedInRevision);
          }
        }
      } catch (error) {
        if (isWorkspaceClosed(error)) {
          this.recoverClosedWorkspace(workspace.workspaceSessionId);
          return null;
        }
        // Anything else: unproven is the answer, and no component scope is sendable.
      }
    }
    for (const site of callSites) {
      const key = callSiteKey(site);
      if (!(key in definitions)) definitions[key] = null;
    }
    // An element's own file is held to the revision it was resolved against —
    // and a mapping read from other bytes of that file leaves it unprovable.
    for (const node of selection.nodes) {
      if (node.definition) record(node.definition.location.file, node.definition.revision);
    }
    // Anything cited that no read vouched for can't be verified, so it fails.
    for (const file of citedFiles(selection, component, definitions)) {
      if (!(file in revisions)) revisions[file] = null;
    }
    return { definitions, revisions };
  }

  /**
   * Whether every file a request cites still has the bytes its claims were
   * read from. Checked against disk through the workspace open now.
   */
  async sourcesUnchanged(selection: SiteSelection, revisions: SourceRevisions): Promise<boolean> {
    if (revisions === null) return false;
    const workspace = this.state.workspace;
    if (workspace.status !== "ready" || workspace.appRoot !== selection.appRoot) return false;
    const files = Object.keys(revisions);
    if (files.length === 0) return true;
    const now = await this.readRevisions(files);
    // The app may have been switched while the read was out: its answer is
    // about files the builder no longer has open.
    const after = this.state.workspace;
    if (after.status !== "ready" || after.workspaceSessionId !== workspace.workspaceSessionId) {
      return false;
    }
    return (
      now !== null &&
      files.every((file) => revisions[file] !== null && now[file] === revisions[file])
    );
  }

  private async readRevisions(files: string[]): Promise<Record<string, string | null> | null> {
    const workspace = this.state.workspace;
    if (workspace.status !== "ready") return null;
    const revisions: Record<string, string | null> = {};
    if (files.length === 0) return revisions;
    try {
      const parsed = SourceRevisionsResultSchema.safeParse(
        await this.deps.invoke(CHANNELS.sourceRevisions, {
          workspaceSessionId: workspace.workspaceSessionId,
          files: files.slice(0, 128),
        })
      );
      if (parsed.success) {
        for (const entry of parsed.data.revisions) revisions[entry.file] = entry.revision;
      }
    } catch (error) {
      if (isWorkspaceClosed(error)) {
        this.recoverClosedWorkspace(workspace.workspaceSessionId);
        return null;
      }
    }
    for (const file of files) if (!(file in revisions)) revisions[file] = null;
    return revisions;
  }

  private changedRecently(file: string): boolean {
    const at = this.recentChanges.get(file);
    return at !== undefined && this.deps.now() - at < HMR_SETTLE_MS;
  }

  private noteChanged(file: string): void {
    this.recentChanges.set(file, this.deps.now());
    // A resolve that is out when a change lands must be invalidated here,
    // however long it then takes.
    if (this.state.selection.status === "resolving") this.changedDuringResolve.add(file);
  }

  private isCurrentResolve(request: number): boolean {
    const selection = this.state.selection;
    return (
      request === this.selectionRequest &&
      selection.status === "resolving" &&
      selection.requestId === request
    );
  }

  private staleSelectionPatch(reason: StaleReason): Partial<InspectorState> {
    const selection = this.state.selection;
    const patch: Partial<InspectorState> = {};
    if (selection.status === "ready" && selection.stale === null) {
      patch.selection = { ...selection, stale: reason };
    } else if (selection.status === "resolving") {
      this.selectionRequest++;
      patch.selection = { status: "lost" };
    } else if (selection.status === "observed") {
      patch.selection = { status: "none" };
    }
    return patch;
  }

  private handleSourceChanged(raw: unknown): void {
    const parsed = SourceChangedPushSchema.safeParse(raw);
    if (!parsed.success) return;
    const push = parsed.data;
    const workspace = this.state.workspace;
    if (workspace.status !== "ready" || push.workspaceSessionId !== workspace.workspaceSessionId) {
      return;
    }
    this.noteChanged(push.file);
    const selection = this.state.selection;
    if (selection.status === "ready" && selection.file === push.file) {
      this.patchState(this.staleSelectionPatch("source-changed"));
    }
  }

  private handleIssue(raw: unknown): void {
    const parsed = IssuePushSchema.safeParse(raw);
    if (!parsed.success) return;
    this.patchState({ issue: { severity: parsed.data.severity, message: parsed.data.message } });
  }

  /**
   * Whether a component on the trail can be selected right now — the one rule
   * the crumbs and {@link selectComponent} share, so a crumb is never a button
   * that does nothing. The page only answers a selection request in Select
   * mode; a stale trail describes an element the page no longer shows; and a
   * selection the page could not place (no proven location, or an occurrence
   * it could not count) cannot be asked for again.
   */
  canSelectComponent(): boolean {
    const state = this.state;
    return (
      state.binding.status === "bound" &&
      state.mode === "select" &&
      state.selection.status === "ready" &&
      state.selection.stale === null &&
      // A page whose metadata names no component chain has no component to
      // hand the crumb to; the crumbs stay text.
      state.page?.metadata?.ancestry !== false &&
      this.continuity !== null
    );
  }

  /**
   * Select the component invoked at `usedAt` — what a crumb in the trail names
   * — the way Option/Alt+Up would, aimed: the page re-selects the element it
   * last proved as a member of that invocation and reports it back, and the
   * answer resolves as any fresh pick does. Clicking the page lands on the
   * innermost thing under the pointer, and the component a request should be
   * about is usually a step or two up; the trail names those steps.
   *
   * The page's answer is taken for what it is — the user's choice — and
   * resolves as any fresh pick does. False when the pick can't be made
   * ({@link canSelectComponent}) or the page no longer has the element.
   */
  async selectComponent(usedAt: CallSite): Promise<boolean> {
    const record = this.continuity;
    const binding = this.state.binding;
    if (record === null || binding.status !== "bound" || !this.canSelectComponent()) {
      return false;
    }
    try {
      return await this.deps.sitePreview.reselect({
        sessionId: binding.sessionId,
        loc: record.loc,
        index: record.locIndex,
        occurrence: record.occurrence,
        component: { file: usedAt.file, line: usedAt.line, column: usedAt.column },
      });
    } catch {
      return false;
    }
  }

  dismissIssue(): void {
    this.patchState({ issue: null });
  }

  /**
   * Where the selected page sits in the project, for an agent task: the app,
   * its toolchain versions, and the route files serving the page's URL. Read
   * fresh — routes are exactly what an agent adds while the panel is open.
   * Null when the model can't be read; the task then goes without.
   */
  async pagePlace(selection: SiteSelection): Promise<PagePlace | null> {
    try {
      // Optional context: a slow project scan must not hold the request up.
      const raw = await Promise.race([
        this.deps.invoke(CHANNELS.projectModel, {
          workspaceSessionId: selection.workspaceSessionId,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PAGE_PLACE_TIMEOUT_MS)),
      ]);
      if (raw === null) return null;
      const parsed = ProjectModelResultSchema.safeParse(raw);
      if (!parsed.success) return null;
      const model = parsed.data;
      let pathname: string;
      try {
        pathname = new URL(selection.displayedUrl, "http://localhost").pathname;
      } catch {
        return null;
      }
      const { matchRoute } = await import("../shared/project/routeMatch.js");
      const worktreePath = this.context.worktreePath;
      return {
        appPath: worktreePath
          ? (worktreeRelative(model.appRoot, worktreePath, "") ?? "").replace(/\/$/, "")
          : "",
        versions: {
          svelte: model.versions.svelte,
          kit: model.versions.kit,
          tailwind: model.versions.tailwind,
        },
        // A base the config computes can't be stripped; no route is named then.
        route: model.basePath === null ? null : matchRoute(model.routes, pathname, model.basePath),
      };
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    // The builder is really over for this preview: nothing typed or in flight
    // for it may outlive it.
    cancelAgentRequests(this.panelId);
    forgetComposerMemories(this.panelId);
    this.clearReattach();
    this.clearConnectRetry();
    this.bindRequest++;
    const binding = this.state.binding;
    if (binding.status === "bound") {
      void this.deps.sitePreview.detach({ sessionId: binding.sessionId }).catch(() => undefined);
    }
    this.closeWorkspace();
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.listeners.clear();
  }
}

/**
 * The builder for one dev preview, as the host's session for its Site Builder
 * tool. The host owns its lifetime — created when the builder is switched on,
 * kept across surface unmounts, disposed when the tool goes off or the preview
 * or plugin does — so nothing here reconstructs those events.
 */
export function createBuilderSession(
  context: DevPreviewToolSessionContext,
  deps: (previewPanelId: string) => InspectorDeps = defaultInspectorDeps
): InspectorController {
  // The chunk can land after the host let this preview go. Disposing what we
  // would build here cancels agent requests and forgets composer drafts for the
  // whole panel — which by then may belong to the next session.
  if (context.signal.aborted) throw new Error("The Site Builder was switched off while it loaded");
  const controller = new InspectorController(context.panelId, deps(context.panelId));
  controller.update(context);
  return controller;
}
