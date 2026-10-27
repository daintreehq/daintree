import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopyTrashEntry } from "../../../../shared/types/ipc/canopy.js";
import {
  CANOPY_TRASH_SETTLE_MS,
  CanopyTrashLedger,
  type TrashedTerminalRecord,
} from "../canopyTrashLedger.js";

const NOW = 1_800_000_000_000;

function record(id: string, overrides: Partial<TrashedTerminalRecord> = {}): TrashedTerminalRecord {
  return {
    projectId: "project-a",
    kind: "terminal",
    cwd: `/repo/${id}`,
    spawnedAt: NOW - 60_000,
    isTrashed: true,
    trashExpiresAt: NOW + 20_000,
    hasPty: true,
    detectedAgentId: "claude",
    launchAgentId: "claude",
    everDetectedAgent: true,
    title: `Agent ${id}`,
    ...overrides,
  };
}

function setup(
  records: Record<string, TrashedTerminalRecord | null>,
  options: {
    onSettle?: (entry: CanopyTrashEntry) => Promise<boolean> | boolean;
    isRemoved?: (entry: CanopyTrashEntry) => boolean;
  } = {}
) {
  let now = NOW;
  const onChange = vi.fn();
  const reads = new Map<string, Array<(value: TrashedTerminalRecord | null) => void>>();
  const readTerminal = vi.fn(
    (id: string) =>
      new Promise<TrashedTerminalRecord | null>((resolve) => {
        const held = reads.get(id) ?? [];
        held.push(resolve);
        reads.set(id, held);
      })
  );
  const ledger = new CanopyTrashLedger({
    readTerminal,
    isHelpTerminal: (id) => id === "help",
    onChange,
    ...options,
    now: () => now,
  });
  /** Answers every read made of the run with what the host holds now. */
  const answer = async (id: string) => {
    for (const resolve of reads.get(id) ?? []) resolve(records[id] ?? null);
    reads.delete(id);
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    ledger,
    onChange,
    readTerminal,
    answer,
    records,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("CanopyTrashLedger", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists trashed agent runs from several projects, newest first, as the host had them", async () => {
    const { ledger, answer, tick, onChange } = setup({
      older: record("older", { projectId: "project-a", worktreeId: "wt-1" }),
      newer: record("newer", {
        projectId: "project-b",
        trashExpiresAt: NOW + 25_000,
        titleMode: "user",
        agentState: "waiting",
        lastStateChange: NOW - 1_000,
      }),
    });
    ledger.onTrashed("older", NOW + 20_000);
    await answer("older");
    tick(5_000);
    ledger.onTrashed("newer", NOW + 25_000);
    await answer("newer");

    const list = ledger.list();
    expect(list.map((entry) => entry.run.runId)).toEqual(["newer", "older"]);
    expect(list.map((entry) => entry.run.workspaceId)).toEqual(["project-b", "project-a"]);
    expect(list[1]!.run.worktreeId).toBe("wt-1");
    expect(list[0]!.run.titleMode).toBe("user");
    expect(list[0]!.trashedAt - list[1]!.trashedAt).toBe(5_000);
    // A run in the trash has no state to show: none rides its entry.
    expect(list[0]!.run.agentState).toBeUndefined();
    expect(list[0]!.run.since).toBeUndefined();
    expect(list[0]!.run.agentId).toBe("claude");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("keeps out what Canopy never lists: shells, the assistant, help terminals and unowned ones", async () => {
    const { ledger, answer, onChange } = setup({
      shell: record("shell", {
        detectedAgentId: undefined,
        launchAgentId: undefined,
        everDetectedAgent: undefined,
      }),
      assistant: record("assistant", { isAssistantTerminal: true }),
      help: record("help"),
      unowned: record("unowned", { projectId: undefined }),
    });
    for (const id of ["shell", "assistant", "help", "unowned"]) {
      ledger.onTrashed(id, NOW + 20_000);
      await answer(id);
    }
    expect(ledger.list()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("drops a run restored, and keeps one the trash lets go, ended, until its close lands", async () => {
    const { ledger, answer, onChange } = setup({
      a: record("a"),
      b: record("b"),
      c: record("c", { trashExpiresAt: NOW + 30_000 }),
    });
    ledger.onTrashed("a", NOW + 20_000);
    ledger.onTrashed("b", NOW + 20_000);
    ledger.onTrashed("c", NOW + 30_000);
    await answer("a");
    await answer("b");
    await answer("c");
    expect(ledger.list()).toHaveLength(3);
    onChange.mockClear();

    ledger.onRestored("a");
    expect(ledger.get("a")).toBeUndefined();
    ledger.onCleared("b", NOW + 20_000);
    // Same row, same trash: only now its process is gone.
    expect(ledger.get("b")).toMatchObject({ expiresAt: NOW + 20_000, ended: {} });
    expect(onChange).toHaveBeenCalledTimes(2);

    // Nothing journaled the close: it leaves once one had time to land.
    vi.advanceTimersByTime(CANOPY_TRASH_SETTLE_MS);
    await vi.waitFor(() => expect(ledger.get("b")).toBeUndefined());

    // No clear heard for "c": it ends at its deadline all the same, and goes the same way.
    vi.advanceTimersByTime(30_000 - CANOPY_TRASH_SETTLE_MS);
    expect(ledger.get("c")?.ended).toEqual({});
    vi.advanceTimersByTime(CANOPY_TRASH_SETTLE_MS);
    await vi.waitFor(() => expect(ledger.list()).toEqual([]));
  });

  it("lets an ended run go without a word once the journal holds that incarnation's close", async () => {
    const { ledger, answer, onChange } = setup({ a: record("a") });
    ledger.onTrashed("a", NOW + 20_000);
    await answer("a");
    ledger.onCleared("a", NOW + 20_000);
    onChange.mockClear();

    // Another incarnation's close stands for nothing here.
    expect(ledger.onJournaled("a", NOW - 1)).toBe(false);
    expect(ledger.onJournaled("a", NOW - 60_000)).toBe(true);
    expect(ledger.get("a")).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks for the incarnation's earlier session when no close landed, and leaves either way", async () => {
    const onSettle = vi.fn(async () => true);
    const { ledger, answer, onChange } = setup({ a: record("a") }, { onSettle });
    ledger.onTrashed("a", NOW + 20_000);
    await answer("a");
    ledger.onCleared("a", NOW + 20_000);
    onChange.mockClear();

    vi.advanceTimersByTime(CANOPY_TRASH_SETTLE_MS);
    await vi.waitFor(() => expect(ledger.get("a")).toBeUndefined());
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: NOW + 20_000,
        run: expect.objectContaining({ runId: "a" }),
      })
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("waits for a live run's own close before taking an earlier session for it", async () => {
    const onSettle = vi.fn(async () => false);
    const { ledger, answer } = setup({ a: record("a") }, { onSettle });
    ledger.onTrashed("a", NOW + 20_000);
    await answer("a");
    ledger.onCleared("a", NOW + 20_000);
    await Promise.resolve();
    await Promise.resolve();
    // Its own capture is still on its way: an older session of the pane is not it.
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CANOPY_TRASH_SETTLE_MS);
    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
  });

  it("lets a run the user removed go when the trash does, never ended", async () => {
    const { ledger, answer } = setup(
      { a: record("a") },
      { isRemoved: (entry) => entry.run.runId === "a" }
    );
    ledger.onTrashed("a", NOW + 20_000);
    await answer("a");
    ledger.onCleared("a", NOW + 20_000);
    expect(ledger.get("a")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes a run out at once when the user removes it", async () => {
    const { ledger, answer, onChange } = setup({ a: record("a") });
    ledger.onTrashed("a", NOW + 20_000);
    await answer("a");
    onChange.mockClear();
    ledger.remove("a");
    expect(ledger.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
    // A late clear of that trash finds nothing to end.
    ledger.onCleared("a", NOW + 20_000);
    expect(ledger.list()).toEqual([]);
  });

  it("ignores a clear of an earlier trash of the same run", async () => {
    const { ledger, answer, records } = setup({ a: record("a") });
    ledger.onTrashed("a", NOW + 20_000);
    await answer("a");
    ledger.onRestored("a");
    records.a = record("a", { trashExpiresAt: NOW + 40_000 });
    ledger.onTrashed("a", NOW + 40_000);
    await answer("a");
    ledger.onCleared("a", NOW + 20_000);
    expect(ledger.get("a")?.expiresAt).toBe(NOW + 40_000);
  });

  it("keeps a newer trash whose read is in flight through a late clear of an earlier one", async () => {
    const { ledger, answer } = setup({ a: record("a", { trashExpiresAt: NOW + 40_000 }) });
    ledger.onTrashed("a", NOW + 40_000);
    ledger.onCleared("a", NOW + 20_000);
    await answer("a");
    expect(ledger.get("a")?.expiresAt).toBe(NOW + 40_000);
  });

  it("adds nothing for a run restored or cleared while the host was asked about it", async () => {
    const { ledger, answer, onChange } = setup({ a: record("a"), b: record("b") });
    ledger.onTrashed("a", NOW + 20_000);
    ledger.onRestored("a");
    await answer("a");
    ledger.onTrashed("b", NOW + 20_000);
    ledger.onCleared("b", NOW + 20_000);
    await answer("b");
    expect(ledger.list()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes only the trash the host still holds: not one gone or let go, nor a later trash", async () => {
    const { ledger, answer } = setup({
      gone: null,
      respawned: record("respawned", { isTrashed: false, trashExpiresAt: undefined }),
      later: record("later", { trashExpiresAt: NOW + 50_000 }),
    });
    ledger.onTrashed("gone", NOW + 20_000);
    ledger.onTrashed("respawned", NOW + 20_000);
    ledger.onTrashed("later", NOW + 20_000);
    await answer("gone");
    await answer("respawned");
    await answer("later");
    expect(ledger.list()).toEqual([]);
  });

  it("stops listening and lets its timers go once disposed", async () => {
    const { ledger, answer, onChange } = setup({
      a: record("a"),
      b: record("b"),
      c: record("c"),
    });
    ledger.onTrashed("a", NOW + 20_000);
    await answer("a");
    ledger.onTrashed("c", NOW + 20_000);
    await answer("c");
    ledger.onCleared("c", NOW + 20_000);
    ledger.onTrashed("b", NOW + 20_000);
    onChange.mockClear();
    ledger.dispose();
    await answer("b");
    vi.advanceTimersByTime(20_000);
    expect(ledger.list()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
