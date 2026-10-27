import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanopyTrashLedger, type TrashedTerminalRecord } from "../canopyTrashLedger.js";

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

function setup(records: Record<string, TrashedTerminalRecord | null>) {
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

  it("drops a run when it is restored, removed or expires, whoever did it", async () => {
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
    expect(ledger.get("b")).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(2);

    // No clear heard for "c": it still goes at its deadline.
    vi.advanceTimersByTime(30_000);
    expect(ledger.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(3);
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

  it("takes only the trash the host still holds: not a respawn, nor a later trash", async () => {
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
    const { ledger, answer, onChange } = setup({ a: record("a"), b: record("b") });
    ledger.onTrashed("a", NOW + 20_000);
    await answer("a");
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
