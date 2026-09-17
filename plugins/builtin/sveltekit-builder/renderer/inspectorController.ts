import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  SiteGuestNodeObservation,
  SitePreviewBindingState,
  SitePreviewCandidate,
  SitePreviewDetachReason,
  SitePreviewMode,
  SitePreviewPushPayload,
} from "@shared/types/ipc/sitePreview";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
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
  BUILDER_TOOL_ID,
  CHANNELS,
  ClassCompleteResultSchema,
  ClassDescribeResultSchema,
  ClassConflictsResultSchema,
  type ClassConflicts,
  TailwindStatusResultSchema,
  type ClassDescription,
  ComponentDefinitionsResultSchema,
  SourceRevisionsResultSchema,
  ProjectModelResultSchema,
  EditApplyResultSchema,
  EditUndoResultSchema,
  IssuePushSchema,
  PLUGIN_ID,
  PUSH_CHANNELS,
  SelectionResolveResultSchema,
  SourceChangedPushSchema,
  WorkspaceOpenResultSchema,
  type SupportVerdict,
} from "../shared/protocol.js";
import type {
  EditOperation,
  EditReceipt,
  SelectedNode,
  SiteEditErrorCode,
  SiteSelection,
  Viewport,
} from "../shared/model.js";

/**
 * One controller per dev preview with the Site Builder switched on. It holds
 * the preview binding, the source workspace, the selection and the last receipt
 * (with its Undo), and ends shortly after the builder's UI is gone.
 *
 * Every piece of preview state is keyed on the document epoch an observation
 * carries, never on arrival order: a reinstalled runtime's `documentReady` can
 * reach us before the `epoch-advanced` push for the same epoch.
 */

export interface SitePreviewApi {
  listCandidates(): Promise<SitePreviewCandidate[]>;
  bind(request: {
    panelId: string;
    runtimeSource: string;
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
    /** The component call site to keep selected, when the user had widened to one. */
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
  runtimeSource(): Promise<string>;
  newId(): string;
  now(): number;
  /** Calls back when this plugin is disabled; main has already closed every workspace. */
  onPluginDisabled(callback: () => void): () => void;
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
      /** Direct editing: decided by the Svelte and Kit versions alone. */
      support: SupportVerdict;
      /** Class suggestions and inspection: decided by the Tailwind loader, separately. */
      tailwind: TailwindAwareness;
      /** Every app the worktree holds, when there is more than one to switch between. */
      appRoots: string[];
    }
  | { status: "ambiguous"; appRoots: string[] }
  | { status: "no-app" }
  | { status: "failed"; message: string };

export type TailwindAwareness =
  | { status: "checking" }
  | { status: "available"; skippedModules: string[] }
  | { status: "unavailable"; reason: string; unused: boolean };

export interface PageState {
  epoch: number;
  routeId: string | null;
  url: string;
  viewport: Viewport;
}

export type StaleReason = "document-changed" | "source-changed" | "edited" | "preview-detached";

/** Who moved the page's selection; what recovery after a write is allowed to answer. */
export type SelectionCause = "user" | "document" | "reselect";

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

export type EditSurface = "text" | "classes";

/**
 * What a re-proof after this panel's own write has to match to count as a
 * continuation of the selection rather than a new one: the same file, the
 * same tag, and the revision the write produced. `prior` is what to put back
 * if it does not, or if the page never answers.
 */
interface Continuity {
  /** Worktree-relative, as the write receipt and `ReadySelection.file` are. */
  file: string;
  afterRevision: string;
  tagName: string;
  loc: { file: string; line: number; column: number };
  locIndex: number;
  /** What the page reported the element as; the reselect names it first. */
  occurrence: string;
  prior: Extract<SelectionState, { status: "ready" }> | null;
  attempts: number;
  /** When the write landed; empty observations inside the window are HMR, not the user. */
  at: number;
}

export type EditState =
  | { status: "idle" }
  | { status: "applying"; surface: EditSurface }
  | { status: "no-op"; surface: EditSurface }
  | { status: "failed"; surface: EditSurface; title: string; detail: string };

export type UndoState =
  | { status: "available" }
  | { status: "pending" }
  | { status: "superseded" }
  | { status: "failed"; message: string };

export interface ReceiptState {
  kind: "edit" | "undo";
  surface: EditSurface;
  receipt: EditReceipt;
  workspaceSessionId: string;
  /** The preview binding current at write time; only its later documents prove a refresh. */
  previewSessionId: string | null;
  /** The epoch that was current when the write returned. */
  epochAtWrite: number | null;
  /** Proven only by a `documentReady` from a later epoch. */
  previewRefreshed: boolean;
  undo: UndoState | null;
  /**
   * What the write asked for and main applied, from the value the panel was
   * showing: removed and added class tokens, or the text before and after.
   * Null when the panel didn't hold the previous value.
   */
  change: ReceiptChange | null;
}

export type ReceiptChange =
  | { surface: "classes"; removed: string[]; added: string[] }
  | { surface: "text"; before: string; after: string };

export interface InspectorIssue {
  severity: "warning" | "error";
  message: string;
  /** The page's own verdict, when it came from the page. */
  code?: string;
}

/** How long an agent request waits for the route files before going without them. */
const PAGE_PLACE_TIMEOUT_MS = 3_000;

/** Matches `ClassDescribeArgsSchema`. */
const MAX_DESCRIBED_TOKEN = 2048;

/** Page verdicts that a traced element disproves. */
const MAPPING_ISSUES = new Set(["no-svelte-meta", "not-dev-build"]);

export interface InspectorState {
  binding: BindingState;
  mode: SitePreviewMode;
  modePending: boolean;
  /** Highest document epoch observed for the bound session. */
  epoch: number | null;
  page: PageState | null;
  workspace: WorkspaceState;
  selection: SelectionState;
  edit: EditState;
  receipt: ReceiptState | null;
  issue: InspectorIssue | null;
  /** A write or undo is in flight. Independent of selection, which can change under it. */
  mutating: boolean;
  /**
   * The page is being asked to select the edited element again, so a fresh
   * observation can re-prove it. The selection is stale meanwhile — its ranges
   * are spent — but the panel need not say so for the hundred milliseconds it
   * takes the page to answer.
   */
  reselecting: boolean;
  /**
   * Advances on every selection that is NOT a continuation of the previous
   * one. Editors key on it, so a re-proof after a write keeps them mounted —
   * and the class input keeps focus — while a genuinely new selection starts
   * them clean.
   */
  selectionGeneration: number;
}

export type ClassCompletion =
  | { status: "ok"; candidates: Array<{ candidate: string; css: string }> }
  | { status: "unavailable"; reason: string };

export const INITIAL_INSPECTOR_STATE: InspectorState = {
  binding: { status: "idle" },
  // Turning the builder on is asking to pick something.
  mode: "select",
  modePending: false,
  epoch: null,
  page: null,
  workspace: { status: "idle" },
  selection: { status: "none" },
  edit: { status: "idle" },
  receipt: null,
  issue: null,
  mutating: false,
  reselecting: false,
  selectionGeneration: 0,
};

const MAX_BUFFERED_EVENTS = 64;

/** Detaches the host causes on its own, as opposed to the user or another inspector. */
const REATTACH_REASONS: ReadonlySet<SitePreviewDetachReason> = new Set([
  "guest-destroyed",
  "debugger-detached",
]);
const REATTACH_DELAY_MS = 300;
/** How long the page gets to answer a reselect before the stale notice shows after all. */
const RESELECT_SETTLE_MS = 1500;
/** An empty observation this soon after our write is HMR replacing the node, not the user. */
const CONTINUITY_WINDOW_MS = 10_000;
/** HMR patches the DOM a beat after the write lands; asking again immediately finds nothing. */
const CONTINUITY_RETRY_DELAY_MS = 150;
const CONTINUITY_MAX_RETRIES = 2;
/** About two minutes in all: long enough for a cold dev server to serve its first page. */
const CONNECT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];

// Loaded on first bind, not at module evaluation: the runtime is only needed
// once a preview is attached, and it serialises its own factory to source text.
export async function loadGuestRuntimeBody(): Promise<string> {
  const { buildGuestRuntimeBody } = await import("./guest/source.js");
  return buildGuestRuntimeBody();
}

const RUNTIME_ISSUE_COPY: Record<string, string> = {
  "no-svelte-meta":
    "This page carries no Svelte source locations. Run the app with the Vite dev server to select elements.",
  "not-dev-build": "This preview is a production build, so elements can't be traced to source",
  "overlay-blocked": "The page blocked the selection overlay",
  internal: "The inspector hit a problem inside the page",
};

const EDIT_ERROR_TITLES: Record<SiteEditErrorCode, string> = {
  STALE_SOURCE: "Not saved — the file changed",
  UNSUPPORTED_EXPRESSION: "Not saved — this value is an expression",
  AMBIGUOUS_INVOCATION: "Not saved — more than one source could own this",
  NODE_NOT_FOUND: "Not saved — the element wasn't found in source",
  INVALID_CANDIDATE: "Not saved — that class isn't valid here",
  UNSUPPORTED_ATTRIBUTE: "Not saved — this attribute can't be edited",
  GENERATED_FILE: "Not saved — the source is a generated file",
  OUT_OF_SCOPE: "Not saved — the file is outside this worktree",
  WRITER_BUSY: "Not saved — another write is in progress",
  PERMISSION_REQUIRED: "Not saved — permission is required",
  PARSE_FAILED: "Not saved — the file couldn't be parsed",
};

export function defaultInspectorDeps(): InspectorDeps {
  return {
    sitePreview: window.electron.sitePreview,
    invoke: (channel, args) => window.electron.plugin.invoke(PLUGIN_ID, channel, args),
    on: (channel, callback) => window.electron.plugin.on(PLUGIN_ID, channel, callback),
    runtimeSource: loadGuestRuntimeBody,
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
    onPluginDisabled: (callback) => {
      const store = usePluginRuntimeStore;
      store.getState().init();
      return store.subscribe((state, previous) => {
        if (state.disabledPluginIds.has(PLUGIN_ID) && !previous.disabledPluginIds.has(PLUGIN_ID)) {
          callback();
        }
      });
    },
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

/**
 * Only what can't be a single token at all. Whether a token is a class the
 * project can use is main's call — the renderer's guess rejected valid
 * variants like `[&>*]:p-2`.
 */
export function isClassTokenShape(token: string): boolean {
  return token.length > 0 && !ASCII_WHITESPACE.test(token);
}

/** Main's token separators: ASCII whitespace only, so U+00A0 stays inside a token. */
const ASCII_WHITESPACE = /[ \t\n\f\r]/;

export function splitClassTokens(value: string): string[] {
  return value.split(/[ \t\n\f\r]+/).filter((token) => token.length > 0);
}

/** How long after a source change a click may still land on the pre-HMR DOM. */
export const HMR_SETTLE_MS = 1000;

export class InspectorController {
  readonly panelId: string;
  /** Set by the registry: a disabled plugin releases the whole controller. */
  onPluginDisabled: (() => void) | null = null;
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

  constructor(
    panelId: string,
    private readonly deps: InspectorDeps
  ) {
    this.panelId = panelId;
    this.unsubscribers.push(
      deps.sitePreview.onEvent((payload) => this.handlePreviewPush(payload)),
      deps.on(PUSH_CHANNELS.sourceChanged, (payload) => this.handleSourceChanged(payload)),
      deps.on(PUSH_CHANNELS.issue, (payload) => this.handleIssue(payload)),
      deps.onPluginDisabled(() => this.onPluginDisabled?.())
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): InspectorState => this.state;

  private update(patch: Partial<InspectorState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /* ------------------------------------------------------------------------ */
  /* Context and workspace                                                    */
  /* ------------------------------------------------------------------------ */

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
      this.update({ workspace: { status: "no-worktree" } });
      return;
    }
    void this.openWorkspace();
  }

  /**
   * Where the selection is written, for keeping it through this panel's own
   * writes and the reload they cause. Updated from every proven resolution;
   * consulted only when a write is pending a refresh.
   */
  private continuity: Continuity | null = null;
  /** The apps a worktree offered when it held more than one. */
  private knownAppRoots: string[] = [];
  /** The document class awareness was last asked about; a different one asks again. */
  private tailwindCheckedDocument: string | null = null;
  private tailwindRequest = 0;
  private reselectOnReady = false;
  private reselectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Identity of the reselect in flight; a user action moves it on and orphans late replies. */
  private reselectAttempt = 0;

  async openWorkspace(appRoot: string | undefined = this.chosenAppRoot): Promise<void> {
    this.chosenAppRoot = appRoot;
    const { projectId, worktreeId, worktreePath } = this.context;
    if (!projectId || !worktreeId || !worktreePath) return;
    const request = ++this.workspaceRequest;
    // A preview moved between worktrees keeps running its server from the old
    // one: the page would show one checkout while edits and agents go to another.
    const cwd = (usePanelStore.getState().panelsById[this.panelId] as { cwd?: unknown } | undefined)
      ?.cwd;
    if (typeof cwd === "string" && cwd.length > 0 && !isWithin(worktreePath, cwd)) {
      this.update({
        workspace: {
          status: "failed",
          message:
            "This preview's dev server runs from another worktree. Restart it from this worktree to trace elements.",
        },
      });
      return;
    }
    this.update({ workspace: { status: "opening" } });
    try {
      const raw = await this.deps.invoke(CHANNELS.workspaceOpen, {
        projectId,
        worktreeId,
        worktreePath,
        ...(appRoot ? { appRoot } : {}),
      });
      const result = WorkspaceOpenResultSchema.parse(raw);
      if (request !== this.workspaceRequest) {
        if (result.status === "ready") this.releaseWorkspace(result.workspaceSessionId);
        return;
      }
      switch (result.status) {
        case "ready":
          this.update({
            workspace: {
              status: "ready",
              workspaceSessionId: result.workspaceSessionId,
              appRoot: result.appRoot,
              support: result.support,
              tailwind: { status: "checking" },
              appRoots: this.knownAppRoots.includes(result.appRoot) ? this.knownAppRoots : [],
            },
          });
          void this.checkTailwind(result.workspaceSessionId);
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
          this.update({ workspace: { status: "ambiguous", appRoots: result.appRoots } });
          return;
        }
        case "no-app":
          this.update({ workspace: { status: "no-app" } });
          return;
      }
    } catch (error) {
      if (request !== this.workspaceRequest) return;
      this.update({
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
   * Point the builder at another app in the same worktree. Everything proven
   * against the old one — selection, receipt, Undo — belongs to it and goes.
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
    this.reselectOnReady = false;
    this.clearReselectTimer();
    const workspace = this.state.workspace;
    if (workspace.status === "ready") this.releaseWorkspace(workspace.workspaceSessionId);
    // Source identity and undo both belong to the workspace that minted them.
    this.update({
      workspace: { status: "idle" },
      selection: this.state.selection.status === "none" ? this.state.selection : { status: "none" },
      edit: { status: "idle" },
      receipt: null,
      // A write still out belongs to the workspace being left; its reply is
      // discarded on arrival, so it mustn't hold the next workspace's edits.
      mutating: false,
    });
  }

  private currentWorkspaceId(): string | null {
    const workspace = this.state.workspace;
    return workspace.status === "ready" ? workspace.workspaceSessionId : null;
  }

  /**
   * Main no longer holds our workspace (plugin disabled and re-enabled, or its
   * worker restarted), so its selection and undo journal are gone too. Reopen
   * once per lost session; a second failure is reported, not looped on.
   */
  private recoverClosedWorkspace(workspaceSessionId: string): void {
    if (this.currentWorkspaceId() !== workspaceSessionId) return;
    if (this.recoveringWorkspace === workspaceSessionId) return;
    this.recoveringWorkspace = workspaceSessionId;
    this.selectionRequest++;
    this.update({
      workspace: { status: "idle" },
      selection: { status: "none" },
      edit: { status: "idle" },
      receipt: null,
      mutating: false,
    });
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
    this.update({
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
      const runtimeSource = await this.deps.runtimeSource();
      if (request !== this.bindRequest) return;
      state = await this.deps.sitePreview.bind({
        panelId: previewPanelId,
        runtimeSource,
        mode: this.state.mode,
      });
    } catch (error) {
      if (request !== this.bindRequest) return;
      this.bufferedEvents = [];
      // Most failures are a preview that has no page yet: it is starting, or
      // the grid is recreating it. Keep trying for a while rather than leaving
      // the user to guess when to press Retry.
      const retrying = this.scheduleConnectRetry(previewPanelId, request);
      this.update({
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
    this.update({
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
    this.update({
      binding: { status: "detached", panelId: binding.panelId, reason: "requested" },
      ...this.staleSelectionPatch("preview-detached"),
    });
    await this.deps.sitePreview.detach({ sessionId: binding.sessionId }).catch(() => undefined);
  }

  async setMode(mode: SitePreviewMode): Promise<void> {
    const binding = this.state.binding;
    if (binding.status !== "bound" || mode === this.state.mode) return;
    const previous = this.state.mode;
    this.update({ mode, modePending: true });
    try {
      const next = await this.deps.sitePreview.setMode({ sessionId: binding.sessionId, mode });
      if (!this.isBoundTo(binding.sessionId)) return;
      this.noteEpoch(next.documentEpoch);
      this.update({ mode: next.mode, modePending: false });
    } catch (error) {
      if (!this.isBoundTo(binding.sessionId)) return;
      this.update({
        mode: previous,
        modePending: false,
        issue: {
          severity: "error",
          message: formatErrorMessage(error, "Couldn't switch the preview mode"),
        },
      });
    }
  }

  private isBoundTo(sessionId: string): boolean {
    const binding = this.state.binding;
    return binding.status === "bound" && binding.sessionId === sessionId;
  }

  private handlePreviewPush(payload: SitePreviewPushPayload): void {
    const binding = this.state.binding;
    if (binding.status === "binding") {
      // Hover traffic is worthless after the fact; keep the newest of the rest,
      // since readiness and epoch pushes are what the replay needs most.
      if (payload.kind === "guest-event" && payload.event.type === "hoverChanged") return;
      this.bufferedEvents.push(payload);
      if (this.bufferedEvents.length > MAX_BUFFERED_EVENTS) this.bufferedEvents.shift();
      return;
    }
    if (binding.status !== "bound" || payload.sessionId !== binding.sessionId) return;

    switch (payload.kind) {
      case "detached":
        this.bindRequest++;
        this.update({
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
    const receipt = this.state.receipt;
    const ourReload =
      receipt !== null &&
      !receipt.previewRefreshed &&
      receipt.epochAtWrite !== null &&
      epoch > receipt.epochAtWrite &&
      this.continuity !== null;
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
    // The reload this panel's own write caused. The ranges are spent, so the
    // selection is stale — but the element is still there in the new
    // document, and the page can be asked for it as soon as it has one.
    if (ourReload && (selection.status === "ready" || selection.status === "observed")) {
      patch.reselecting = true;
      this.reselectOnReady = true;
    }
    if (this.state.issue) patch.issue = null;
    this.update(patch);
  }

  private handleGuestEvent(
    payload: Extract<SitePreviewPushPayload, { kind: "guest-event" }>
  ): void {
    const epoch = payload.documentEpoch;
    this.noteEpoch(epoch);
    if (this.state.epoch !== null && epoch < this.state.epoch) return;

    const event = payload.event;
    switch (event.type) {
      case "documentReady": {
        const patch: Partial<InspectorState> = {
          page: { epoch, routeId: event.routeId, url: event.url, viewport: event.viewport },
        };
        const binding = this.state.binding;
        if (binding.status === "bound") patch.binding = { ...binding, url: event.url };
        const receipt = this.state.receipt;
        if (
          receipt &&
          !receipt.previewRefreshed &&
          receipt.epochAtWrite !== null &&
          receipt.previewSessionId === payload.sessionId &&
          epoch > receipt.epochAtWrite
        ) {
          patch.receipt = { ...receipt, previewRefreshed: true };
        }
        this.update(patch);
        // An install or a new stylesheet usually arrives with a dev-server
        // restart, which is a new document. Class awareness that failed is asked
        // again then, rather than reported unavailable for the whole session.
        const workspace = this.state.workspace;
        if (
          workspace.status === "ready" &&
          workspace.tailwind.status === "unavailable" &&
          this.tailwindCheckedDocument !== this.documentKey()
        ) {
          void this.checkTailwind(workspace.workspaceSessionId);
        }
        if (this.reselectOnReady) {
          this.reselectOnReady = false;
          void this.reselectNow();
        }
        return;
      }
      case "selectionChanged":
        this.clearDisprovedMappingIssue(event.nodes);
        void this.handleSelection(
          epoch,
          event.nodes,
          event.scope ?? "element",
          event.component ?? null,
          event.cause ?? "user"
        );
        return;
      case "runtimeIssue":
        this.update({
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
    }
  }

  /**
   * An element with a source location is proof of dev metadata, whatever the
   * page concluded earlier — a verdict reached while it was still hydrating
   * must not sit above a selection that plainly traced.
   */
  private clearDisprovedMappingIssue(nodes: SiteGuestNodeObservation[]): void {
    const code = this.state.issue?.code;
    if (code === undefined || !MAPPING_ISSUES.has(code)) return;
    if (nodes.some((node) => node.loc !== null)) this.update({ issue: null });
  }

  /* ------------------------------------------------------------------------ */
  /* Selection                                                                */
  /* ------------------------------------------------------------------------ */

  private async handleSelection(
    epoch: number,
    nodes: SiteGuestNodeObservation[],
    scope: "element" | "component" = "element",
    component: PickedComponent | null = null,
    cause: SelectionCause = "user"
  ): Promise<void> {
    const request = ++this.selectionRequest;
    this.changedDuringResolve.clear();
    const base: Partial<InspectorState> = {
      edit: this.state.edit.status === "applying" ? this.state.edit : { status: "idle" },
    };
    if (nodes.length === 0) {
      const continuity = this.continuity;
      if (
        cause !== "user" &&
        continuity !== null &&
        Date.now() - continuity.at < CONTINUITY_WINDOW_MS &&
        this.state.selection.status === "ready"
      ) {
        if (continuity.attempts < CONTINUITY_MAX_RETRIES) {
          // Same-document HMR replaced the selected node a beat after the write
          // landed and the page dropped its disconnected selection. The element
          // is back under the same location; ask again after the patch settles.
          // The retry belongs to this attempt: a user action in the meantime
          // retires it before it fires.
          continuity.attempts += 1;
          const attempt = this.reselectAttempt;
          this.update({ ...base, ...this.staleSelectionPatch("edited"), reselecting: true });
          setTimeout(() => {
            if (attempt === this.reselectAttempt) void this.reselectNow();
          }, CONTINUITY_RETRY_DELAY_MS);
          return;
        }
        // Out of retries: the element is not coming back. The page has nothing
        // selected; the drawer keeps the stale selection and says so.
        this.retireReselect();
        this.update({ ...base, ...this.staleSelectionPatch("edited"), reselecting: false });
        return;
      }
      // The user cleared it (Escape, a click on nothing): that is the answer,
      // whatever recovery was in flight.
      this.retireReselect();
      this.continuity = null;
      this.update({ ...base, selection: { status: "none" } });
      return;
    }
    const workspace = this.state.workspace;
    const page = this.state.page;
    const binding = this.state.binding;
    // A preview-only app is still traced: main marks every surface inspect-only,
    // and the selection can still go to an agent. Only direct edits are gated.
    if (workspace.status !== "ready" || binding.status !== "bound") {
      this.update({
        ...base,
        selection: { status: "observed", epoch, node: nodes[0]!, nodeCount: nodes.length },
      });
      return;
    }
    if (!page || page.epoch !== epoch) {
      this.update({
        ...base,
        selection: { status: "failed", message: "The page is still loading — select again" },
      });
      return;
    }

    // HMR doesn't advance the epoch, so right after a write the page can still
    // show the old markup while main resolves the click against the new bytes —
    // and lands on a different element of the same tag.
    const clickedFiles = nodes.flatMap((node) =>
      node.loc
        ? [worktreeRelative(workspace.appRoot, this.context.worktreePath, node.loc.file)]
        : []
    );
    // A reselect this controller asked for is exempt: it names the exact
    // location of the last proof, main re-proves it against the new bytes, and
    // the answer is checked below to still be the same element.
    if (
      !this.state.reselecting &&
      clickedFiles.some((file) => file !== null && this.changedRecently(file))
    ) {
      this.update({ ...base, selection: { status: "settling" } });
      return;
    }

    // What a reselect would be continuing. Read before the resolving state
    // replaces it, and put back if the re-proof turns out to name something else.
    const continuing = cause === "reselect" && this.state.reselecting && this.continuity !== null;
    // Only the page's answer to OUR reselect continues the edited selection. A
    // click of the user's own while it is out is theirs: it ends the recovery
    // and resolves as any fresh pick would.
    if (!continuing && this.state.reselecting) {
      this.retireReselect();
      this.continuity = null;
    }
    // A re-proof keeps the stale selection on screen — its controls are already
    // disabled — rather than swapping the editors out for a skeleton and back,
    // which unmounted the class input mid-loop and dropped its focus.
    if (!continuing) {
      this.update({
        ...base,
        selection: { status: "resolving", epoch, requestId: request },
        reselecting: false,
      });
    }
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
      this.update({
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
      this.update({
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
        this.update({ selection: { status: "lost" } });
        return;
      }
      if (changed !== null && this.changedRecently(changed)) {
        this.update({ selection: { status: "settling" } });
        return;
      }
      this.update({
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
      this.update({ selection: { status: "lost" } });
      return;
    }
    const selection = result.selection;
    const file = ownerFile(selection, this.context.worktreePath);
    // The observation predates the change, but main resolved it against the
    // newer bytes; the pairing can't be trusted, so the user selects again.
    if (file !== null && this.changedDuringResolve.has(file)) {
      // For a continuation the file moved under the re-proof itself: main's
      // answer is at the expected revision and already wrong.
      if (continuing && this.continuity !== null) {
        this.refuseContinuation(this.continuity, "source-changed");
        return;
      }
      this.update({ selection: { status: "lost" } });
      return;
    }
    // Same exemption as before the resolve: a reselect this controller asked
    // for is answered against the new bytes by main, and checked below.
    if (file !== null && this.changedRecently(file) && !this.state.reselecting) {
      this.update({ selection: { status: "settling" } });
      return;
    }
    // A re-proof must be of the same element: an edit that inserted lines
    // above it can make the old location name a different node in the new
    // source. A different tag, or a different file, is not a continuation —
    // the stale state stands and the user selects again.
    const after = selection.nodes[0]?.definition ?? null;
    if (continuing && this.continuity !== null) {
      const record = this.continuity;
      // Repeated markup shares file, tag and revision; only the occurrence
      // tells the cards apart, so a runtime that reports it has to agree too.
      const occurrence = nodes[0]?.locIndex;
      const continues =
        after !== null &&
        // Both worktree-relative: the record takes the write's receipt path,
        // and the page reports locations relative to the app.
        file === record.file &&
        after.tagName === record.tagName &&
        after.revision === record.afterRevision &&
        (occurrence === undefined || occurrence === record.locIndex);
      if (!continues) {
        // A fresh proof of SOME element is not a continuation of the one that
        // was edited. Refuse it, and take the page's highlight down with it so
        // page and drawer agree on what is selected: nothing new.
        this.refuseContinuation(record, this.staleReasonNow("edited"));
        return;
      }
    }
    this.clearReselectTimer();
    // The page reselects an element; what the user picked may have been the
    // component it roots. A continuation keeps that scope rather than quietly
    // narrowing the identity, and the agent's subject, to the element.
    const prior = this.state.selection;
    const keepsComponent = continuing && prior.status === "ready" && prior.scope === "component";
    const pickedScope = keepsComponent ? "component" : scope;
    const pickedComponent =
      keepsComponent && prior.status === "ready" ? prior.component : component;
    const location = after?.location ?? null;
    const generation = continuing
      ? this.state.selectionGeneration
      : this.state.selectionGeneration + 1;
    // Every proven selection can be continued through this panel's own writes
    // and the reload they cause; the record is refreshed by each write.
    // A copy the page couldn't place can't be asked for again: "the first one"
    // would be a guess, and past the page's scan bound even a count of one is
    // only a floor.
    const pickedOccurrence = nodes[0]?.locIndex;
    this.continuity =
      after !== null && location !== null && pickedOccurrence !== undefined
        ? {
            file: file ?? location.file,
            afterRevision: after.revision,
            tagName: after.tagName,
            loc: { ...location },
            locIndex: pickedOccurrence,
            occurrence: nodes[0]!.runtimeOccurrenceId,
            prior: null,
            attempts: 0,
            at: this.continuity?.at ?? 0,
          }
        : null;
    this.update({
      selection: {
        status: "ready",
        selection,
        file,
        stale: null,
        scope: pickedScope,
        component: pickedComponent,
        definitions: null,
        revisions: null,
      },
      reselecting: false,
      selectionGeneration: generation,
    });
    if (this.continuity !== null) {
      this.continuity.prior = this.state.selection.status === "ready" ? this.state.selection : null;
    }
    void this.resolveDefinitions(selection, pickedComponent);
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
    this.update({ selection: { ...current, ...facts } });
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
    // Our own writes aren't pushed back as sourceChanged, so a resolve that is
    // out when one lands must be invalidated here, however long it then takes.
    // A re-proof never shows as `resolving`; it is out while `reselecting`.
    if (this.state.selection.status === "resolving" || this.state.reselecting) {
      this.changedDuringResolve.add(file);
    }
  }

  /**
   * A user action ends whatever recovery is in flight: its guard timer, a
   * scheduled retry, and any reply still on the way, which will find the
   * attempt it belonged to is over.
   */
  private retireReselect(): void {
    this.reselectAttempt++;
    this.clearReselectTimer();
  }

  /**
   * What a refused or abandoned re-proof leaves on screen: the selection from
   * before the attempt, always stale. The prior captured after a successful
   * continuation was editable, and restoring it as it was would show live
   * controls for ranges the page no longer has selected.
   */
  private staleRollback(record: Continuity, reason: StaleReason): SelectionState {
    const current = this.state.selection;
    const prior = record.prior ?? (current.status === "ready" ? current : null);
    if (prior === null) return { status: "none" };
    return { ...prior, stale: reason };
  }

  /** The notice already showing, when there is one; otherwise the caller's. */
  private staleReasonNow(fallback: StaleReason): StaleReason {
    const current = this.state.selection;
    return current.status === "ready" && current.stale !== null ? current.stale : fallback;
  }

  private refuseContinuation(record: Continuity, reason: StaleReason): void {
    this.clearReselectTimer();
    const binding = this.state.binding;
    if (binding.status === "bound") {
      void this.deps.sitePreview
        .clearSelection({ sessionId: binding.sessionId })
        .catch(() => undefined);
    }
    this.update({ selection: this.staleRollback(record, reason), reselecting: false });
    this.continuity = null;
  }

  private isCurrentResolve(request: number): boolean {
    if (request !== this.selectionRequest) return false;
    // A re-proof this controller asked for never entered `resolving`: the
    // stale selection stayed on screen so its editors stayed mounted.
    if (this.state.reselecting && this.continuity !== null) return true;
    const selection = this.state.selection;
    return (
      request === this.selectionRequest &&
      selection.status === "resolving" &&
      selection.requestId === request
    );
  }

  private selectionFile(): string | null {
    const selection = this.state.selection;
    return selection.status === "ready" ? selection.file : null;
  }

  private boundSessionId(): string | null {
    const binding = this.state.binding;
    return binding.status === "bound" ? binding.sessionId : null;
  }

  private isSelection(selectionId: string): boolean {
    const selection = this.state.selection;
    return selection.status === "ready" && selection.selection.selectionId === selectionId;
  }

  /**
   * Ask the page for the element at the last proven location. A true answer
   * means a fresh `selectionChanged` is on its way and `handleSelection` will
   * re-prove it; anything else leaves the stale state — and its notice — as it
   * is. A guard timer does the same if the page goes quiet.
   */
  private async reselectNow(): Promise<void> {
    const record = this.continuity;
    const binding = this.state.binding;
    if (record === null || binding.status !== "bound") {
      this.update({ reselecting: false });
      return;
    }
    const attempt = ++this.reselectAttempt;
    this.clearReselectTimer();
    this.reselectTimer = setTimeout(() => {
      this.reselectTimer = null;
      if (attempt !== this.reselectAttempt || !this.state.reselecting) return;
      // The page went quiet. The attempt is over: any late resolve is
      // rejected, the stale selection is what stands, and it says so.
      this.selectionRequest++;
      this.update({
        selection: this.staleRollback(record, this.staleReasonNow("edited")),
        reselecting: false,
      });
    }, RESELECT_SETTLE_MS);
    let found: boolean;
    try {
      const picked = record.prior?.scope === "component" ? record.prior.component : null;
      found = await this.deps.sitePreview.reselect({
        sessionId: binding.sessionId,
        loc: record.loc,
        index: record.locIndex,
        occurrence: record.occurrence,
        ...(picked
          ? { component: { file: picked.file, line: picked.line, column: picked.column } }
          : {}),
      });
    } catch {
      found = false;
    }
    // A late answer to an attempt the user has since ended changes nothing.
    if (!found && attempt === this.reselectAttempt) {
      this.clearReselectTimer();
      this.update({
        selection: this.staleRollback(record, this.staleReasonNow("edited")),
        reselecting: false,
      });
    }
  }

  private clearReselectTimer(): void {
    if (this.reselectTimer !== null) {
      clearTimeout(this.reselectTimer);
      this.reselectTimer = null;
    }
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
    const edit = this.state.edit;
    if (edit.status === "no-op") patch.edit = { status: "idle" };
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
      this.update(this.staleSelectionPatch("source-changed"));
    }
  }

  private handleIssue(raw: unknown): void {
    const parsed = IssuePushSchema.safeParse(raw);
    if (!parsed.success) return;
    this.update({ issue: { severity: parsed.data.severity, message: parsed.data.message } });
  }

  /**
   * Whether a component on the trail can be selected right now — the one rule
   * the crumbs and {@link selectComponent} share, so a crumb is never a button
   * that does nothing. The page only answers a selection request in Select
   * mode; a stale trail describes an element the page no longer shows; a
   * re-proof out for an edit would claim the answer as its own; and a
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
      !state.reselecting &&
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
   * The page answers with `cause: "reselect"`, which only reads as the
   * continuation of an edited selection while a re-proof is out; the pick is
   * refused while one is, and any timer of the last one is retired, so the
   * answer is taken for what it is: the user's choice. False when the pick
   * can't be made ({@link canSelectComponent}) or the page no longer has the
   * element.
   */
  async selectComponent(usedAt: CallSite): Promise<boolean> {
    const record = this.continuity;
    const binding = this.state.binding;
    if (record === null || binding.status !== "bound" || !this.canSelectComponent()) {
      return false;
    }
    this.retireReselect();
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
    this.update({ issue: null });
  }

  /* ------------------------------------------------------------------------ */
  /* Editing                                                                  */
  /* ------------------------------------------------------------------------ */

  addClasses(selectionId: string, tokens: string[]): Promise<boolean> {
    return this.replaceClasses(selectionId, [], tokens);
  }

  removeClass(selectionId: string, token: string): Promise<boolean> {
    return this.replaceClasses(selectionId, [token], []);
  }

  /**
   * One intention, one write: `px-6` becomes `px-8` as a single transaction
   * and a single Undo, never a removal and an addition with a moment between
   * them where the element has neither.
   */
  replaceClasses(selectionId: string, remove: string[], add: string[]): Promise<boolean> {
    const target = editTargetOf(this.state, "classes", selectionId);
    const classes = target?.node.surfaces.classes;
    if (!target || !classes) return Promise.resolve(false);
    const existing = new Set(classes.tokens);
    const removing = [...new Set(remove)].filter((token) => existing.has(token));
    const adding = [...new Set(add)].filter(
      (token) => isClassTokenShape(token) && (!existing.has(token) || removing.includes(token))
    );
    const net = adding.filter((token) => !removing.includes(token));
    const dropped = removing.filter((token) => !adding.includes(token));
    if (net.length === 0 && dropped.length === 0) return Promise.resolve(false);
    return this.apply(
      "classes",
      selectionId,
      [
        {
          kind: "set_class_tokens",
          range: target.node.definition!.range,
          add: net,
          remove: dropped,
          responsive: { kind: "base" },
        },
      ],
      { surface: "classes", removed: dropped, added: net }
    );
  }

  setText(selectionId: string, text: string): Promise<boolean> {
    const target = editTargetOf(this.state, "text", selectionId);
    const current = target?.node.surfaces.text;
    if (!target || !current) return Promise.resolve(false);
    if (text.trim().length === 0 || text === current.text) return Promise.resolve(false);
    return this.apply(
      "text",
      selectionId,
      [{ kind: "set_literal_text", range: target.node.definition!.range, text }],
      { surface: "text", before: current.text, after: text }
    );
  }

  private async apply(
    surface: EditSurface,
    selectionId: string,
    operations: EditOperation[],
    change: ReceiptChange
  ): Promise<boolean> {
    const target = editTargetOf(this.state, surface, selectionId);
    if (!target) return false;
    const definition = target.node.definition!;
    // Witness and workspace are fixed now, not when the reply lands: by then the
    // panel may show another worktree and another preview.
    const previewSessionId = this.boundSessionId();
    this.update({ edit: { status: "applying", surface }, mutating: true });
    const done = await this.write(target, definition, operations);
    return this.settle(surface, selectionId, target, previewSessionId, done, change);
  }

  private async write(
    target: EditTarget,
    definition: NonNullable<SelectedNode["definition"]>,
    operations: EditOperation[]
  ): Promise<{ raw: unknown } | { error: unknown }> {
    try {
      return {
        raw: await this.deps.invoke(CHANNELS.editApply, {
          workspaceSessionId: target.workspaceSessionId,
          file: target.file,
          expectedRevision: definition.revision,
          operations,
          affectedOccurrences: definition.renderedOccurrences,
          idempotencyKey: this.deps.newId(),
        }),
      };
    } catch (error) {
      return { error };
    }
  }

  private settle(
    surface: EditSurface,
    selectionId: string,
    target: EditTarget,
    previewSessionId: string | null,
    done: { raw: unknown } | { error: unknown },
    change: ReceiptChange
  ): boolean {
    if (this.currentWorkspaceId() !== target.workspaceSessionId) {
      // The reply belongs to a workspace this panel has left; its receipt and
      // Undo would point at a journal the current workspace doesn't hold.
      return false;
    }
    this.update({ mutating: false });
    if ("error" in done && isWorkspaceClosed(done.error)) {
      this.recoverClosedWorkspace(target.workspaceSessionId);
      return false;
    }
    if ("error" in done) {
      this.update({
        edit: this.isSelection(selectionId)
          ? {
              status: "failed",
              surface,
              title: "Not saved",
              detail: formatErrorMessage(done.error, "The change couldn't be written"),
            }
          : { status: "idle" },
      });
      return false;
    }
    const raw = done.raw;
    const parsed = EditApplyResultSchema.safeParse(raw);
    if (!parsed.success) {
      this.update({
        edit: this.isSelection(selectionId)
          ? {
              status: "failed",
              surface,
              title: "Not saved",
              detail: "The source didn't confirm the change",
            }
          : { status: "idle" },
      });
      return false;
    }
    const result = parsed.data;
    if (result.status === "error" && isWorkspaceClosed(result)) {
      this.recoverClosedWorkspace(target.workspaceSessionId);
      return false;
    }
    const stillSelected = this.isSelection(selectionId);
    switch (result.status) {
      case "applied":
        this.noteChanged(result.receipt.file);
        this.update({
          edit: { status: "idle" },
          receipt: {
            kind: "edit",
            surface,
            receipt: result.receipt,
            workspaceSessionId: target.workspaceSessionId,
            previewSessionId,
            epochAtWrite: this.state.epoch,
            previewRefreshed: false,
            undo: { status: "available" },
            change,
          },
          // The file's bytes moved, so every range held against it is spent —
          // including a newer selection that resolved while the write was out.
          ...(stillSelected || this.selectionFile() === result.receipt.file
            ? this.staleSelectionPatch("edited")
            : {}),
          // …and the page is asked for the element again, so main can re-prove
          // it. The stale patch above stands until that proof arrives.
          reselecting: stillSelected && this.continuity !== null,
        });
        if (stillSelected && this.continuity !== null) {
          // The record is bound to THIS write: a re-proof continues the
          // selection only if it comes back at the revision main just wrote.
          const prior = this.state.selection;
          this.continuity = {
            ...this.continuity,
            file: result.receipt.file,
            afterRevision: result.receipt.afterRevision,
            prior: prior.status === "ready" ? prior : this.continuity.prior,
            attempts: 0,
            at: Date.now(),
          };
          void this.reselectNow();
        }
        return true;
      case "no-op":
        this.update({ edit: stillSelected ? { status: "no-op", surface } : { status: "idle" } });
        return true;
      case "conflict":
        this.update({
          edit: stillSelected
            ? {
                status: "failed",
                surface,
                title: EDIT_ERROR_TITLES.STALE_SOURCE,
                detail: `${target.file} changed after you selected this element. Select it again to edit the current source.`,
              }
            : { status: "idle" },
          ...(stillSelected ? this.staleSelectionPatch("source-changed") : {}),
        });
        return false;
      case "error":
        this.update({
          edit: stillSelected
            ? {
                status: "failed",
                surface,
                title: EDIT_ERROR_TITLES[result.code],
                detail: result.message,
              }
            : { status: "idle" },
          ...(stillSelected && result.code === "STALE_SOURCE"
            ? this.staleSelectionPatch("source-changed")
            : {}),
        });
        return false;
    }
  }

  async undo(): Promise<void> {
    const receipt = this.state.receipt;
    const workspace = this.state.workspace;
    if (!receipt || receipt.kind !== "edit" || !receipt.undo) return;
    if (receipt.undo.status === "pending" || receipt.undo.status === "superseded") return;
    if (this.state.mutating) return;
    if (
      workspace.status !== "ready" ||
      workspace.workspaceSessionId !== receipt.workspaceSessionId
    ) {
      return;
    }
    const transactionId = receipt.receipt.transactionId;
    const workspaceSessionId = receipt.workspaceSessionId;
    const previewSessionId = this.boundSessionId();
    this.update({ receipt: { ...receipt, undo: { status: "pending" } }, mutating: true });

    let raw: unknown;
    try {
      raw = await this.deps.invoke(CHANNELS.editUndo, {
        workspaceSessionId: receipt.workspaceSessionId,
        transactionId,
      });
    } catch (error) {
      if (this.currentWorkspaceId() !== workspaceSessionId) return;
      this.update({ mutating: false });
      if (isWorkspaceClosed(error)) return this.recoverClosedWorkspace(workspaceSessionId);
      this.patchUndo(transactionId, {
        status: "failed",
        message: formatErrorMessage(error, "The edit couldn't be undone"),
      });
      return;
    }
    if (this.currentWorkspaceId() !== workspaceSessionId) return;
    this.update({ mutating: false });
    const parsed = EditUndoResultSchema.safeParse(raw);
    if (!parsed.success) {
      this.patchUndo(transactionId, {
        status: "failed",
        message: "The source didn't confirm the undo",
      });
      return;
    }
    const result = parsed.data;
    if (result.status === "superseded") {
      this.patchUndo(transactionId, { status: "superseded" });
      return;
    }
    if (result.status === "error" && isWorkspaceClosed(result)) {
      return this.recoverClosedWorkspace(workspaceSessionId);
    }
    if (result.status === "error") {
      this.patchUndo(transactionId, { status: "failed", message: result.message });
      return;
    }
    const current = this.state.receipt;
    if (current?.receipt.transactionId !== transactionId) return;
    this.noteChanged(result.receipt.file);
    this.update({
      receipt: {
        kind: "undo",
        surface: current.surface,
        receipt: result.receipt,
        workspaceSessionId: current.workspaceSessionId,
        previewSessionId,
        epochAtWrite: this.state.epoch,
        previewRefreshed: false,
        undo: null,
        change: current.change,
      },
      ...(this.selectionFile() === result.receipt.file
        ? this.staleSelectionPatch("source-changed")
        : {}),
    });
  }

  private patchUndo(transactionId: string, undo: UndoState): void {
    const current = this.state.receipt;
    if (current?.receipt.transactionId !== transactionId) return;
    this.update({ receipt: { ...current, undo } });
  }

  async completeClasses(query: string): Promise<ClassCompletion> {
    const workspace = this.state.workspace;
    if (workspace.status !== "ready") {
      return { status: "unavailable", reason: "The site source isn't open" };
    }
    try {
      const raw = await this.deps.invoke(CHANNELS.classComplete, {
        workspaceSessionId: workspace.workspaceSessionId,
        query: query.slice(0, 128),
        limit: 50,
      });
      const parsed = ClassCompleteResultSchema.safeParse(raw);
      if (!parsed.success) return { status: "unavailable", reason: "Class list unavailable" };
      if (parsed.data.status === "unavailable" && isWorkspaceClosed(parsed.data)) {
        this.recoverClosedWorkspace(workspace.workspaceSessionId);
      }
      return parsed.data;
    } catch (error) {
      return {
        status: "unavailable",
        reason: formatErrorMessage(error, "Class list unavailable"),
      };
    }
  }

  /** Asks main whether class awareness works here; answers only the workspace that asked. */
  /** Which document of which preview binding the page state describes. */
  private documentKey(): string {
    return `${this.boundSessionId() ?? ""}:${this.state.page?.epoch ?? ""}`;
  }

  private async checkTailwind(workspaceSessionId: string): Promise<void> {
    const request = ++this.tailwindRequest;
    const askedFor = this.documentKey();
    this.tailwindCheckedDocument = askedFor;
    let tailwind: TailwindAwareness;
    try {
      const raw = await this.deps.invoke(CHANNELS.tailwindStatus, { workspaceSessionId });
      const parsed = TailwindStatusResultSchema.safeParse(raw);
      tailwind = parsed.success
        ? parsed.data
        : { status: "unavailable", reason: "Class awareness didn't answer", unused: false };
    } catch (error) {
      tailwind = {
        status: "unavailable",
        reason: formatErrorMessage(error, "Class awareness didn't answer"),
        unused: false,
      };
    }
    const workspace = this.state.workspace;
    if (request !== this.tailwindRequest) return;
    if (workspace.status !== "ready" || workspace.workspaceSessionId !== workspaceSessionId) return;
    this.update({ workspace: { ...workspace, tailwind } });
    // A new document arrived while this was out — often the restart after an
    // install. Its answer predates that document, so a failure is asked again.
    if (tailwind.status === "unavailable" && this.documentKey() !== askedFor) {
      void this.checkTailwind(workspaceSessionId);
    }
  }

  /** Existing tokens the candidates would override; unavailable means "don't know", not "none". */
  async classConflicts(existing: string[], candidates: string[]): Promise<ClassConflicts> {
    const workspace = this.state.workspace;
    if (workspace.status !== "ready") {
      return { status: "unavailable", reason: "The site source isn't open" };
    }
    const bounded = (tokens: string[]) => tokens.filter((token) => token.length <= 2048);
    try {
      const raw = await this.deps.invoke(CHANNELS.classConflicts, {
        workspaceSessionId: workspace.workspaceSessionId,
        existing: bounded(existing).slice(0, 256),
        candidates: bounded(candidates).slice(0, 32),
      });
      const parsed = ClassConflictsResultSchema.safeParse(raw);
      return parsed.success
        ? parsed.data
        : { status: "unavailable", reason: "Class analysis unavailable" };
    } catch (error) {
      return {
        status: "unavailable",
        reason: formatErrorMessage(error, "Class analysis unavailable"),
      };
    }
  }

  /** What one class token generates in this project, asked exactly rather than searched for. */
  async describeClass(token: string): Promise<ClassDescription> {
    const workspace = this.state.workspace;
    if (workspace.status !== "ready") {
      return { status: "unavailable", reason: "The site source isn't open", unused: false };
    }
    // Never a shortened token: a cut arbitrary value is a different class, and
    // "generates nothing" about it would be a claim about something else.
    if (token.length > MAX_DESCRIBED_TOKEN) {
      return {
        status: "unavailable",
        reason: "This class is too long to inspect here",
        unused: false,
      };
    }
    try {
      const raw = await this.deps.invoke(CHANNELS.classDescribe, {
        workspaceSessionId: workspace.workspaceSessionId,
        token,
      });
      const parsed = ClassDescribeResultSchema.safeParse(raw);
      if (!parsed.success) {
        return { status: "unavailable", reason: "Class details unavailable", unused: false };
      }
      if (parsed.data.status === "unavailable" && isWorkspaceClosed(parsed.data)) {
        this.recoverClosedWorkspace(workspace.workspaceSessionId);
      }
      return parsed.data;
    } catch (error) {
      return {
        status: "unavailable",
        reason: formatErrorMessage(error, "Class details unavailable"),
        unused: false,
      };
    }
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
    this.clearReselectTimer();
    if (this.disposed) return;
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

export interface EditTarget {
  workspaceSessionId: string;
  file: string;
  selection: SiteSelection;
  node: SelectedNode;
}

/**
 * Everything an edit needs, or null. The view disables its controls from this
 * same function, but the controller calls it again before every write — a click
 * that raced a stale transition still cannot reach `editApply`.
 */
export function editTargetOf(
  state: InspectorState,
  surface: EditSurface,
  /** The selection the user was looking at when they acted; a newer one never inherits the edit. */
  selectionId?: string
): EditTarget | null {
  const { workspace, selection, binding, edit, epoch } = state;
  if (binding.status !== "bound" || workspace.status !== "ready") return null;
  if (workspace.support.level !== "full") return null;
  if (selection.status !== "ready" || selection.stale !== null || !selection.file) return null;
  if (selectionId !== undefined && selection.selection.selectionId !== selectionId) return null;
  if (selection.selection.documentEpoch !== epoch) return null;
  if (selection.selection.nodes.length !== 1) return null;
  if (state.mutating || edit.status === "applying") return null;
  const node = selection.selection.nodes[0]!;
  if (!node.definition || !isEditableMapping(node)) return null;
  if (capabilityFor(node, surface)?.support !== "direct") return null;
  // Main decodes the value from the real AST; without it there is nothing to show
  // as the current value, so nothing to edit against.
  if (node.surfaces[surface] === null) return null;
  return {
    workspaceSessionId: workspace.workspaceSessionId,
    file: selection.file,
    selection: selection.selection,
    node,
  };
}

export function capabilityFor(node: SelectedNode, surface: EditSurface) {
  return node.capabilities.find((capability) => capability.surface === surface);
}

export function isEditableMapping(node: SelectedNode): boolean {
  return node.mapping === "exact" || node.mapping === "definition-only";
}

const controllers = new Map<string, ControllerEntry>();
const controllerListeners = new Set<() => void>();

function notifyControllers(): void {
  for (const listener of [...controllerListeners]) listener();
}

export function subscribeBuilderControllers(listener: () => void): () => void {
  controllerListeners.add(listener);
  return () => controllerListeners.delete(listener);
}

/** The live controller for a preview, if something holds one. Never creates. */
export function peekBuilderController(previewPanelId: string): InspectorController | null {
  return controllers.get(previewPanelId)?.controller ?? null;
}

/**
 * Hold the builder for one dev preview, creating it on first hold. Shared by
 * the preview's toolbar strip and drawer; disposed — detaching the preview and
 * closing the source workspace — a tick after the last holder lets go, so a
 * remount (or React's development double-mount) keeps the binding.
 *
 * Only effects hold. A controller created during render could be disposed by
 * an idle check before that render committed, and the builder would then keep
 * rendering a dead controller that ignores every update.
 */
export function holdBuilderController(
  previewPanelId: string,
  deps: () => InspectorDeps = defaultInspectorDeps
): () => void {
  let entry = controllers.get(previewPanelId);
  if (!entry) {
    const controller = new InspectorController(previewPanelId, deps());
    const created: ControllerEntry = { controller, holders: 0, unwatch: null };
    entry = created;
    controllers.set(previewPanelId, created);
    // Disabling the plugin closes every workspace in main; a controller kept
    // across that would come back holding dead sessions.
    controller.onPluginDisabled = () => {
      if (controllers.get(previewPanelId) === created) releaseBuilderController(previewPanelId);
    };
    notifyControllers();
  }
  const held = entry;
  held.holders++;
  held.unwatch?.();
  held.unwatch = null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders--;
    setTimeout(() => releaseWhenIdle(previewPanelId, held), 0);
  };
}

interface ControllerEntry {
  controller: InspectorController;
  holders: number;
  /** Set while an unheld controller waits for its builder to be switched off. */
  unwatch: (() => void) | null;
}

/**
 * The builder's UI unmounts whenever its preview is hidden — another dock tab,
 * a maximised sibling — and that must not cost the user their Undo or an
 * in-flight request. So an unheld controller lives on while the builder is
 * still switched on for a preview that still exists, and goes when either
 * stops being true.
 */
function releaseWhenIdle(previewPanelId: string, entry: ControllerEntry): void {
  if (entry.holders > 0 || controllers.get(previewPanelId) !== entry) return;
  const panel = usePanelStore.getState().panelsById[previewPanelId];
  const panelAlive = panel !== undefined && panel.location !== "trash";
  const builderOn =
    useDevPreviewToolStore.getState().activeByPanel[previewPanelId] === BUILDER_TOOL_ID;
  if (panelAlive && builderOn) {
    if (entry.unwatch !== null) return;
    const recheck = () => releaseWhenIdle(previewPanelId, entry);
    const offTools = useDevPreviewToolStore.subscribe(recheck);
    const offPanels = usePanelStore.subscribe(recheck);
    entry.unwatch = () => {
      offTools();
      offPanels();
    };
    return;
  }
  // A removed preview leaves no switched-on tool behind to confuse a later one.
  if (!panelAlive && builderOn) useDevPreviewToolStore.getState().setActive(previewPanelId, null);
  releaseBuilderController(previewPanelId);
}

export function releaseBuilderController(previewPanelId: string): void {
  const entry = controllers.get(previewPanelId);
  // The builder is really over for this preview: nothing typed or in flight
  // for it may outlive it.
  cancelAgentRequests(previewPanelId);
  forgetComposerMemories(previewPanelId);
  if (!entry) return;
  entry.unwatch?.();
  entry.unwatch = null;
  entry.controller.dispose();
  controllers.delete(previewPanelId);
  notifyControllers();
}

export function __resetInspectorControllersForTests(): void {
  for (const entry of controllers.values()) {
    entry.unwatch?.();
    entry.controller.dispose();
  }
  controllers.clear();
  notifyControllers();
}
