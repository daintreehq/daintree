import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setDraftInputsMock = vi.hoisted(() =>
  vi.fn<
    (
      projectId: string,
      draftInputs: Record<string, string>,
      changedIds?: string[],
      removedIds?: string[]
    ) => Promise<void>
  >(() => Promise.resolve())
);

vi.mock("@/clients", () => ({
  projectClient: { setDraftInputs: setDraftInputsMock },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

const { draftInputPersistence } = await import("../draftInputPersistence");
const { useTerminalInputStore } = await import("@/store/terminalInputStore");

let projectSeq = 0;
const createdProjectIds: string[] = [];
function freshProjectId(): string {
  projectSeq += 1;
  const id = `proj-${projectSeq}`;
  createdProjectIds.push(id);
  return id;
}

function setDraft(projectId: string, terminalId: string, value: string): void {
  useTerminalInputStore.getState().setDraftInput(terminalId, value, projectId);
}

// Drain the microtask queue so a fire-and-forget flush's queued send actually
// reaches the mocked projectClient before we assert on it.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  setDraftInputsMock.mockClear();
  setDraftInputsMock.mockImplementation(() => Promise.resolve());
  useTerminalInputStore.setState({ draftInputs: new Map() });
});

afterEach(async () => {
  // The persistence singleton's baselines accumulate across tests; flushAll
  // enumerates them, so drop this test's projects to keep tests isolated.
  await draftInputPersistence.whenIdle();
  for (const id of createdProjectIds) {
    draftInputPersistence.clearProject(id);
  }
  createdProjectIds.length = 0;
});

describe("draftInputPersistence.flushAll — close-time draft flush (#11352)", () => {
  it("persists a new draft as a changed key with no baseline", async () => {
    const projectId = freshProjectId();
    setDraft(projectId, "t1", "half-written prompt");

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();

    expect(setDraftInputsMock).toHaveBeenCalledTimes(1);
    const [pid, drafts, changedIds, removedIds] = setDraftInputsMock.mock.calls[0]!;
    expect(pid).toBe(projectId);
    expect(drafts).toEqual({ t1: "half-written prompt" });
    expect(changedIds).toEqual(["t1"]);
    expect(removedIds).toEqual([]);
  });

  it("emits a removal tombstone when a hydrated draft is cleared, even though current is empty", async () => {
    const projectId = freshProjectId();
    // Simulate hydration priming the baseline from the on-disk record.
    draftInputPersistence.primeProject(projectId, { t1: "on disk" });
    // User clears it this session — the live map no longer holds it.
    // (No setDraft call; getProjectDraftInputs returns {}.)

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();

    expect(setDraftInputsMock).toHaveBeenCalledTimes(1);
    const [pid, drafts, changedIds, removedIds] = setDraftInputsMock.mock.calls[0]!;
    expect(pid).toBe(projectId);
    expect(drafts).toEqual({});
    expect(changedIds).toEqual([]);
    expect(removedIds).toEqual(["t1"]);
  });

  it("does not write when the current drafts already equal the baseline", async () => {
    const projectId = freshProjectId();
    setDraft(projectId, "t1", "same");
    draftInputPersistence.primeProject(projectId, { t1: "same" });

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();

    expect(setDraftInputsMock).not.toHaveBeenCalled();
  });

  it("advances the baseline on success so an unchanged re-flush is a no-op", async () => {
    const projectId = freshProjectId();
    setDraft(projectId, "t1", "v1");

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();
    expect(setDraftInputsMock).toHaveBeenCalledTimes(1);

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();
    // No new draft change, baseline advanced → still just the one write.
    expect(setDraftInputsMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the baseline unchanged on failure so the next flush resends", async () => {
    const projectId = freshProjectId();
    setDraft(projectId, "t1", "retry-me");
    setDraftInputsMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();
    expect(setDraftInputsMock).toHaveBeenCalledTimes(1);

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();
    // First write rejected → baseline not advanced → resent.
    expect(setDraftInputsMock).toHaveBeenCalledTimes(2);
    expect(setDraftInputsMock.mock.calls[1]![2]).toEqual(["t1"]);
  });

  it("serializes overlapping same-project flushes so the second diffs against the advanced baseline", async () => {
    const projectId = freshProjectId();
    // Prime a baseline (as hydration would) so the project stays enumerable via
    // its baseline even after its only live draft is cleared.
    draftInputPersistence.primeProject(projectId, { t1: "seed" });
    let resolveFirst!: () => void;
    const firstSend = new Promise<void>((r) => {
      resolveFirst = r;
    });
    setDraftInputsMock.mockImplementationOnce(() => firstSend);

    setDraft(projectId, "t1", "draft");
    draftInputPersistence.flushAll(); // send #1 — stays pending
    await flushMicrotasks();
    expect(setDraftInputsMock).toHaveBeenCalledTimes(1);
    expect(setDraftInputsMock.mock.calls[0]![2]).toEqual(["t1"]); // changedIds

    // Clear the draft and flush again BEFORE #1 resolves. Without the write
    // tail the second flush would diff against the original empty baseline and
    // omit the removal tombstone entirely.
    useTerminalInputStore.getState().setDraftInput("t1", "", projectId);
    draftInputPersistence.flushAll();
    await flushMicrotasks();
    expect(setDraftInputsMock).toHaveBeenCalledTimes(1); // queued behind #1

    resolveFirst();
    await draftInputPersistence.whenIdle();

    expect(setDraftInputsMock).toHaveBeenCalledTimes(2);
    const [pid, drafts, changedIds, removedIds] = setDraftInputsMock.mock.calls[1]!;
    expect(pid).toBe(projectId);
    expect(drafts).toEqual({});
    expect(changedIds).toEqual([]);
    expect(removedIds).toEqual(["t1"]);
  });

  it("resumes a queued flush after the in-flight one rejects", async () => {
    const projectId = freshProjectId();
    let rejectFirst!: (e: Error) => void;
    const firstSend = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    setDraftInputsMock.mockImplementationOnce(() => firstSend);

    setDraft(projectId, "t1", "one");
    draftInputPersistence.flushAll(); // #1 pending
    await flushMicrotasks();

    setDraft(projectId, "t2", "two");
    draftInputPersistence.flushAll(); // queued behind #1
    await flushMicrotasks();
    expect(setDraftInputsMock).toHaveBeenCalledTimes(1);

    rejectFirst(new Error("boom"));
    await draftInputPersistence.whenIdle();

    // #1 rejected → baseline unchanged; #2 proceeds and resends both drafts.
    expect(setDraftInputsMock).toHaveBeenCalledTimes(2);
    expect(new Set(setDraftInputsMock.mock.calls[1]![2])).toEqual(new Set(["t1", "t2"]));
  });

  it("clearProject forgets a project's baseline so it is no longer enumerated", async () => {
    const projectId = freshProjectId();
    draftInputPersistence.primeProject(projectId, { t1: "on disk" });
    draftInputPersistence.clearProject(projectId);

    // With the baseline forgotten and no live drafts, flushAll has nothing to
    // enumerate for this project.
    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();

    expect(setDraftInputsMock).not.toHaveBeenCalled();
  });

  it("flushes each project independently", async () => {
    const projectA = freshProjectId();
    const projectB = freshProjectId();
    setDraft(projectA, "a1", "alpha");
    setDraft(projectB, "b1", "beta");

    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();

    expect(setDraftInputsMock).toHaveBeenCalledTimes(2);
    const byProject = new Map(setDraftInputsMock.mock.calls.map((c) => [c[0], c[1]]));
    expect(byProject.get(projectA)).toEqual({ a1: "alpha" });
    expect(byProject.get(projectB)).toEqual({ b1: "beta" });
  });
});

describe("draftInputPersistence.computeDelta / primeProject", () => {
  it("computes the delta a switch caller sends, diffed against the primed baseline", () => {
    const projectId = freshProjectId();
    draftInputPersistence.primeProject(projectId, { t1: "old", t2: "gone" });

    const delta = draftInputPersistence.computeDelta(projectId, { t1: "new", t3: "added" });
    expect(new Set(delta.changedIds)).toEqual(new Set(["t1", "t3"]));
    expect(delta.removedIds).toEqual(["t2"]);
  });

  it("does not overwrite an already-established baseline on a late prime", async () => {
    const projectId = freshProjectId();
    setDraft(projectId, "t1", "live");
    // First flush establishes baseline {t1:"live"}.
    draftInputPersistence.flushAll();
    await draftInputPersistence.whenIdle();
    setDraftInputsMock.mockClear();

    // A late hydration result must not clobber the acknowledged baseline.
    draftInputPersistence.primeProject(projectId, { t1: "stale-from-disk" });
    const delta = draftInputPersistence.computeDelta(projectId, { t1: "live" });
    expect(delta.changedIds).toEqual([]);
    expect(delta.removedIds).toEqual([]);
  });
});
