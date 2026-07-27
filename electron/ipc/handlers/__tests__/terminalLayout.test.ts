import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectState, TerminalSnapshot, TabGroup } from "../../../types/index.js";

// Capture the updater the handler enqueues so we can run it against a chosen
// on-disk state and assert the merged result, without a real ProjectStore.
const projectStoreMock = vi.hoisted(() => ({
  enqueueProjectStateUpdate: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import { terminalLayoutNamespace, sanitizeFieldEdits } from "../terminalLayout.js";

const setTerminals = terminalLayoutNamespace.ops.setTerminals.handler as (payload: {
  projectId: string;
  terminals: TerminalSnapshot[];
  changedIds?: string[];
  removedIds?: string[];
  fieldEdits?: unknown;
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

describe("setTerminals session-id preservation (#11461)", () => {
  const withSession = (
    id: string,
    agentSessionId?: string,
    extra: Partial<TerminalSnapshot> = {}
  ): TerminalSnapshot => ({
    ...term(id),
    launchAgentId: "codex",
    ...(agentSessionId && { agentSessionId }),
    ...extra,
  });

  const sessionIdOf = (state: ProjectState | null, id: string): string | undefined =>
    state?.terminals?.find((t) => t.id === id)?.agentSessionId;

  it("keeps a shutdown-captured session id when the writer omits it", async () => {
    const saved = onDisk(baseState([withSession("1", "captured")]));

    await setTerminals({
      projectId: "p1",
      terminals: [withSession("1")],
      changedIds: ["1"],
      removedIds: [],
    });

    expect(sessionIdOf(saved(), "1")).toBe("captured");
  });

  it("clears the stored session id when the writer claims the change", async () => {
    const saved = onDisk(baseState([withSession("1", "stale")]));

    await setTerminals({
      projectId: "p1",
      terminals: [withSession("1")],
      changedIds: ["1"],
      removedIds: [],
      fieldEdits: [{ id: "1", fields: ["agentSessionId"] }],
    });

    expect(sessionIdOf(saved(), "1")).toBeUndefined();
  });

  it("does not let a stale sibling window resurrect a consumed session id", async () => {
    // Window A already consumed and cleared the session, so disk has none.
    // Window B is stale, still carries the old id, and saves for an unrelated
    // reason without claiming the field.
    const saved = onDisk(baseState([withSession("1", undefined, { agentState: "idle" })]));

    await setTerminals({
      projectId: "p1",
      terminals: [withSession("1", "consumed", { agentState: "exited" })],
      changedIds: ["1"],
      removedIds: [],
    });

    expect(sessionIdOf(saved(), "1")).toBeUndefined();
    expect(saved()?.terminals?.find((t) => t.id === "1")?.agentState).toBe("exited");
  });

  it("ignores field names outside the allowlist", async () => {
    const saved = onDisk(baseState([withSession("1", "captured")]));

    await setTerminals({
      projectId: "p1",
      terminals: [withSession("1", undefined, { title: "renamed" })],
      changedIds: ["1"],
      removedIds: [],
      fieldEdits: [{ id: "1", fields: ["title", "cwd"] }],
    });

    const entry = saved()?.terminals?.find((t) => t.id === "1");
    expect(entry?.agentSessionId).toBe("captured");
    expect(entry?.title).toBe("renamed");
    expect(entry?.cwd).toBe("/tmp");
  });

  it("survives malformed claim metadata without dropping the stored id", async () => {
    const saved = onDisk(baseState([withSession("1", "captured")]));

    await setTerminals({
      projectId: "p1",
      terminals: [withSession("1")],
      changedIds: ["1"],
      removedIds: [],
      fieldEdits: [null, "nope", { id: 7, fields: ["agentSessionId"] }, { id: "1" }],
    });

    expect(sessionIdOf(saved(), "1")).toBe("captured");
  });

  it("does not let one entry's tombstone clear another's session id", async () => {
    const saved = onDisk(baseState([withSession("1", "keep-a"), withSession("2", "keep-b")]));

    await setTerminals({
      projectId: "p1",
      terminals: [withSession("1"), withSession("2")],
      changedIds: ["1", "2"],
      removedIds: [],
      fieldEdits: [{ id: "1", fields: ["agentSessionId"] }],
    });

    expect(sessionIdOf(saved(), "1")).toBeUndefined();
    expect(sessionIdOf(saved(), "2")).toBe("keep-b");
  });

  it("full-replace still drops an omitted session id (legacy contract unchanged)", async () => {
    const saved = onDisk(baseState([withSession("1", "captured")]));

    await setTerminals({ projectId: "p1", terminals: [withSession("1")] });

    expect(sessionIdOf(saved(), "1")).toBeUndefined();
  });
});

describe("sanitizeFieldEdits (#11461 trust boundary)", () => {
  // Asserted directly: the merge independently ignores unknown fields, so a
  // handler-level test alone would still pass with the sanitizer bypassed.
  it("keeps only allowlisted field names", () => {
    expect(sanitizeFieldEdits([{ id: "1", fields: ["agentSessionId", "title", "cwd"] }])).toEqual([
      { id: "1", fields: ["agentSessionId"] },
    ]);
  });

  it("returns undefined when nothing survives", () => {
    expect(sanitizeFieldEdits([{ id: "1", fields: ["title"] }])).toBeUndefined();
    expect(sanitizeFieldEdits([])).toBeUndefined();
    expect(sanitizeFieldEdits("nope")).toBeUndefined();
    expect(sanitizeFieldEdits(undefined)).toBeUndefined();
  });

  it("drops entries with an unusable id or fields list", () => {
    expect(
      sanitizeFieldEdits([
        null,
        "nope",
        { id: 7, fields: ["agentSessionId"] },
        { id: "", fields: ["agentSessionId"] },
        { id: "ok", fields: "agentSessionId" },
        { id: "ok", fields: ["agentSessionId"] },
      ])
    ).toEqual([{ id: "ok", fields: ["agentSessionId"] }]);
  });

  it("carries a prototype-chain id through as plain data", () => {
    // Kept as an ordinary string id; the merge keys claims in a Map, so it can
    // never reach Object.prototype downstream.
    const sanitized = sanitizeFieldEdits([{ id: "__proto__", fields: ["agentSessionId"] }]) ?? [];
    expect(sanitized.map((e) => e.id)).toEqual(["__proto__"]);
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

  it("does not recreate a deleted state file for a pure-removal write", async () => {
    // Project state was deleted (close-with-kill / removal); a late teardown
    // flush emits only a tombstone. With no existing state and nothing left to
    // persist, the updater returns null so the file stays deleted.
    const saved = onDisk(null);
    await setDraftInputs({
      projectId: "p1",
      draftInputs: {},
      changedIds: [],
      removedIds: ["t1"],
    });
    expect(saved()).toBeNull();
  });

  it("still persists a genuine first draft on a project with no prior state", async () => {
    const saved = onDisk(null);
    await setDraftInputs({
      projectId: "p1",
      draftInputs: { t1: "first draft" },
      changedIds: ["t1"],
      removedIds: [],
    });
    expect(saved()?.draftInputs).toEqual({ t1: "first draft" });
  });
});
