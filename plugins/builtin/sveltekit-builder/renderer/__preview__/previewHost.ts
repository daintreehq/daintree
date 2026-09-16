import type {
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
  plugin: { invoke: Handler extends never ? never : (...args: never[]) => unknown; on: unknown };
  handlers: Map<string, Handler>;
  pushPreview(payload: SitePreviewPushPayload): void;
  documentReady(epoch: number): void;
  select(epoch: number, nodes?: SiteGuestNodeObservation[]): void;
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
  handlers.set(CHANNELS.selectionResolve, (args) => ({
    status: "ok",
    selection: makeSelection({ documentEpoch: args.documentEpoch as number }),
  }));
  handlers.set(CHANNELS.classComplete, (args) => {
    const query = String(args.query ?? "");
    const known = [
      { candidate: "shadow-md", css: "box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1)" },
      { candidate: "shadow-lg", css: "box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1)" },
      { candidate: "shadow-xl", css: "box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1)" },
      { candidate: "shadow-inner", css: "box-shadow: inset 0 2px 4px 0 rgb(0 0 0 / 0.05)" },
    ];
    return {
      status: "ok",
      candidates: known.filter((entry) => entry.candidate.startsWith(query)),
    };
  });
  handlers.set(CHANNELS.editApply, () => ({ status: "applied", receipt: makeReceipt() }));
  handlers.set(CHANNELS.editUndo, () => ({
    status: "reversed",
    receipt: makeReceipt({ transactionId: "tx-2" }),
  }));
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

  const host = {
    sitePreview,
    plugin: { invoke, on },
    handlers,
    control,
    pushPreview(payload: SitePreviewPushPayload) {
      for (const listener of [...previewListeners]) listener(payload);
    },
    /** Plugin main → view, the other half of the bridge. */
    pushPlugin(channel: string, payload: unknown) {
      for (const listener of [...(pluginListeners.get(channel) ?? [])]) listener(payload);
    },
    documentReady(epoch: number) {
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
    select(epoch: number, nodes: SiteGuestNodeObservation[] = [OBSERVATION]) {
      host.pushPreview({
        kind: "guest-event",
        sessionId: "session-1",
        panelId: "preview-1",
        projectId: "p1",
        documentEpoch: epoch,
        sequence: 1,
        event: { type: "selectionChanged", nodes },
      });
    },
    detach(reason: string) {
      host.pushPreview({
        kind: "detached",
        sessionId: "session-1",
        panelId: "preview-1",
        projectId: "p1",
        reason,
      } as unknown as SitePreviewPushPayload);
    },
  };
  return host;
}

export type PreviewHostHandle = ReturnType<typeof createPreviewHost>;
