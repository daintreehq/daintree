import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectState, TerminalSnapshot, TabGroup } from "../../../types/index.js";

// Capture the updater the handler enqueues so we can run it against a chosen
// on-disk state and assert the merged result, without a real ProjectStore.
const projectStoreMock = vi.hoisted(() => ({
  enqueueProjectStateUpdate: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import { terminalLayoutNamespace } from "../terminalLayout.js";

const setTerminals = terminalLayoutNamespace.ops.setTerminals.handler as (payload: {
  projectId: string;
  terminals: TerminalSnapshot[];
  changedIds?: string[];
  removedIds?: string[];
}) => Promise<void>;

const setTabGroups = terminalLayoutNamespace.ops.setTabGroups.handler as (payload: {
  projectId: string;
  tabGroups: TabGroup[];
  changedIds?: string[];
  removedIds?: string[];
}) => Promise<void>;

const setDraftInputs = terminalLayoutNamespace.ops.setDraftInputs.handler as (payload: {
  projectId: string;
  draftInputs: Record<string, string>;
  changedIds?: string[];
  removedIds?: string[];
}) => Promise<void>;

function term(id: string, location: "grid" | "dock" = "grid"): TerminalSnapshot {
  // `cwd` is required by TerminalSnapshotSchema's refine for PTY-backed kinds
  // (kind defaults to "terminal"); without it sanitizeTerminals drops the entry.
  return { id, title: `T${id}`, cwd: "/tmp", location } as TerminalSnapshot;
}

function group(id: string, panelIds: string[]): TabGroup {
  return { id, location: "grid", panelIds, activeTabId: panelIds[0]! } as TabGroup;
}

/** Arrange the on-disk state and return an accessor for the saved result. */
function onDisk(existing: ProjectState | null): () => ProjectState | null {
  let saved: ProjectState | null = null;
  projectStoreMock.enqueueProjectStateUpdate.mockImplementation(
    async (
      _projectId: string,
      updater: (s: ProjectState | null) => ProjectState | null | Promise<ProjectState | null>
    ) => {
      saved = await updater(existing);
    }
  );
  return () => saved;
}

function ids(entries: { id: string }[] | undefined): string[] {
  return (entries ?? []).map((e) => e.id);
}

const baseState = (terminals: TerminalSnapshot[], tabGroups: TabGroup[] = []): ProjectState => ({
  projectId: "p1",
  sidebarWidth: 350,
  terminals,
  tabGroups,
});

beforeEach(() => {
  projectStoreMock.enqueueProjectStateUpdate.mockReset();
});

describe("setTerminals merge (#11350)", () => {
  it("preserves a sibling window's addition the writer never knew", async () => {
    const saved = onDisk(baseState([term("1"), term("2"), term("3"), term("4")]));
    await setTerminals({
      projectId: "p1",
      terminals: [term("1"), term("2"), term("3")],
      changedIds: [],
      removedIds: [],
    });
    expect(new Set(ids(saved()?.terminals))).toEqual(new Set(["1", "2", "3", "4"]));
  });

  it("persists an explicit close via removedIds", async () => {
    const saved = onDisk(baseState([term("1"), term("2"), term("3")]));
    await setTerminals({
      projectId: "p1",
      terminals: [term("1"), term("3")],
      changedIds: [],
      removedIds: ["2"],
    });
    expect(ids(saved()?.terminals)).toEqual(["1", "3"]);
  });

  it("does not resurrect a sibling-deleted entry the writer did not change", async () => {
    // Sibling already deleted 2 (disk = [1]); this stale writer adds 3.
    const saved = onDisk(baseState([term("1")]));
    await setTerminals({
      projectId: "p1",
      terminals: [term("1"), term("2"), term("3")],
      changedIds: ["3"],
      removedIds: [],
    });
    expect(ids(saved()?.terminals)).toEqual(["1", "3"]);
  });

  it("preserves a disjoint move by a sibling window", async () => {
    // Sibling moved panel 1 to the dock (disk); this stale writer still has it
    // in the grid and only added panel 2.
    const saved = onDisk(baseState([term("1", "dock")]));
    await setTerminals({
      projectId: "p1",
      terminals: [term("1", "grid"), term("2")],
      changedIds: ["2"],
      removedIds: [],
    });
    const merged = saved()?.terminals ?? [];
    expect(merged.find((t) => t.id === "1")?.location).toBe("dock");
    expect(ids(merged)).toContain("2");
  });

  it("full-replaces when no delta metadata is supplied (legacy path)", async () => {
    const saved = onDisk(baseState([term("1"), term("2"), term("3")]));
    await setTerminals({ projectId: "p1", terminals: [term("1")] });
    expect(ids(saved()?.terminals)).toEqual(["1"]);
  });
});

describe("two-writer composition (#11350)", () => {
  /** A mutable disk so two queued writers see each other's committed result. */
  function statefulDisk(initial: ProjectState | null): () => ProjectState | null {
    let disk = initial;
    projectStoreMock.enqueueProjectStateUpdate.mockImplementation(
      async (
        _projectId: string,
        updater: (s: ProjectState | null) => ProjectState | null | Promise<ProjectState | null>
      ) => {
        disk = await updater(disk);
      }
    );
    return () => disk;
  }

  it("preserves a move from writer A and an addition from stale writer B", async () => {
    const disk = statefulDisk(baseState([term("1", "grid")]));

    // A moves panel 1 to the dock.
    await setTerminals({
      projectId: "p1",
      terminals: [term("1", "dock")],
      changedIds: ["1"],
      removedIds: [],
    });
    // B never saw the move (still holds panel 1 in the grid) and adds panel 2.
    await setTerminals({
      projectId: "p1",
      terminals: [term("1", "grid"), term("2")],
      changedIds: ["2"],
      removedIds: [],
    });

    const merged = disk()?.terminals ?? [];
    expect(merged.find((t) => t.id === "1")?.location).toBe("dock");
    expect(ids(merged)).toEqual(["1", "2"]);
  });

  it("resolves edit-vs-delete of the same id by queue order (last writer wins)", async () => {
    const disk = statefulDisk(baseState([term("1"), term("2", "grid")]));

    // A closes panel 2.
    await setTerminals({
      projectId: "p1",
      terminals: [term("1")],
      changedIds: [],
      removedIds: ["2"],
    });
    // B, which ran second, edited panel 2 (moved it to the dock).
    await setTerminals({
      projectId: "p1",
      terminals: [term("1"), term("2", "dock")],
      changedIds: ["2"],
      removedIds: [],
    });

    const merged = disk()?.terminals ?? [];
    expect(merged.find((t) => t.id === "2")?.location).toBe("dock");
    expect(ids(merged)).toEqual(["1", "2"]);
  });
});

describe("setTabGroups merge (#11350)", () => {
  it("preserves a sibling's tab group the writer never knew", async () => {
    const saved = onDisk(baseState([], [group("g1", ["1", "2"]), group("gSib", ["3", "4"])]));
    await setTabGroups({
      projectId: "p1",
      tabGroups: [group("g1", ["1", "2"])],
      changedIds: [],
      removedIds: [],
    });
    expect(new Set(ids(saved()?.tabGroups))).toEqual(new Set(["g1", "gSib"]));
  });

  it("removes a tab group via removedIds", async () => {
    const saved = onDisk(baseState([], [group("g1", ["1", "2"]), group("g2", ["3", "4"])]));
    await setTabGroups({
      projectId: "p1",
      tabGroups: [group("g1", ["1", "2"])],
      changedIds: [],
      removedIds: ["g2"],
    });
    expect(ids(saved()?.tabGroups)).toEqual(["g1"]);
  });
});

const draftState = (draftInputs: Record<string, string>): ProjectState => ({
  projectId: "p1",
  sidebarWidth: 350,
  terminals: [],
  tabGroups: [],
  draftInputs,
});

describe("setDraftInputs merge (#11352)", () => {
  it("preserves a sibling window's draft the writer never knew", async () => {
    const saved = onDisk(draftState({ t1: "old", sib: "sibling draft" }));
    await setDraftInputs({
      projectId: "p1",
      draftInputs: { t1: "new" },
      changedIds: ["t1"],
      removedIds: [],
    });
    expect(saved()?.draftInputs).toEqual({ t1: "new", sib: "sibling draft" });
  });

  it("removes a cleared draft via removedIds while keeping siblings — the tombstone case", async () => {
    const saved = onDisk(draftState({ t1: "gone", sib: "keep" }));
    // Current record is empty (draft was cleared) but removedIds carries the
    // tombstone; a naive `{}` full-replace would wipe the sibling too.
    await setDraftInputs({
      projectId: "p1",
      draftInputs: {},
      changedIds: [],
      removedIds: ["t1"],
    });
    expect(saved()?.draftInputs).toEqual({ sib: "keep" });
  });

  it("does not resurrect a sibling-deleted draft the writer did not change", async () => {
    // Disk no longer has t2 (a sibling cleared it); a stale writer still carries
    // it but only added t3.
    const saved = onDisk(draftState({ t1: "a" }));
    await setDraftInputs({
      projectId: "p1",
      draftInputs: { t1: "a", t2: "stale", t3: "added" },
      changedIds: ["t3"],
      removedIds: [],
    });
    expect(saved()?.draftInputs).toEqual({ t1: "a", t3: "added" });
  });

  it("falls back to a full replace when no delta metadata is present (legacy)", async () => {
    const saved = onDisk(draftState({ t1: "old", sib: "would be lost" }));
    await setDraftInputs({ projectId: "p1", draftInputs: { t1: "new" } });
    expect(saved()?.draftInputs).toEqual({ t1: "new" });
  });
});
