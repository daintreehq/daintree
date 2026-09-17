import { vi } from "vitest";
import { createHash } from "node:crypto";
import type {
  SiteGuestNodeObservation,
  SitePreviewBindingState,
  SitePreviewCandidate,
  SitePreviewMode,
  SitePreviewPushPayload,
} from "@shared/types/ipc/sitePreview";
import { CHANNELS, PLUGIN_ID } from "../../shared/protocol";
import type { EditCapability, EditReceipt, SelectedNode, SiteSelection } from "../../shared/model";

export const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const WORKTREE = "/repo";
export const FILE = "src/routes/pricing/+page.svelte";
export const SOURCE = [
  "<script>",
  "  let plan = 'pro';",
  "</script>",
  "",
  '<article class="card">',
  '  <button class="px-6 py-3 rounded-lg" type="button">Start Pro</button>',
  "</article>",
  "",
].join("\n");
export const REVISION = sha(SOURCE);
export const BUTTON_START = SOURCE.indexOf("<button");
export const BUTTON_END = SOURCE.indexOf("</button>") + "</button>".length;
export const BUTTON_RANGE = { start: BUTTON_START, end: BUTTON_END };

export const OBSERVATION: SiteGuestNodeObservation = {
  runtimeOccurrenceId: "occ-1",
  loc: { file: FILE, line: 6, column: 2 },
  ancestry: [],
  tagName: "BUTTON",
  sameLocCount: 3,
  locIndex: 2,
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
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
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
        ancestry: [
          {
            kind: "component",
            location: { file: ".svelte-kit/generated/root.svelte", line: 1, column: 0 },
            generated: true,
          },
          {
            kind: "component",
            location: { file: "src/lib/PricingCard.svelte", line: 3, column: 0 },
            componentTag: "PricingCard",
            generated: false,
          },
          {
            kind: "each",
            location: { file: FILE, line: 4, column: 0 },
            generated: false,
          },
        ],
        mapping: "exact",
        label: 'button "Start Pro"',
        bounds: [],
        capabilities: overrides.capabilities ?? DIRECT,
        surfaces: overrides.surfaces ?? {
          classes: { tokens: ["px-6", "py-3", "rounded-lg"] },
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
    afterRevision: sha(SOURCE + "changed"),
    appliedRange: BUTTON_RANGE,
    sourceSaved: true,
    previewRefreshed: null,
    stylesGenerated: null,
    affectedOccurrences: 1,
    appliedAt: "2026-09-16T00:00:01.000Z",
    ...overrides,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;

/**
 * Stand-ins for both halves the view talks to: the site-preview bridge and
 * plugin main behind `window.electron.plugin`. Pushes are delivered
 * synchronously, exactly as the preload delivers them.
 */
export function createFakeHost() {
  let candidates: SitePreviewCandidate[] = [
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

  const sitePreview = {
    listCandidates: vi.fn(async () => candidates),
    bind: vi.fn(
      async (request: { panelId: string; runtimeSource: string; mode?: SitePreviewMode }) =>
        state(request.panelId, request.mode ?? "browse")
    ),
    detach: vi.fn(async (_request: { sessionId: string }) => undefined),
    setMode: vi.fn(async (request: { sessionId: string; mode: SitePreviewMode }) =>
      state("preview-1", request.mode)
    ),
    // As the real guest does: find the element compiled from `loc`, select it
    // — as a member of the component invoked at `component`, when one is
    // named — and emit a fresh observation on the next tick. `reselectFinds`
    // lets a test model a page where the element is gone.
    reselect: vi.fn(
      async (request: {
        sessionId: string;
        loc: SiteGuestNodeObservation["loc"];
        index?: number;
        component?: { file: string; line: number; column: number };
      }) => {
        if (!host.reselectFinds) return false;
        const component = request.component;
        setTimeout(
          () =>
            host.select(
              host.currentEpoch,
              [{ ...OBSERVATION, loc: request.loc, locIndex: request.index ?? 0 }],
              "reselect",
              component ? { ...component, name: host.componentNameAt(component) } : null
            ),
          0
        );
        return true;
      }
    ),
    clearSelection: vi.fn(async (_request: { sessionId: string }) => undefined),
    getState: vi.fn(async (_request: { sessionId: string }) => null),
    onEvent: vi.fn((callback: (payload: SitePreviewPushPayload) => void) => {
      previewListeners.add(callback);
      return () => previewListeners.delete(callback);
    }),
  };

  handlers.set(CHANNELS.workspaceOpen, () => ({
    status: "ready",
    workspaceSessionId: "ws-1",
    appRoot: WORKTREE,
    support: { level: "full" },
  }));
  // As real main does, a resolve reports the revision now on disk — which a
  // write moved. Without this a re-proof after an edit could never match the
  // revision the write produced, and continuity could never be exercised.
  handlers.set(CHANNELS.selectionResolve, (args) => {
    const selection = makeSelection({
      documentEpoch: args.documentEpoch as number,
      ...(host.ancestry ? { node: { ancestry: host.ancestry } } : {}),
    });
    const node = selection.nodes[0]!;
    if (node.definition) node.definition.revision = host.diskRevision;
    return { status: "ok", selection };
  });
  handlers.set(CHANNELS.classComplete, (args) => {
    const query = String(args.query);
    const known = ["shadow-md", "shadow-lg", "px-8"];
    return {
      status: "ok",
      candidates: known
        .filter((candidate) => candidate.startsWith(query))
        .map((candidate) => ({ candidate, css: `/* ${candidate} */` })),
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
  handlers.set(CHANNELS.tailwindStatus, () => ({ status: "available", skippedModules: [] }));
  handlers.set(CHANNELS.classDescribe, (args) => ({
    status: "ok",
    css: ["px-6", "px-8", "py-3", "rounded-lg", "shadow-md", "hover:px-8"].includes(
      String(args.token)
    )
      ? `/* ${String(args.token)} */`
      : null,
    partial: false,
  }));
  handlers.set(CHANNELS.editApply, () => {
    const receipt = makeReceipt({ beforeRevision: host.diskRevision });
    host.diskRevision = receipt.afterRevision;
    return { status: "applied", receipt };
  });
  handlers.set(CHANNELS.editUndo, () => ({
    status: "reversed",
    receipt: makeReceipt({ transactionId: "tx-2" }),
  }));
  handlers.set(CHANNELS.workspaceClose, () => ({ closed: true }));
  handlers.set(CHANNELS.componentDefinitions, (args) => ({
    definitions: (args.callSites as Array<{ file: string; line: number; column: number }>).map(
      (site) => ({
        ...site,
        name: null,
        definedIn: null,
        revision: REVISION,
        definedInRevision: null,
      })
    ),
  }));
  /** What main would hash on disk now; a file absent here reads as the fixture source. */
  const diskRevisions = new Map<string, string | null>();
  handlers.set(CHANNELS.sourceRevisions, (args) => ({
    revisions: (args.files as string[]).map((file) => ({
      file,
      revision: diskRevisions.has(file) ? diskRevisions.get(file)! : REVISION,
    })),
  }));

  const invoke = vi.fn(async (pluginId: string, channel: string, args: unknown) => {
    if (pluginId !== PLUGIN_ID) throw new Error(`unexpected plugin ${pluginId}`);
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`fake main: no handler for ${channel}`);
    return handler(args as Record<string, unknown>);
  });
  const on = vi.fn((_pluginId: string, channel: string, callback: (payload: unknown) => void) => {
    let set = pluginListeners.get(channel);
    if (!set) {
      set = new Set();
      pluginListeners.set(channel, set);
    }
    set.add(callback);
    return () => set!.delete(callback);
  });

  const host = {
    sitePreview,
    diskRevisions,
    reselectFinds: true,
    /** The chain main resolves for the fixture element, innermost first; null for the fixture's own. */
    ancestry: null as SelectedNode["ancestry"] | null,
    currentEpoch: 0,
    /** What main would hash on disk now; each applied write moves it. */
    diskRevision: REVISION,
    invoke,
    handlers,
    listenerCounts() {
      let plugin = 0;
      for (const set of pluginListeners.values()) plugin += set.size;
      return { preview: previewListeners.size, plugin };
    },
    setCandidates(next: SitePreviewCandidate[]) {
      candidates = next;
    },
    calls(channel: string): Array<Record<string, unknown>> {
      return invoke.mock.calls
        .filter((call) => call[1] === channel)
        .map((call) => call[2] as Record<string, unknown>);
    },
    pushPreview(payload: SitePreviewPushPayload) {
      for (const listener of [...previewListeners]) listener(payload);
    },
    pushPlugin(channel: string, payload: unknown) {
      for (const listener of [...(pluginListeners.get(channel) ?? [])]) listener(payload);
    },
    documentReady(epoch: number, sessionId = "session-1") {
      host.currentEpoch = epoch;
      host.pushPreview({
        kind: "guest-event",
        sessionId,
        panelId: "preview-1",
        projectId: "p1",
        documentEpoch: epoch,
        sequence: 0,
        event: {
          type: "documentReady",
          routeId: "/pricing",
          url: "http://localhost:5173/pricing?plan=pro",
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        },
      });
    },
    /** What the page calls the component invoked at a call site on the fixture chain. */
    componentNameAt(site: { file: string; line: number; column: number }): string {
      const entry = (host.ancestry ?? makeSelection().nodes[0]!.ancestry).find(
        (candidate) =>
          candidate.kind === "component" &&
          candidate.location.file === site.file &&
          candidate.location.line === site.line &&
          candidate.location.column === site.column
      );
      return entry?.componentTag ?? "Component";
    },
    select(
      epoch: number,
      nodes: SiteGuestNodeObservation[] = [OBSERVATION],
      cause: "user" | "document" | "reselect" = "user",
      component: { file: string; line: number; column: number; name: string } | null = null
    ) {
      host.pushPreview({
        kind: "guest-event",
        sessionId: "session-1",
        panelId: "preview-1",
        projectId: "p1",
        documentEpoch: epoch,
        sequence: 1,
        event: {
          type: "selectionChanged",
          nodes,
          cause,
          ...(component ? { scope: "component", component } : {}),
        },
      });
    },
    epochAdvanced(epoch: number) {
      host.pushPreview({
        kind: "epoch-advanced",
        sessionId: "session-1",
        projectId: "p1",
        documentEpoch: epoch,
      });
    },
    install(): () => void {
      const previous = (window as { electron?: unknown }).electron;
      (window as unknown as { electron: unknown }).electron = {
        sitePreview,
        plugin: { invoke, on },
      };
      return () => {
        (window as unknown as { electron: unknown }).electron = previous;
      };
    },
  };
  return host;
}

export type FakeHost = ReturnType<typeof createFakeHost>;
