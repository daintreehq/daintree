import type {
  SitePreviewDetachReason,
  SiteGuestNodeObservation,
  SitePreviewBindingState,
  SitePreviewCandidate,
  SitePreviewMode,
  SitePreviewPushPayload,
} from "@shared/types/ipc/sitePreview";
import { CHANNELS, PLUGIN_ID } from "../../shared/protocol.js";
import type {
  EditCapability,
  EditReceipt,
  SelectedNode,
  SiteSelection,
} from "../../shared/model.js";

/**
 * The host half of the visual-review harness: stand-ins for the site-preview
 * bridge and for plugin main, driven from a fixture script.
 *
 * A near-twin of `__tests__/testHost.ts`, deliberately kept separate rather
 * than shared: that one is built on `vi.fn()`, which cannot be imported into a
 * page Vite serves to a real browser. The fixture SHAPES below are the part
 * worth keeping identical, and `__tests__/previewFixtures.test.ts` asserts the
 * two agree on them.
 */

export const WORKTREE = "/Users/you/code/orchid-studio";
export const FILE = "src/routes/pricing/+page.svelte";
export const COMPONENT_FILE = "src/lib/components/marketing/PricingCard.svelte";
export const SOURCE = [
  "<script>",
  "  let plan = 'pro';",
  "</script>",
  "",
  '<article class="card">',
  '  <button class="px-6 py-3 rounded-lg bg-indigo-600 text-white" type="button">Start Pro</button>',
  "</article>",
  "",
].join("\n");

/** A stable stand-in for a content hash; the harness never verifies one. */
export const REVISION = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
export const BUTTON_START = SOURCE.indexOf("<button");
export const BUTTON_END = SOURCE.indexOf("</button>") + "</button>".length;

export const OBSERVATION: SiteGuestNodeObservation = {
  runtimeOccurrenceId: "occ-1",
  loc: { file: FILE, line: 6, column: 2 },
  ancestry: [],
  tagName: "BUTTON",
  sameLocCount: 1,
  label: 'button "Start Pro"',
  bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
  unmapped: false,
};

export const DIRECT: EditCapability[] = [
  { surface: "text", support: "direct" },
  { surface: "classes", support: "direct" },
];

export function makeSelection(
  overrides: {
    documentEpoch?: number;
    renderedOccurrences?: number;
    capabilities?: EditCapability[];
    surfaces?: SelectedNode["surfaces"];
    selectionId?: string;
    node?: Partial<SelectedNode>;
  } = {}
): SiteSelection {
  return {
    selectionId: overrides.selectionId ?? "sel-1",
    workspaceSessionId: "ws-1",
    projectId: "p1",
    worktreeId: "wt-1",
    appRoot: WORKTREE,
    previewPanelId: "preview-1",
    documentEpoch: overrides.documentEpoch ?? 0,
    routeId: "/pricing",
    displayedUrl: "/pricing",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
    capturedAt: "2026-09-16T00:00:00.000Z",
    nodes: [
      {
        runtimeOccurrenceId: "occ-1",
        definition: {
          location: { file: FILE, line: 6, column: 2 },
          range: { start: BUTTON_START, end: BUTTON_END },
          tagName: "button",
          revision: REVISION,
          renderedOccurrences: overrides.renderedOccurrences ?? 1,
        },
        invocation: null,
        // Innermost first, exactly as the guest reports it: `taskScopes` walks
        // outwards and stops at the first generated frame, so a chain written
        // the other way round yields no component scope at all.
        ancestry: [
          {
            kind: "each",
            location: { file: FILE, line: 4, column: 0 },
            generated: false,
          },
          {
            kind: "component",
            location: { file: FILE, line: 5, column: 2 },
            componentTag: "PricingCard",
            generated: false,
          },
          {
            kind: "component",
            location: { file: ".svelte-kit/generated/root.svelte", line: 1, column: 0 },
            generated: true,
          },
        ],
        mapping: "exact",
        label: 'button "Start Pro"',
        bounds: [],
        capabilities: overrides.capabilities ?? DIRECT,
        surfaces: overrides.surfaces ?? {
          classes: { tokens: ["px-6", "py-3", "rounded-lg", "bg-indigo-600", "text-white"] },
          text: { text: "Start Pro" },
        },
        ...overrides.node,
      },
    ],
  };
}

export function makeReceipt(overrides: Partial<EditReceipt> = {}): EditReceipt {
  return {
    transactionId: "tx-1",
    file: FILE,
    beforeRevision: REVISION,
    afterRevision: `${REVISION.slice(0, 60)}beef`,
    appliedRange: { start: BUTTON_START, end: BUTTON_END },
    sourceSaved: true,
    previewRefreshed: null,
    stylesGenerated: null,
    affectedOccurrences: 1,
    appliedAt: "2026-09-16T00:00:01.000Z",
    ...overrides,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;

export interface PreviewHost {
  sitePreview: unknown;
  plugin: {
    invoke: Handler extends never ? never : (...args: never[]) => unknown;
    on: unknown;
    onPanel: unknown;
  };
  handlers: Map<string, Handler>;
  pushPreview(payload: SitePreviewPushPayload): void;
  documentReady(epoch: number): void;
  select(
    epoch: number,
    nodes?: SiteGuestNodeObservation[],
    cause?: "user" | "document" | "reselect"
  ): void;
  detach(reason: string): void;
}

/** Built once per page load; a fixture reshapes it through `handlers` before mounting. */
export function createPreviewHost() {
  const candidates: SitePreviewCandidate[] = [
    { panelId: "preview-1", url: "http://localhost:5173/pricing", boundSessionId: null },
  ];
  const previewListeners = new Set<(payload: SitePreviewPushPayload) => void>();
  const pluginListeners = new Map<string, Set<(payload: unknown) => void>>();
  const handlers = new Map<string, Handler>();

  const state = (panelId: string, mode: SitePreviewMode): SitePreviewBindingState => ({
    sessionId: "session-1",
    panelId,
    projectId: "p1",
    documentEpoch: 0,
    mode,
    guestReady: false,
    droppedMessages: 0,
  });

  /** Held open by the `connecting` fixture, which is about the wait itself. */
  const control = { stallBind: false };

  const sitePreview = {
    listCandidates: async () => candidates,
    bind: async (request: { panelId: string; mode?: SitePreviewMode }) => {
      if (control.stallBind) await new Promise<never>(() => {});
      return state(request.panelId, request.mode ?? "browse");
    },
    detach: async () => undefined,
    setMode: async (request: { mode: SitePreviewMode }) => state("preview-1", request.mode),
    reselect: async (request: { loc: SiteGuestNodeObservation["loc"]; index?: number }) => {
      setTimeout(
        () =>
          host.select(
            host.currentEpoch,
            [{ ...OBSERVATION, loc: request.loc, locIndex: request.index ?? 0 }],
            "reselect"
          ),
        0
      );
      return true;
    },
    clearSelection: async () => undefined,
    getState: async () => null,
    onEvent: (callback: (payload: SitePreviewPushPayload) => void) => {
      previewListeners.add(callback);
      return () => previewListeners.delete(callback);
    },
  };

  handlers.set(CHANNELS.workspaceOpen, () => ({
    status: "ready",
    workspaceSessionId: "ws-1",
    appRoot: WORKTREE,
    support: { level: "full" },
  }));
  // Main remembers what it wrote: a re-proof after a class edit returns the
  // tokens as they are on disk now, not the fixture's original list. Without
  // this the continued state photographs a class the user just removed. Undo
  // puts back what the write replaced, as the journal does.
  const DEFAULT_TOKENS = ["px-6", "py-3", "rounded-lg", "bg-indigo-600", "text-white"];
  let tokens = [...DEFAULT_TOKENS];
  const history: Array<{ tokens: string[]; revision: string }> = [];
  let diskRevision = REVISION;
  handlers.set(CHANNELS.selectionResolve, (args) => {
    const selection = makeSelection({ documentEpoch: args.documentEpoch as number });
    const node = selection.nodes[0]!;
    if (node.definition) node.definition.revision = diskRevision;
    if (node.surfaces.classes) node.surfaces.classes.tokens = [...tokens];
    return { status: "ok", selection };
  });
  // One vocabulary for suggestions and inspection, covering every class the
  // default selection carries — a harness that knows only shadows photographs
  // "generates no CSS" for `px-6` and passes it off as product behaviour.
  const CATALOG: Array<{ candidate: string; css: string }> = [
    { candidate: "px-6", css: ".px-6 {\n  padding-inline: calc(var(--spacing) * 6);\n}" },
    { candidate: "px-8", css: ".px-8 {\n  padding-inline: calc(var(--spacing) * 8);\n}" },
    { candidate: "py-3", css: ".py-3 {\n  padding-block: calc(var(--spacing) * 3);\n}" },
    { candidate: "rounded-lg", css: ".rounded-lg {\n  border-radius: var(--radius-lg);\n}" },
    {
      candidate: "bg-indigo-600",
      css: ".bg-indigo-600 {\n  background-color: var(--color-indigo-600);\n}",
    },
    { candidate: "text-white", css: ".text-white {\n  color: var(--color-white);\n}" },
    { candidate: "shadow-md", css: "box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1)" },
    { candidate: "shadow-lg", css: "box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1)" },
    { candidate: "shadow-xl", css: "box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1)" },
    { candidate: "shadow-inner", css: "box-shadow: inset 0 2px 4px 0 rgb(0 0 0 / 0.05)" },
  ];
  handlers.set(CHANNELS.classComplete, (args) => {
    const query = String(args.query ?? "");
    return {
      status: "ok",
      candidates: CATALOG.filter((entry) => entry.candidate.startsWith(query)),
    };
  });
  // Padding along the inline axis is the one rivalry these fakes know: enough
  // to exercise the replace-or-keep choice without pretending to be Tailwind.
  handlers.set(CHANNELS.classConflicts, (args) => {
    const existing = args.existing as string[];
    const conflicts = (args.candidates as string[]).flatMap((candidate) =>
      /^px-\d+$/.test(candidate)
        ? existing
            .filter((token) => /^px-\d+$/.test(token) && token !== candidate)
            .map((token) => ({ candidate, token, properties: ["padding-left", "padding-right"] }))
        : []
    );
    return { status: "ok", conflicts };
  });
  handlers.set(CHANNELS.projectModel, () => ({
    appRoot: WORKTREE,
    packageManager: "pnpm",
    versions: { svelte: "5.38.1", kit: "2.36.0", tailwind: "4.1.12", vite: "7.1.2" },
    support: { level: "full" },
    basePath: "",
    routes: [
      {
        routeId: "/pricing",
        pageFile: FILE,
        layoutFiles: ["src/routes/+layout.svelte"],
        dataFiles: ["src/routes/pricing/+page.server.ts"],
        dynamic: false,
        endpointOnly: false,
      },
    ],
  }));
  handlers.set(CHANNELS.tailwindStatus, () => ({ status: "available", skippedModules: [] }));
  handlers.set(CHANNELS.classDescribe, (args) => {
    const token = String(args.token ?? "");
    const variant = /^(?:hover|focus|md|lg):(.+)$/.exec(token);
    const base = CATALOG.find((entry) => entry.candidate === (variant?.[1] ?? token));
    return { status: "ok", css: base ? base.css : null, partial: false };
  });
  handlers.set(CHANNELS.editApply, (args) => {
    history.push({ tokens: [...tokens], revision: diskRevision });
    for (const op of (args.operations as Array<Record<string, unknown>> | undefined) ?? []) {
      const remove = new Set((op.remove as string[] | undefined) ?? []);
      tokens = tokens.filter((token) => !remove.has(token));
      for (const token of (op.add as string[] | undefined) ?? []) {
        if (!tokens.includes(token)) tokens.push(token);
      }
    }
    const receipt = makeReceipt({ beforeRevision: diskRevision });
    diskRevision = receipt.afterRevision;
    return { status: "applied", receipt };
  });
  handlers.set(CHANNELS.editUndo, () => {
    const previous = history.pop();
    const beforeRevision = diskRevision;
    if (previous) {
      tokens = previous.tokens;
      diskRevision = previous.revision;
    }
    // A reversal receipt goes from the edited bytes back to the ones restored,
    // so the next resolve agrees with it.
    return {
      status: "reversed",
      receipt: makeReceipt({ transactionId: "tx-2", beforeRevision, afterRevision: diskRevision }),
    };
  });
  handlers.set(CHANNELS.workspaceClose, () => ({ closed: true }));
  handlers.set(CHANNELS.componentDefinitions, (args) => ({
    definitions: (args.callSites as Array<{ file: string; line: number; column: number }>).map(
      (site) => ({
        ...site,
        // The call site is in the page; what main resolves is where the
        // component is written.
        name: site.line === 5 ? "PricingCard" : null,
        definedIn: site.line === 5 ? COMPONENT_FILE : null,
        revision: REVISION,
        definedInRevision: site.line === 5 ? REVISION : null,
      })
    ),
  }));
  handlers.set(CHANNELS.sourceRevisions, (args) => ({
    revisions: (args.files as string[]).map((file) => ({ file, revision: REVISION })),
  }));
  handlers.set("detect-apps", () => ({ appCount: 1 }));

  const invoke = async (pluginId: string, channel: string, args: unknown) => {
    if (pluginId !== PLUGIN_ID && channel !== "detect-apps") {
      throw new Error(`unexpected plugin ${pluginId}`);
    }
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`preview host: no handler for ${channel}`);
    return handler((args ?? {}) as Record<string, unknown>);
  };

  const on = (_pluginId: string, channel: string, callback: (payload: unknown) => void) => {
    let set = pluginListeners.get(channel);
    if (!set) {
      set = new Set();
      pluginListeners.set(channel, set);
    }
    set.add(callback);
    return () => set!.delete(callback);
  };
  const onPanel = (
    pluginId: string,
    channel: string,
    _panelId: string,
    callback: (payload: unknown) => void
  ) => on(pluginId, channel, callback);

  const host = {
    sitePreview,
    plugin: { invoke, on, onPanel },
    handlers,
    control,
    currentEpoch: 0,
    pushPreview(payload: SitePreviewPushPayload) {
      for (const listener of [...previewListeners]) listener(payload);
    },
    /** Plugin main → view, the other half of the bridge. */
    pushPlugin(channel: string, payload: unknown) {
      for (const listener of [...(pluginListeners.get(channel) ?? [])]) listener(payload);
    },
    documentReady(epoch: number) {
      host.currentEpoch = epoch;
      host.pushPreview({
        kind: "guest-event",
        sessionId: "session-1",
        panelId: "preview-1",
        projectId: "p1",
        documentEpoch: epoch,
        sequence: 0,
        event: {
          type: "documentReady",
          routeId: "/pricing",
          url: "http://localhost:5173/pricing",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        },
      });
    },
    select(
      epoch: number,
      nodes: SiteGuestNodeObservation[] = [OBSERVATION],
      cause: "user" | "document" | "reselect" = "user"
    ) {
      host.pushPreview({
        kind: "guest-event",
        sessionId: "session-1",
        panelId: "preview-1",
        projectId: "p1",
        documentEpoch: epoch,
        sequence: 1,
        event: { type: "selectionChanged", nodes, cause },
      });
    },
    /**
     * `guest-destroyed` and `debugger-detached` are in the controller's
     * reattach set, so pushing one of those lands back on the bound state a
     * moment later and the capture shows a connected preview. Terminal reasons
     * only here.
     */
    detach(reason: Exclude<SitePreviewDetachReason, "guest-destroyed" | "debugger-detached">) {
      host.pushPreview({
        kind: "detached",
        sessionId: "session-1",
        projectId: "p1",
        reason,
      });
    },
  };
  return host;
}

export type PreviewHostHandle = ReturnType<typeof createPreviewHost>;
