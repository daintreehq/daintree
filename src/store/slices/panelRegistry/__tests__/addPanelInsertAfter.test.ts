/**
 * Tests for `AddPanelOptions.insertAfterId` (#12095).
 *
 * A duplicated panel must land directly after the panel it was copied from
 * rather than at the end of the list. The hint is resolved inside the commit
 * `set()`, so these tests assert both ordered structures — the flat `panelIds`
 * (which `getTabGroups` and the dock read) and the per-worktree bucket (which
 * `gridTerminals` iterates) — since an append in either one puts the copy in a
 * different place than the other.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BrowserPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => null),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: { globalEnv: { get: vi.fn().mockResolvedValue({}) } },
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { addToWorktreeIndex, collectUngroupedCandidateIds, NO_WORKTREE } =
  await import("../worktreeIndex");
const { buildDockRenderItems } = await import("@/components/Layout/dockRenderItems");
const { saveNormalized } = await import("../persistence");

/**
 * Seed a committed panel without going through `addPanel`, so a test's
 * starting order is exact. Mirrors the live commit: flat array plus bucket.
 */
function seed(
  id: string,
  worktreeId: string | undefined,
  location: "grid" | "dock" | "trash" = "grid"
): void {
  const panel: BrowserPanelData = {
    id,
    title: id,
    kind: "browser",
    location,
    worktreeId,
    isVisible: location === "grid",
  };
  usePanelStore.setState((state) => ({
    panelsById: { ...state.panelsById, [id]: panel },
    panelIds: [...state.panelIds, id],
    panelIdsByWorktreeId: addToWorktreeIndex(state.panelIdsByWorktreeId, worktreeId, id),
  }));
}

function panelIds(): string[] {
  return usePanelStore.getState().panelIds;
}

function bucket(worktreeId: string): string[] {
  return usePanelStore.getState().panelIdsByWorktreeId[worktreeId] ?? [];
}

interface AddOpts {
  worktreeId?: string;
  location?: "grid" | "dock";
  insertAfterId?: string;
}

/** Add a non-PTY panel through the real live commit branch. */
async function addBrowser(id: string, opts: AddOpts): Promise<void> {
  await usePanelStore.getState().addPanel({
    kind: "browser",
    requestedId: id,
    cwd: "",
    location: opts.location ?? "grid",
    worktreeId: opts.worktreeId,
    focusPolicy: "preserve",
    insertAfterId: opts.insertAfterId,
  });
}

/** Add a PTY panel through the real live commit branch. */
async function addTerminal(id: string, opts: AddOpts): Promise<void> {
  await usePanelStore.getState().addPanel({
    kind: "terminal",
    requestedId: id,
    cwd: "/tmp",
    location: opts.location ?? "grid",
    worktreeId: opts.worktreeId,
    focusPolicy: "preserve",
    insertAfterId: opts.insertAfterId,
  });
}

/**
 * Ordered dock panels the way `ContentDock` derives them, so a placement can be
 * checked against what the rail actually renders rather than only the store.
 */
function dockRenderOrder(worktreeId: string | undefined): string[][] {
  const state = usePanelStore.getState();
  const ordered = [];
  for (const id of collectUngroupedCandidateIds(
    state.panelIds,
    state.panelIdsByWorktreeId,
    worktreeId
  )) {
    const panel = state.panelsById[id];
    if (panel && panel.location === "dock" && !state.trashedTerminals.has(id)) ordered.push(panel);
  }
  return buildDockRenderItems(ordered, state.tabGroups, worktreeId ?? null).map(
    (item) => item.group.panelIds
  );
}

describe("addPanel insertAfterId (#12095)", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();
  });

  describe("non-PTY live commit", () => {
    it("lands the copy directly after its source in both ordered structures", async () => {
      seed("t1", "wt-A");
      seed("t2", "wt-A");
      seed("t3", "wt-A");

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "t1" });

      expect(panelIds()).toEqual(["t1", "copy", "t2", "t3"]);
      expect(bucket("wt-A")).toEqual(["t1", "copy", "t2", "t3"]);
    });

    it("appends when the hint is omitted", async () => {
      seed("t1", "wt-A");
      seed("t2", "wt-A");

      await addBrowser("copy", { worktreeId: "wt-A" });

      expect(panelIds()).toEqual(["t1", "t2", "copy"]);
      expect(bucket("wt-A")).toEqual(["t1", "t2", "copy"]);
    });

    it("keeps the copy adjacent in the dock, skipping interleaved grid panels", async () => {
      seed("d1", "wt-A", "dock");
      seed("g1", "wt-A", "grid");
      seed("d2", "wt-A", "dock");

      await addBrowser("copy", { worktreeId: "wt-A", location: "dock", insertAfterId: "d1" });

      expect(panelIds()).toEqual(["d1", "copy", "g1", "d2"]);
      expect(bucket("wt-A")).toEqual(["d1", "copy", "g1", "d2"]);
    });

    it("ignores panels from another worktree when placing the copy", async () => {
      seed("a1", "wt-A");
      seed("b1", "wt-B");
      seed("a2", "wt-A");

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "a1" });

      expect(panelIds()).toEqual(["a1", "copy", "b1", "a2"]);
      expect(bucket("wt-A")).toEqual(["a1", "copy", "a2"]);
      expect(bucket("wt-B")).toEqual(["b1"]);
    });
  });

  describe("tab-group anchoring", () => {
    it("anchors to the group's rendered slot when the source is a later member", async () => {
      // A grid group renders at its EARLIEST member's position, so inserting
      // after the active (later) member would drop the copy past `outsider`.
      seed("g1", "wt-A");
      seed("outsider", "wt-A");
      seed("g2", "wt-A");
      usePanelStore.getState().createTabGroup("grid", "wt-A", ["g1", "g2"]);

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "g2" });

      expect(panelIds()).toEqual(["g1", "copy", "outsider", "g2"]);
      expect(bucket("wt-A")).toEqual(["g1", "copy", "outsider", "g2"]);
      expect(
        usePanelStore
          .getState()
          .getTabGroups("grid", "wt-A")
          .map((g) => g.panelIds)
      ).toEqual([["g1", "g2"], ["copy"], ["outsider"]]);
    });

    it("leaves the copy ungrouped rather than folding it into the source's group", async () => {
      seed("g1", "wt-A");
      seed("g2", "wt-A");
      usePanelStore.getState().createTabGroup("grid", "wt-A", ["g1", "g2"]);

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "g1" });

      const groups = usePanelStore.getState().getTabGroups("grid", "wt-A");
      const explicit = groups.find((g) => g.panelIds.length > 1);
      expect(explicit?.panelIds).toEqual(["g1", "g2"]);
      expect(groups.map((g) => g.panelIds)).toEqual([["g1", "g2"], ["copy"]]);
    });
  });

  describe("fallbacks to append", () => {
    it("appends when the source sits on the other surface", async () => {
      seed("d1", "wt-A", "dock");
      seed("g1", "wt-A", "grid");

      await addBrowser("copy", { worktreeId: "wt-A", location: "grid", insertAfterId: "d1" });

      expect(panelIds()).toEqual(["d1", "g1", "copy"]);
      expect(bucket("wt-A")).toEqual(["d1", "g1", "copy"]);
    });

    it("appends when the source belongs to another worktree", async () => {
      seed("a1", "wt-A");
      seed("b1", "wt-B");

      await addBrowser("copy", { worktreeId: "wt-B", insertAfterId: "a1" });

      expect(panelIds()).toEqual(["a1", "b1", "copy"]);
      expect(bucket("wt-B")).toEqual(["b1", "copy"]);
      expect(bucket("wt-A")).toEqual(["a1"]);
    });

    it("appends when the source was trashed before the commit", async () => {
      seed("t1", "wt-A", "trash");
      seed("t2", "wt-A");

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "t1" });

      expect(panelIds()).toEqual(["t1", "t2", "copy"]);
      expect(bucket("wt-A")).toEqual(["t1", "t2", "copy"]);
    });

    it("appends when the source id no longer resolves", async () => {
      seed("t1", "wt-A");

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "gone" });

      expect(panelIds()).toEqual(["t1", "copy"]);
      expect(bucket("wt-A")).toEqual(["t1", "copy"]);
    });

    it("appends when the hint points at the panel being created", async () => {
      seed("t1", "wt-A");

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "copy" });

      expect(panelIds()).toEqual(["t1", "copy"]);
      expect(bucket("wt-A")).toEqual(["t1", "copy"]);
    });
  });

  describe("tab-group anchoring the renderers actually use", () => {
    it("anchors on the group's earliest PTY member in the dock, not a non-PTY one", async () => {
      // The dock resolves explicit groups PTY-only and chips every non-PTY
      // member standalone in place (#11332), so a browser member is not the
      // group's rendered slot even when it comes first.
      await addBrowser("bp", { worktreeId: "wt-A", location: "dock" });
      await addTerminal("outsider", { worktreeId: "wt-A", location: "dock" });
      await addTerminal("src", { worktreeId: "wt-A", location: "dock" });
      usePanelStore.getState().createTabGroup("dock", "wt-A", ["bp", "src"]);

      expect(dockRenderOrder("wt-A")).toEqual([["bp"], ["outsider"], ["src"]]);

      await addTerminal("copy", { worktreeId: "wt-A", location: "dock", insertAfterId: "src" });

      expect(panelIds()).toEqual(["bp", "outsider", "src", "copy"]);
      expect(dockRenderOrder("wt-A")).toEqual([["bp"], ["outsider"], ["src"], ["copy"]]);
    });

    it("skips a group member that is no longer in scope when picking the anchor", async () => {
      seed("stale", "wt-A", "trash");
      seed("g1", "wt-A");
      seed("outsider", "wt-A");
      seed("g2", "wt-A");
      usePanelStore.getState().createTabGroup("grid", "wt-A", ["stale", "g1", "g2"]);

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "g2" });

      // `stale` is trashed, so the group renders at `g1` and the copy follows it.
      expect(panelIds()).toEqual(["stale", "g1", "copy", "outsider", "g2"]);
      expect(bucket("wt-A")).toEqual(["stale", "g1", "copy", "outsider", "g2"]);
    });

    it("ignores a group pinned to another worktree and anchors on the source", async () => {
      seed("other", "wt-A");
      seed("outsider", "wt-A");
      seed("src", "wt-A");
      // A repaired/corrupt group scoped to wt-B is not rendered in wt-A at all,
      // so it must not move the copy either.
      usePanelStore.getState().createTabGroup("grid", "wt-B", ["other", "src"]);

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "src" });

      expect(panelIds()).toEqual(["other", "outsider", "src", "copy"]);
    });
  });

  describe("structures that disagree on order", () => {
    it("resolves the anchor in each structure independently", async () => {
      // A cross-worktree transfer appends to the destination bucket without
      // moving the flat id, so bucket order is not flat order projected by
      // worktree. Each structure must anchor on what it sees.
      seed("t1", "wt-A");
      seed("t2", "wt-A");
      seed("t3", "wt-A");
      usePanelStore.setState({ panelIdsByWorktreeId: { "wt-A": ["t2", "t3", "t1"] } });

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "t1" });

      expect(panelIds()).toEqual(["t1", "copy", "t2", "t3"]);
      expect(bucket("wt-A")).toEqual(["t2", "t3", "t1", "copy"]);
    });

    it("keeps a worktree-less dock source adjacent in the __none__ bucket", async () => {
      seed("global1", undefined, "dock");
      seed("global2", undefined, "dock");

      await addBrowser("copy", { location: "dock", insertAfterId: "global1" });

      expect(panelIds()).toEqual(["global1", "copy", "global2"]);
      expect(usePanelStore.getState().panelIdsByWorktreeId[NO_WORKTREE]).toEqual([
        "global1",
        "copy",
        "global2",
      ]);
    });
  });

  describe("hydration batches", () => {
    it("ignores the hint while a batch defers the panelIds append", async () => {
      seed("t1", "wt-A");
      seed("t2", "wt-A");

      const { beginHydrationBatch, flushHydrationBatch } = usePanelStore.getState();
      const token = beginHydrationBatch();
      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "t1" });

      // The bucket commits eagerly during a batch; it must not honor the hint,
      // or it would disagree with the plain append the flush performs.
      expect(bucket("wt-A")).toEqual(["t1", "t2", "copy"]);

      flushHydrationBatch(token);

      expect(panelIds()).toEqual(["t1", "t2", "copy"]);
      expect(bucket("wt-A")).toEqual(["t1", "t2", "copy"]);
    });
  });

  describe("persistence", () => {
    it("persists the anchored order, not the append order", async () => {
      seed("t1", "wt-A");
      seed("t2", "wt-A");
      vi.mocked(saveNormalized).mockClear();

      await addBrowser("copy", { worktreeId: "wt-A", insertAfterId: "t1" });

      const lastCall = vi.mocked(saveNormalized).mock.calls.at(-1);
      expect(lastCall?.[1]).toEqual(["t1", "copy", "t2"]);
    });
  });

  describe("PTY live commit", () => {
    it("lands a duplicated terminal directly after its source", async () => {
      seed("t1", "wt-A");
      seed("t2", "wt-A");

      await usePanelStore.getState().addPanel({
        kind: "terminal",
        requestedId: "copy",
        cwd: "/tmp",
        location: "grid",
        worktreeId: "wt-A",
        focusPolicy: "preserve",
        insertAfterId: "t1",
      });

      expect(panelIds()).toEqual(["t1", "copy", "t2"]);
      expect(bucket("wt-A")).toEqual(["t1", "copy", "t2"]);
    });

    it("appends a terminal when no hint is given", async () => {
      seed("t1", "wt-A");

      await usePanelStore.getState().addPanel({
        kind: "terminal",
        requestedId: "fresh",
        cwd: "/tmp",
        location: "grid",
        worktreeId: "wt-A",
        focusPolicy: "preserve",
      });

      expect(panelIds()).toEqual(["t1", "fresh"]);
      expect(bucket("wt-A")).toEqual(["t1", "fresh"]);
    });
  });
});
