// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, drafts, selection } = vi.hoisted(() => {
  const store = {
    panelsById: {} as Record<string, Record<string, unknown>>,
    panelIds: [] as string[],
    panelIdsByWorktreeId: {} as Record<string, string[]>,
    tabGroups: new Map<string, unknown>(),
    addPanel: vi.fn(async (args: { requestedId?: string; kind?: string }) => {
      const id = args.requestedId ?? "new";
      store.panelsById[id] = { id, kind: args.kind };
      return id;
    }),
    restoreTerminalOrder: vi.fn(),
    hydrateTabGroups: vi.fn(),
    removePanel: vi.fn(),
  };
  const drafts = {
    local: {} as Record<string, string>,
    getProjectDraftInputs: vi.fn(() => ({ ...drafts.local })),
    getDraftProjectIds: vi.fn(() => ["proj-1"]),
    restoreProjectDraftInputs: vi.fn((_projectId: string, restored: Record<string, string>) => {
      Object.assign(drafts.local, restored);
    }),
    clearDraftInput: vi.fn((terminalId: string) => {
      delete drafts.local[terminalId];
    }),
    bumpExternalDraftRevision: vi.fn(),
  };
  const selection = { setActiveWorktree: vi.fn() };
  return { store, drafts, selection };
});

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
const setDraftInputs = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/clients", () => ({ projectClient: { setDraftInputs } }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => store,
    setState: (update: (state: typeof store) => Partial<typeof store>) => {
      Object.assign(store, update(store));
    },
  },
}));
const { saveNormalized, saveTabGroups } = vi.hoisted(() => ({
  saveNormalized: vi.fn(),
  saveTabGroups: vi.fn(),
}));
vi.mock("@/store/slices/panelRegistry/persistence", () => ({ saveNormalized, saveTabGroups }));
vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: { getState: () => drafts },
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => selection },
}));
vi.mock("@/utils/stateHydration/statePatcher", () => ({
  inferKind: (saved: { kind?: string }) => saved.kind ?? "terminal",
  buildArgsForNonPtyRecreation: (saved: { id: string; location?: string }, kind: string) => ({
    kind,
    requestedId: saved.id,
    location: saved.location,
  }),
}));

import { refreshHostDrafts, rehydrateHostProjectState } from "../hostProjectRehydrate";
import { draftInputPersistence } from "../persistence/draftInputPersistence";
import {
  resetStoreAccessorsForTesting,
  setWorktreeIdSetAccessor,
  setWorktreeSelectionAccessor,
} from "../storeAccessors";

const hydrate = vi.fn();
const getDraftInputs = vi.fn();

function hostSaved(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "proj-1",
    project: { id: "proj-1", path: "/srv/proj-1" },
    appState: {
      activeWorktreeId: "wt-feature",
      terminals: [
        { id: "t1", kind: "terminal", location: "grid" },
        { id: "browser-1", kind: "browser", location: "grid" },
        { id: "notes", kind: "file", location: "dock" },
        { id: "gone", kind: "browser", location: "trash" },
      ],
    },
    tabGroups: [{ id: "g1", location: "grid", panelIds: ["t1", "browser-1"] }],
    draftInputs: { t1: "host draft", t2: "only on the host" },
    ...overrides,
  };
}

const current = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  store.panelsById = {
    t1: { id: "t1", kind: "terminal" },
    local: { id: "local", kind: "browser" },
  };
  drafts.local = { t1: "typed here" };
  draftInputPersistence.clearProject("proj-1");
  resetStoreAccessorsForTesting();
  setWorktreeSelectionAccessor(() => ({ activeWorktreeId: "wt-main", restoreWorktreeId: null }));
  setWorktreeIdSetAccessor(() => new Set(["wt-main", "wt-feature"]));
  Object.defineProperty(window, "electron", {
    value: { app: { hydrate }, project: { getDraftInputs } },
    writable: true,
    configurable: true,
  });
});

describe("rehydrateHostProjectState", () => {
  it("after a takeover: shows the host's saved panels in its order, groups, worktree and drafts, keeping everything live", async () => {
    hydrate.mockResolvedValue(hostSaved());
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });

    // Only the panels the view lacks, never a terminal (that would start a process) or a trashed one.
    expect(store.addPanel.mock.calls.map(([args]) => args.requestedId)).toEqual([
      "browser-1",
      "notes",
    ]);
    expect(store.addPanel.mock.calls[1]![0]).toMatchObject({
      location: "dock",
      bypassLimits: true,
    });
    expect(store.removePanel).not.toHaveBeenCalled();
    expect(store.restoreTerminalOrder).toHaveBeenCalledWith(["t1", "browser-1", "notes"]);
    expect(store.hydrateTabGroups).toHaveBeenCalledWith(
      [{ id: "g1", location: "grid", panelIds: ["t1", "browser-1"] }],
      { skipPersist: true }
    );
    expect(selection.setActiveWorktree).toHaveBeenCalledWith("wt-feature", { persist: false });
    // Drafts are host-owned: the host's wins.
    expect(drafts.restoreProjectDraftInputs).toHaveBeenCalledWith("proj-1", {
      t1: "host draft",
      t2: "only on the host",
    });
  });

  it("for the driver back on a fresh session: fills in what's missing, keeping what it changed while away", async () => {
    hydrate.mockResolvedValue(hostSaved());
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: false });

    expect(store.addPanel).toHaveBeenCalledTimes(2);
    expect(store.restoreTerminalOrder).not.toHaveBeenCalled();
    expect(store.hydrateTabGroups).not.toHaveBeenCalled();
    expect(selection.setActiveWorktree).not.toHaveBeenCalled();
    expect(drafts.restoreProjectDraftInputs).toHaveBeenCalledWith("proj-1", {
      t2: "only on the host",
    });
  });

  it("never overwrites a draft typed while the host's answer was on its way", async () => {
    hydrate.mockImplementation(async () => {
      drafts.local = { t1: "typed after taking over" };
      return hostSaved();
    });
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    expect(drafts.restoreProjectDraftInputs).toHaveBeenCalledWith("proj-1", {
      t2: "only on the host",
    });
  });

  it("ignores a worktree this view doesn't know", async () => {
    hydrate.mockResolvedValue(
      hostSaved({ appState: { activeWorktreeId: "wt-unknown", terminals: [] } })
    );
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    expect(selection.setActiveWorktree).not.toHaveBeenCalled();
  });

  it("applies nothing for another workspace's answer or once overtaken", async () => {
    hydrate.mockResolvedValue(hostSaved({ workspaceId: "proj-2" }));
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    hydrate.mockResolvedValue(hostSaved());
    await rehydrateHostProjectState("proj-1", { isCurrent: () => false, authoritative: true });

    expect(store.addPanel).not.toHaveBeenCalled();
    expect(store.hydrateTabGroups).not.toHaveBeenCalled();
    expect(drafts.restoreProjectDraftInputs).not.toHaveBeenCalled();
  });

  it("hands over the settings its answer carried, only for this view's current answer", async () => {
    const settings = {
      terminalConfig: { scrollbackLines: 5000 },
      agentSettings: { agents: {} },
      agentDefaults: { defaultAgent: "codex" },
    };
    const onHydrated = vi.fn();
    hydrate.mockResolvedValue(hostSaved({ workspaceId: "proj-2", ...settings }));
    await rehydrateHostProjectState("proj-1", {
      isCurrent: current,
      authoritative: false,
      onHydrated,
    });
    hydrate.mockResolvedValue(hostSaved(settings));
    await rehydrateHostProjectState("proj-1", {
      isCurrent: () => false,
      authoritative: false,
      onHydrated,
    });
    expect(onHydrated).not.toHaveBeenCalled();

    await rehydrateHostProjectState("proj-1", {
      isCurrent: current,
      authoritative: false,
      onHydrated,
    });
    expect(onHydrated).toHaveBeenCalledTimes(1);
    expect(onHydrated).toHaveBeenCalledWith(settings);
  });

  it("rebases draft persistence on the host's snapshot, so a restored draft that is then sent is deleted on the host", async () => {
    // This view hydrated before the host had any draft for the project.
    draftInputPersistence.primeProject("proj-1", {});
    drafts.local = {};
    hydrate.mockResolvedValue(hostSaved({ draftInputs: { t1: "host draft" } }));
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    expect(drafts.local).toEqual({ t1: "host draft" });

    // The person sends it before any flush.
    drafts.local = {};
    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();

    expect(setDraftInputs).toHaveBeenCalledWith("proj-1", {}, [], ["t1"]);
  });

  it("keeps an edit made during hydration as a change against the host's snapshot", async () => {
    draftInputPersistence.primeProject("proj-1", {});
    drafts.local = {};
    hydrate.mockImplementation(async () => {
      drafts.local = { t1: "typed while it hydrated" };
      return hostSaved({ draftInputs: { t1: "host draft", t2: "only on the host" } });
    });
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    expect(drafts.local).toEqual({ t1: "typed while it hydrated", t2: "only on the host" });

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();

    expect(setDraftInputs).toHaveBeenCalledWith(
      "proj-1",
      { t1: "typed while it hydrated", t2: "only on the host" },
      ["t1"],
      []
    );
  });

  it("drops a draft another driver sent or cleared on the host, so the next flush doesn't write it back", async () => {
    // This view last saw t1 and t3 on the host; t3 has been edited here since.
    draftInputPersistence.primeProject("proj-1", { t1: "stale draft", t3: "old" });
    drafts.local = { t1: "stale draft", t3: "edited here" };
    // Meanwhile the other driver sent t1 and cleared t3.
    hydrate.mockResolvedValue(hostSaved({ draftInputs: {} }));
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    expect(drafts.local).toEqual({ t3: "edited here" });
    // A mounted editor re-reads the store rather than keep showing t1.
    expect(drafts.bumpExternalDraftRevision).toHaveBeenCalled();

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();
    expect(setDraftInputs).toHaveBeenCalledTimes(1);
    expect(setDraftInputs).toHaveBeenCalledWith("proj-1", { t3: "edited here" }, ["t3"], []);
  });

  it("keeps a draft whose own write was acknowledged while the host's answer travelled", async () => {
    draftInputPersistence.primeProject("proj-1", {});
    drafts.local = { t1: "mine" };
    hydrate.mockImplementation(async () => {
      // The snapshot was taken before this view's write of t1 landed.
      draftInputPersistence.flushAll();
      await draftInputPersistence.whenIdle();
      return hostSaved({ draftInputs: {} });
    });
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });
    expect(drafts.local).toEqual({ t1: "mine" });
  });
});

describe("rehydrateHostProjectState following the driver (#13280)", () => {
  function watcherHas(panels: Array<Record<string, unknown> & { id: string }>) {
    store.panelsById = Object.fromEntries(panels.map((p) => [p.id, { ...p }]));
    store.panelIds = panels.map((p) => p.id);
    store.panelIdsByWorktreeId = {};
    for (const p of panels) {
      const key = typeof p.worktreeId === "string" ? p.worktreeId : "__none__";
      (store.panelIdsByWorktreeId[key] ??= []).push(p.id);
    }
  }

  const following = { isCurrent: current, authoritative: true, follow: true };

  it("moves panels where the driver filed them, and queues the layout as the host has it", async () => {
    watcherHas([
      { id: "t1", kind: "terminal", location: "grid", worktreeId: "wt-main", isVisible: true },
      { id: "browser-1", kind: "browser", location: "grid", worktreeId: "wt-main" },
      { id: "notes", kind: "file", location: "dock", worktreeId: "wt-main" },
    ]);
    hydrate.mockResolvedValue(
      hostSaved({
        appState: {
          terminals: [
            { id: "t1", kind: "terminal", location: "dock", worktreeId: "wt-feature" },
            { id: "browser-1", kind: "browser", location: "grid", worktreeId: "wt-feature" },
            // Filed globally on the host.
            { id: "notes", kind: "file", location: "dock" },
          ],
        },
      })
    );

    await rehydrateHostProjectState("proj-1", following);

    expect(store.panelsById.t1).toMatchObject({ location: "dock", worktreeId: "wt-feature" });
    // Left to the pane's own visibility observer, which sees the move.
    expect(store.panelsById.t1!.isVisible).toBe(true);
    expect(store.panelsById["browser-1"]).toMatchObject({
      location: "grid",
      worktreeId: "wt-feature",
    });
    expect(store.panelsById.notes!.worktreeId).toBeUndefined();
    expect(store.panelIdsByWorktreeId).toEqual({
      "wt-feature": ["t1", "browser-1"],
      __none__: ["notes"],
    });
    expect(saveNormalized).toHaveBeenCalledTimes(1);
    expect(saveNormalized.mock.calls[0]![0]).toBe(store.panelsById);
    expect(store.removePanel).not.toHaveBeenCalled();
  });

  it("queues the host's tab groups after taking them, over any a removal queued", async () => {
    watcherHas([
      { id: "t1", kind: "terminal", location: "grid" },
      { id: "closed", kind: "browser", location: "grid" },
    ]);
    hydrate.mockResolvedValue(hostSaved());

    await rehydrateHostProjectState("proj-1", following);

    expect(store.removePanel).toHaveBeenCalledWith("closed");
    expect(saveTabGroups).toHaveBeenCalledTimes(1);
    expect(saveTabGroups).toHaveBeenCalledWith(store.tabGroups);
    expect(saveTabGroups.mock.invocationCallOrder[0]!).toBeGreaterThan(
      store.hydrateTabGroups.mock.invocationCallOrder[0]!
    );
  });

  it("drops what the driver closed, keeping this screen's own panels and running terminals", async () => {
    watcherHas([
      { id: "kept", kind: "browser", location: "grid", worktreeId: "wt-main" },
      { id: "closed", kind: "browser", location: "grid", worktreeId: "wt-main" },
      { id: "t-closed", kind: "terminal", location: "grid", runtimeStatus: "exited" },
      { id: "t-running", kind: "terminal", location: "grid", runtimeStatus: "running" },
      {
        id: "assistant",
        kind: "terminal",
        location: "dock",
        exitCode: 0,
        excludeFromPersistence: true,
      },
      { id: "preview", kind: "dev-preview", location: "grid" },
      { id: "modal", kind: "browser", location: "dialog" },
    ]);
    hydrate.mockResolvedValue(
      hostSaved({
        appState: {
          terminals: [{ id: "kept", kind: "browser", location: "grid", worktreeId: "wt-main" }],
        },
      })
    );

    await rehydrateHostProjectState("proj-1", following);

    expect(store.removePanel.mock.calls).toEqual([
      ["closed"],
      ["t-closed", { backendAlreadyClosed: true }],
    ]);
    expect(saveNormalized).not.toHaveBeenCalled();
  });

  it("neither moves nor drops anything when not following", async () => {
    watcherHas([
      { id: "t1", kind: "terminal", location: "grid", worktreeId: "wt-main" },
      { id: "closed", kind: "browser", location: "grid", worktreeId: "wt-main" },
    ]);
    hydrate.mockResolvedValue(
      hostSaved({
        appState: {
          terminals: [{ id: "t1", kind: "terminal", location: "dock", worktreeId: "wt-feature" }],
        },
      })
    );

    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: true });

    expect(store.panelsById.t1).toMatchObject({ location: "grid", worktreeId: "wt-main" });
    expect(store.removePanel).not.toHaveBeenCalled();
    expect(saveNormalized).not.toHaveBeenCalled();
    expect(saveTabGroups).not.toHaveBeenCalled();
  });
});

describe("refreshHostDrafts — following the driver's drafts (#13283)", () => {
  beforeEach(() => {
    drafts.local = {};
  });

  it("shows the driver's drafts as the host now holds them, and nothing else", async () => {
    getDraftInputs.mockResolvedValue({ t1: "driver typing" });

    await refreshHostDrafts("proj-1", { isCurrent: current });

    expect(getDraftInputs).toHaveBeenCalledWith("proj-1");
    expect(hydrate).not.toHaveBeenCalled();
    expect(store.addPanel).not.toHaveBeenCalled();
    expect(drafts.local).toEqual({ t1: "driver typing" });
    expect(drafts.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);
    expect(draftInputPersistence.getBaseline("proj-1")).toEqual({ t1: "driver typing" });
  });

  it("takes each edit over the last one it showed", async () => {
    getDraftInputs.mockResolvedValueOnce({ t1: "dri" });
    await refreshHostDrafts("proj-1", { isCurrent: current });
    getDraftInputs.mockResolvedValueOnce({ t1: "driver" });
    await refreshHostDrafts("proj-1", { isCurrent: current });

    expect(drafts.local).toEqual({ t1: "driver" });
  });

  it("clears a draft the driver sent or cleared", async () => {
    getDraftInputs.mockResolvedValueOnce({ t1: "about to send", t2: "kept" });
    await refreshHostDrafts("proj-1", { isCurrent: current });
    getDraftInputs.mockResolvedValueOnce({ t2: "kept" });
    await refreshHostDrafts("proj-1", { isCurrent: current });

    expect(drafts.local).toEqual({ t2: "kept" });
    expect(drafts.clearDraftInput).toHaveBeenCalledWith("t1", "proj-1");
    expect(draftInputPersistence.getBaseline("proj-1")).toEqual({ t2: "kept" });
  });

  it("doesn't bump mounted editors when nothing it shows changed", async () => {
    getDraftInputs.mockResolvedValue({ t1: "same" });
    await refreshHostDrafts("proj-1", { isCurrent: current });
    drafts.bumpExternalDraftRevision.mockClear();

    await refreshHostDrafts("proj-1", { isCurrent: current });

    expect(drafts.bumpExternalDraftRevision).not.toHaveBeenCalled();
  });

  it("keeps a draft of its own the host never held", async () => {
    drafts.local = { t9: "typed here before the project was taken" };
    getDraftInputs.mockResolvedValue({ t1: "driver typing" });

    await refreshHostDrafts("proj-1", { isCurrent: current });

    expect(drafts.local).toEqual({
      t1: "driver typing",
      t9: "typed here before the project was taken",
    });
  });

  it("never applies an older read of the drafts over a newer one", async () => {
    // A full rehydrate asks first; a draft refresh asks after and answers first.
    let answerHydrate!: (value: unknown) => void;
    hydrate.mockImplementationOnce(() => new Promise((resolve) => (answerHydrate = resolve)));
    const rehydrating = rehydrateHostProjectState("proj-1", {
      isCurrent: current,
      authoritative: true,
    });
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalled());
    getDraftInputs.mockResolvedValueOnce({ t1: "newer" });
    await refreshHostDrafts("proj-1", { isCurrent: current });

    answerHydrate(hostSaved({ draftInputs: { t1: "older" } }));
    await rehydrating;

    expect(drafts.local).toEqual({ t1: "newer" });
    expect(draftInputPersistence.getBaseline("proj-1")).toEqual({ t1: "newer" });
  });

  it("lets a takeover's answer land after a later merge-style resync's", async () => {
    drafts.local = { t1: "stale here" };
    let answerTakeover!: (value: unknown) => void;
    hydrate.mockImplementationOnce(() => new Promise((resolve) => (answerTakeover = resolve)));
    const takingOver = rehydrateHostProjectState("proj-1", {
      isCurrent: current,
      authoritative: true,
    });
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    hydrate.mockResolvedValueOnce(hostSaved({ draftInputs: { t1: "host latest" } }));
    await rehydrateHostProjectState("proj-1", { isCurrent: current, authoritative: false });
    expect(drafts.local).toEqual({ t1: "stale here" });

    answerTakeover(hostSaved({ draftInputs: { t1: "host latest" } }));
    await takingOver;

    expect(drafts.local).toEqual({ t1: "host latest" });
  });

  it("applies nothing once overtaken", async () => {
    getDraftInputs.mockResolvedValue({ t1: "stale" });
    let live = true;
    const pending = refreshHostDrafts("proj-1", { isCurrent: () => live });
    live = false;
    await pending;

    expect(drafts.restoreProjectDraftInputs).not.toHaveBeenCalled();
    expect(draftInputPersistence.getBaseline("proj-1")).toBeUndefined();
  });
});
