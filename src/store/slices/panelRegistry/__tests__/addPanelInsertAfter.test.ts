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
const { addToWorktreeIndex } = await import("../worktreeIndex");

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

/** Add a non-PTY panel through the real live commit branch. */
async function addBrowser(
  id: string,
  opts: {
    worktreeId?: string;
    location?: "grid" | "dock";
    insertAfterId?: string;
  }
): Promise<void> {
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
