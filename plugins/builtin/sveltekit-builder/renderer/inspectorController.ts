import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  SiteGuestNodeObservation,
  SitePreviewBindingState,
  SitePreviewCandidate,
  SitePreviewDetachReason,
  SitePreviewMode,
  SitePreviewPushPayload,
} from "@shared/types/ipc/sitePreview";
import { getPanelStoreSnapshot } from "@/store/storeAccessors";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import {
  CHANNELS,
  ClassCompleteResultSchema,
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
 * One controller per Site Inspector panel. It outlives the view — a maximised
 * sibling or a cached project view unmounts the React tree while the panel
 * lives on, and the preview binding, the open selection and the last receipt
 * (with its Undo) must survive that. It ends when the panel is removed.
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
  getState(request: { sessionId: string }): Promise<SitePreviewBindingState | null>;
  onEvent(callback: (payload: SitePreviewPushPayload) => void): () => void;
}

export interface InspectorDeps {
  sitePreview: SitePreviewApi;
  invoke(channel: string, args: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
  /** The worktree a panel belongs to: undefined when unknown, null when it has none. */
  panelWorktreeId(panelId: string): string | null | undefined;
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
  | { status: "listing" }
  | { status: "no-candidates" }
  | { status: "choosing"; candidates: SitePreviewCandidate[] }
  | { status: "binding"; panelId: string }
  | { status: "bound"; sessionId: string; panelId: string; url: string | null }
  | { status: "detached"; panelId: string; reason: SitePreviewDetachReason }
  | { status: "failed"; message: string };

export type WorkspaceState =
  | { status: "idle" }
  | { status: "no-worktree" }
  | { status: "opening" }
  | { status: "ready"; workspaceSessionId: string; appRoot: string; support: SupportVerdict }
  | { status: "ambiguous"; appRoots: string[] }
  | { status: "no-app" }
  | { status: "failed"; message: string };

export interface PageState {
  epoch: number;
  routeId: string | null;
  url: string;
  viewport: Viewport;
}

export type StaleReason = "document-changed" | "source-changed" | "edited" | "preview-detached";

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
    }
  /** The document moved on before the resolve finished. */
  | { status: "lost" }
  /** The owning file changed moments ago; the page may still show the old markup. */
  | { status: "settling" }
  | { status: "failed"; message: string };

export type EditSurface = "text" | "classes";

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
}

export interface InspectorIssue {
  severity: "warning" | "error";
  message: string;
}

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
}

export type ClassCompletion =
  | { status: "ok"; candidates: Array<{ candidate: string; css: string }> }
  | { status: "unavailable"; reason: string };

const INITIAL_STATE: InspectorState = {
  binding: { status: "idle" },
  mode: "browse",
  modePending: false,
  epoch: null,
  page: null,
  workspace: { status: "idle" },
  selection: { status: "none" },
  edit: { status: "idle" },
  receipt: null,
  issue: null,
  mutating: false,
};

const MAX_BUFFERED_EVENTS = 64;

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
    panelWorktreeId: (panelId) => {
      const snapshot = getPanelStoreSnapshot();
      if (!snapshot) return undefined;
      const panel = snapshot.panelsById[panelId];
      if (!panel) return undefined;
      return panel.worktreeId ?? null;
    },
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
  private state: InspectorState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private context: InspectorContext = { projectId: null, worktreeId: null, worktreePath: null };
  private workspaceKey: string | null = null;
  private workspaceRequest = 0;
  private bindRequest = 0;
  private selectionRequest = 0;
  private bufferedEvents: SitePreviewPushPayload[] = [];
  /** Files main reported changed while the current resolve was in flight. */
  private readonly changedDuringResolve = new Set<string>();
  /** Worktree-relative file → when it last changed, for the HMR settle window. */
  private readonly recentChanges = new Map<string, number>();
  private chosenAppRoot: string | undefined;
  private recoveringWorkspace: string | null = null;
  private lastCandidates: SitePreviewCandidate[] = [];
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
      void this.refreshCandidates();
    } else if (worktreeChanged) {
      // A preview belongs to a worktree. Observations from the old one must
      // never resolve against the new worktree's source.
      if (binding.status === "bound") {
        void this.deps.sitePreview.detach({ sessionId: binding.sessionId }).catch(() => undefined);
      }
      void this.refreshCandidates();
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
    this.closeWorkspace();
    this.workspaceKey = key;
    if (key === null) {
      this.update({ workspace: { status: "no-worktree" } });
      return;
    }
    void this.openWorkspace();
  }

  async openWorkspace(appRoot: string | undefined = this.chosenAppRoot): Promise<void> {
    this.chosenAppRoot = appRoot;
    const { projectId, worktreeId, worktreePath } = this.context;
    if (!projectId || !worktreeId || !worktreePath) return;
    const request = ++this.workspaceRequest;
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
            },
          });
          return;
        case "ambiguous":
          this.update({ workspace: { status: "ambiguous", appRoots: result.appRoots } });
          return;
        case "no-app":
          this.update({ workspace: { status: "no-app" } });
          return;
      }
    } catch (error) {
      if (request !== this.workspaceRequest) return;
      this.update({
        workspace: {
          status: "failed",
          message: formatErrorMessage(error, "Couldn't open the site source"),
        },
      });
    }
  }

  private releaseWorkspace(workspaceSessionId: string): void {
    void this.deps.invoke(CHANNELS.workspaceClose, { workspaceSessionId }).catch(() => undefined);
  }

  private closeWorkspace(): void {
    this.workspaceRequest++;
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

  async refreshCandidates(): Promise<void> {
    const request = ++this.bindRequest;
    this.update({ binding: { status: "listing" } });
    let candidates: SitePreviewCandidate[];
    try {
      candidates = await this.deps.sitePreview.listCandidates();
    } catch (error) {
      if (request !== this.bindRequest) return;
      this.update({
        binding: {
          status: "failed",
          message: formatErrorMessage(error, "Couldn't list dev previews"),
        },
      });
      return;
    }
    if (request !== this.bindRequest) return;
    const inWorktree = candidates.filter((candidate) => this.inThisWorktree(candidate.panelId));
    this.lastCandidates = inWorktree;
    if (inWorktree.length === 0) {
      this.update({ binding: { status: "no-candidates" } });
      return;
    }
    if (inWorktree.length === 1) {
      await this.bindTo(inWorktree[0]!.panelId);
      return;
    }
    this.update({ binding: { status: "choosing", candidates: inWorktree } });
  }

  private inThisWorktree(previewPanelId: string): boolean {
    const own = this.context.worktreeId;
    if (!own) return true;
    const theirs = this.deps.panelWorktreeId(previewPanelId);
    // Unknown means the panel store isn't reachable; don't hide a real preview over it.
    return theirs === undefined || theirs === own;
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
      this.update({
        binding: {
          status: "failed",
          message: formatErrorMessage(error, "Couldn't connect to the dev preview"),
        },
      });
      return;
    }
    if (request !== this.bindRequest || this.disposed) {
      // Superseded or disposed while binding: the session we just got is nobody's.
      void this.deps.sitePreview.detach({ sessionId: state.sessionId }).catch(() => undefined);
      return;
    }

    this.update({
      binding: {
        status: "bound",
        sessionId: state.sessionId,
        panelId: state.panelId,
        url: this.candidateUrl(state.panelId),
      },
      mode: state.mode,
      epoch: null,
    });
    this.noteEpoch(state.documentEpoch);
    // Pushes for this session can land before `bind` resolves.
    const buffered = this.bufferedEvents;
    this.bufferedEvents = [];
    for (const payload of buffered) this.handlePreviewPush(payload);
  }

  private candidateUrl(panelId: string): string | null {
    return this.lastCandidates.find((candidate) => candidate.panelId === panelId)?.url ?? null;
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
        return;
      }
      case "selectionChanged":
        void this.handleSelection(epoch, event.nodes);
        return;
      case "runtimeIssue":
        this.update({
          issue: {
            severity: event.code === "internal" ? "error" : "warning",
            message: RUNTIME_ISSUE_COPY[event.code] ?? event.detail,
          },
        });
        return;
      case "hoverChanged":
      case "mappingRevisionSeen":
        return;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Selection                                                                */
  /* ------------------------------------------------------------------------ */

  private async handleSelection(epoch: number, nodes: SiteGuestNodeObservation[]): Promise<void> {
    const request = ++this.selectionRequest;
    this.changedDuringResolve.clear();
    const base: Partial<InspectorState> = {
      edit: this.state.edit.status === "applying" ? this.state.edit : { status: "idle" },
    };
    if (nodes.length === 0) {
      this.update({ ...base, selection: { status: "none" } });
      return;
    }
    const workspace = this.state.workspace;
    const page = this.state.page;
    const binding = this.state.binding;
    if (
      workspace.status !== "ready" ||
      workspace.support.level !== "full" ||
      binding.status !== "bound"
    ) {
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
    if (clickedFiles.some((file) => file !== null && this.changedRecently(file))) {
      this.update({ ...base, selection: { status: "settling" } });
      return;
    }

    this.update({ ...base, selection: { status: "resolving", epoch, requestId: request } });
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
      this.update({ selection: { status: "lost" } });
      return;
    }
    if (file !== null && this.changedRecently(file)) {
      this.update({ selection: { status: "settling" } });
      return;
    }
    this.update({ selection: { status: "ready", selection, file, stale: null } });
  }

  private changedRecently(file: string): boolean {
    const at = this.recentChanges.get(file);
    return at !== undefined && this.deps.now() - at < HMR_SETTLE_MS;
  }

  private noteChanged(file: string): void {
    this.recentChanges.set(file, this.deps.now());
    // Our own writes aren't pushed back as sourceChanged, so a resolve that is
    // out when one lands must be invalidated here, however long it then takes.
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

  dismissIssue(): void {
    this.update({ issue: null });
  }

  /* ------------------------------------------------------------------------ */
  /* Editing                                                                  */
  /* ------------------------------------------------------------------------ */

  addClasses(selectionId: string, tokens: string[]): Promise<boolean> {
    const target = editTargetOf(this.state, "classes", selectionId);
    const classes = target?.node.surfaces.classes;
    if (!target || !classes) return Promise.resolve(false);
    const existing = new Set(classes.tokens);
    const add = [...new Set(tokens)].filter(
      (token) => isClassTokenShape(token) && !existing.has(token)
    );
    if (add.length === 0) return Promise.resolve(false);
    return this.apply("classes", selectionId, [
      {
        kind: "set_class_tokens",
        range: target.node.definition!.range,
        add,
        remove: [],
        responsive: { kind: "base" },
      },
    ]);
  }

  removeClass(selectionId: string, token: string): Promise<boolean> {
    const target = editTargetOf(this.state, "classes", selectionId);
    const classes = target?.node.surfaces.classes;
    if (!target || !classes || !classes.tokens.includes(token)) return Promise.resolve(false);
    return this.apply("classes", selectionId, [
      {
        kind: "set_class_tokens",
        range: target.node.definition!.range,
        add: [],
        remove: [token],
        responsive: { kind: "base" },
      },
    ]);
  }

  setText(selectionId: string, text: string): Promise<boolean> {
    const target = editTargetOf(this.state, "text", selectionId);
    const current = target?.node.surfaces.text;
    if (!target || !current) return Promise.resolve(false);
    if (text.trim().length === 0 || text === current.text) return Promise.resolve(false);
    return this.apply("text", selectionId, [
      { kind: "set_literal_text", range: target.node.definition!.range, text },
    ]);
  }

  private async apply(
    surface: EditSurface,
    selectionId: string,
    operations: EditOperation[]
  ): Promise<boolean> {
    const target = editTargetOf(this.state, surface, selectionId);
    if (!target) return false;
    const definition = target.node.definition!;
    // Witness and workspace are fixed now, not when the reply lands: by then the
    // panel may show another worktree and another preview.
    const previewSessionId = this.boundSessionId();
    this.update({ edit: { status: "applying", surface }, mutating: true });
    const done = await this.write(target, definition, operations);
    return this.settle(surface, selectionId, target, previewSessionId, done);
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
    done: { raw: unknown } | { error: unknown }
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
          },
          // The file's bytes moved, so every range held against it is spent —
          // including a newer selection that resolved while the write was out.
          ...(stillSelected || this.selectionFile() === result.receipt.file
            ? this.staleSelectionPatch("edited")
            : {}),
        });
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

  dispose(): void {
    if (this.disposed) return;
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

const controllers = new Map<string, InspectorController>();

/**
 * The controller, not the view, listens for panel removal: the view can be
 * unmounted (a maximised sibling) at the moment the panel is removed, and its
 * listener would be gone with it.
 */
export function acquireInspectorController(
  panelId: string,
  panelRemovedSignal: AbortSignal,
  deps: () => InspectorDeps = defaultInspectorDeps
): InspectorController {
  let controller = controllers.get(panelId);
  if (!controller) {
    const created = new InspectorController(panelId, deps());
    controller = created;
    controllers.set(panelId, created);
    const release = () => {
      panelRemovedSignal.removeEventListener("abort", release);
      if (controllers.get(panelId) === created) releaseInspectorController(panelId);
    };
    if (panelRemovedSignal.aborted) queueMicrotask(release);
    else panelRemovedSignal.addEventListener("abort", release, { once: true });
    // Disabling the plugin closes every workspace in main. A cached controller
    // would come back on re-enable holding a dead session and a live preview
    // binding, so it goes entirely; the remounted view starts a fresh one.
    created.onPluginDisabled = release;
  }
  return controller;
}

export function releaseInspectorController(panelId: string): void {
  controllers.get(panelId)?.dispose();
  controllers.delete(panelId);
}

export function __resetInspectorControllersForTests(): void {
  for (const controller of controllers.values()) controller.dispose();
  controllers.clear();
}
