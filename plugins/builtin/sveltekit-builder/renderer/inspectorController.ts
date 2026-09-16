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
  SourceExcerptResultSchema,
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
import { locateElementSource, type ElementShape } from "./sourceShape.js";

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
  | { status: "failed"; message: string };

export type SourceState =
  | { status: "idle" }
  | { status: "loading"; selectionId: string }
  | { status: "ok"; selectionId: string; shape: ElementShape }
  | { status: "unavailable"; selectionId: string };

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
  source: SourceState;
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
  source: { status: "idle" },
  edit: { status: "idle" },
  receipt: null,
  issue: null,
  mutating: false,
};

const MAX_BUFFERED_EVENTS = 64;

// Loaded through a glob rather than a static import on purpose: a static import
// pulls `guest/runtime.ts` into the renderer's type program, whose
// `noUncheckedIndexedAccess` that file was not written against. The glob is
// still bundled into this lazy chunk; only the type checker stops following it.
const guestSourceModules = import.meta.glob<{ buildGuestRuntimeBody: () => string }>(
  "../guest/source.ts"
);

export async function loadGuestRuntimeBody(): Promise<string> {
  const load = guestSourceModules["../guest/source.ts"];
  if (!load) throw new Error("The site inspector's page runtime is missing from this build");
  return (await load()).buildGuestRuntimeBody();
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
  const file = node.definition.location.file;
  if (!worktreePath) return file;
  const root = trimSlash(worktreePath);
  const app = trimSlash(selection.appRoot);
  if (app === root) return file;
  if (!app.startsWith(root + "/")) return null;
  return `${app.slice(root.length + 1)}/${file}`;
}

function trimSlash(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function isValidClassToken(token: string): boolean {
  return token.length > 0 && token.length <= 128 && !/[\s"'`{}<>\\]/.test(token);
}

export class InspectorController {
  readonly panelId: string;
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
    if (key === this.workspaceKey) return;
    this.closeWorkspace();
    this.workspaceKey = key;
    if (key === null) {
      this.update({ workspace: { status: "no-worktree" } });
      return;
    }
    void this.openWorkspace();
  }

  async openWorkspace(appRoot?: string): Promise<void> {
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
      source: { status: "idle" },
      edit: { status: "idle" },
      receipt: null,
    });
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
      source: { status: "idle" },
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
    this.update({ selection: { status: "ready", selection, file, stale: null } });
    void this.loadSource(selection);
  }

  private isCurrentResolve(request: number): boolean {
    const selection = this.state.selection;
    return (
      request === this.selectionRequest &&
      selection.status === "resolving" &&
      selection.requestId === request
    );
  }

  private async loadSource(selection: SiteSelection): Promise<void> {
    const node = selection.nodes[0];
    const definition = node?.definition;
    const current = this.state.selection;
    if (!definition || current.status !== "ready" || !current.file) return;
    if (!hasDirectSurface(node)) return;
    const workspace = this.state.workspace;
    if (workspace.status !== "ready") return;

    const selectionId = selection.selectionId;
    this.update({ source: { status: "loading", selectionId } });
    let raw: unknown;
    try {
      raw = await this.deps.invoke(CHANNELS.sourceExcerpt, {
        workspaceSessionId: workspace.workspaceSessionId,
        file: current.file,
        range: definition.range,
        contextLines: 0,
      });
    } catch {
      raw = null;
    }
    if (!this.isSelection(selectionId)) return;
    const parsed = SourceExcerptResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.status !== "ok") {
      this.update({ source: { status: "unavailable", selectionId } });
      return;
    }
    const located = locateElementSource(parsed.data, definition);
    if (located.status === "revision-mismatch") {
      this.update({
        source: { status: "unavailable", selectionId },
        ...this.staleSelectionPatch("source-changed"),
      });
      return;
    }
    if (located.status === "unreadable") {
      this.update({ source: { status: "unavailable", selectionId } });
      return;
    }
    this.update({ source: { status: "ok", selectionId, shape: located.shape } });
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
    const selection = this.state.selection;
    if (selection.status === "resolving") this.changedDuringResolve.add(push.file);
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
    if (!target || target.shape.classes.kind !== "static") return Promise.resolve(false);
    const existing = new Set(target.shape.classes.tokens);
    const add = tokens.filter((token) => isValidClassToken(token) && !existing.has(token));
    if (add.length === 0) return Promise.resolve(false);
    return this.apply("classes", selectionId, [
      {
        kind: "set_class_tokens",
        range: target.shape.classes.range,
        add,
        remove: [],
        responsive: { kind: "base" },
      },
    ]);
  }

  removeClass(selectionId: string, token: string): Promise<boolean> {
    const target = editTargetOf(this.state, "classes", selectionId);
    if (!target || target.shape.classes.kind !== "static") return Promise.resolve(false);
    if (!target.shape.classes.tokens.includes(token)) return Promise.resolve(false);
    return this.apply("classes", selectionId, [
      {
        kind: "set_class_tokens",
        range: target.shape.classes.range,
        add: [],
        remove: [token],
        responsive: { kind: "base" },
      },
    ]);
  }

  setText(selectionId: string, text: string): Promise<boolean> {
    const target = editTargetOf(this.state, "text", selectionId);
    if (!target || target.shape.text.kind !== "literal") return Promise.resolve(false);
    const next = text.trim();
    if (next.length === 0 || next === target.shape.text.text) return Promise.resolve(false);
    const literal = target.shape.text;
    return this.apply("text", selectionId, [
      {
        kind: "set_literal_text",
        range: literal.range,
        text: literal.leading + next + literal.trailing,
      },
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
    this.update({ edit: { status: "applying", surface }, mutating: true });
    const done = await this.write(target, definition, operations);
    return this.settle(surface, selectionId, target, done);
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
    done: { raw: unknown } | { error: unknown }
  ): boolean {
    this.update({ mutating: false });
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
    const stillSelected = this.isSelection(selectionId);
    switch (result.status) {
      case "applied":
        this.update({
          edit: { status: "idle" },
          receipt: {
            kind: "edit",
            surface,
            receipt: result.receipt,
            workspaceSessionId: target.workspaceSessionId,
            previewSessionId: this.boundSessionId(),
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
    this.update({ receipt: { ...receipt, undo: { status: "pending" } }, mutating: true });

    let raw: unknown;
    try {
      raw = await this.deps.invoke(CHANNELS.editUndo, {
        workspaceSessionId: receipt.workspaceSessionId,
        transactionId,
      });
    } catch (error) {
      this.update({ mutating: false });
      this.patchUndo(transactionId, {
        status: "failed",
        message: formatErrorMessage(error, "The edit couldn't be undone"),
      });
      return;
    }
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
    if (result.status === "error") {
      this.patchUndo(transactionId, { status: "failed", message: result.message });
      return;
    }
    const current = this.state.receipt;
    if (current?.receipt.transactionId !== transactionId) return;
    this.update({
      receipt: {
        kind: "undo",
        surface: current.surface,
        receipt: result.receipt,
        workspaceSessionId: current.workspaceSessionId,
        previewSessionId: this.boundSessionId(),
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
  shape: ElementShape;
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
  const { workspace, selection, source, binding, edit, epoch } = state;
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
  if (source.status !== "ok" || source.selectionId !== selection.selection.selectionId) {
    return null;
  }
  return {
    workspaceSessionId: workspace.workspaceSessionId,
    file: selection.file,
    selection: selection.selection,
    node,
    shape: source.shape,
  };
}

export function capabilityFor(node: SelectedNode, surface: EditSurface) {
  return node.capabilities.find((capability) => capability.surface === surface);
}

export function isEditableMapping(node: SelectedNode): boolean {
  return node.mapping === "exact" || node.mapping === "definition-only";
}

function hasDirectSurface(node: SelectedNode): boolean {
  return (
    isEditableMapping(node) &&
    (capabilityFor(node, "text")?.support === "direct" ||
      capabilityFor(node, "classes")?.support === "direct")
  );
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
      if (controllers.get(panelId) === created) releaseInspectorController(panelId);
    };
    if (panelRemovedSignal.aborted) queueMicrotask(release);
    else panelRemovedSignal.addEventListener("abort", release, { once: true });
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
