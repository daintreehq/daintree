import { describe, expect, it, vi } from "vitest";
import type { HostWorktreeEntry } from "../../../../shared/types/ipc/hostMetrics.js";
import { WorktreeChangeWatch } from "../worktreeChanges.js";

function entry(branch: string): HostWorktreeEntry {
  return {
    hostId: "local",
    projectId: "p1",
    projectName: "app",
    worktreeId: "/repo/a",
    name: "a",
    branch,
    path: "/repo/a",
    isMainWorktree: false,
    modifiedCount: null,
    lastActivityAt: null,
    observed: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("WorktreeChangeWatch", () => {
  it("reads once more after a read that a poke arrived during", async () => {
    vi.useFakeTimers();
    const first = deferred<HostWorktreeEntry[]>();
    const list = vi
      .fn<() => Promise<HostWorktreeEntry[]>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue([entry("b")]);
    const changed = vi.fn();
    const watch = new WorktreeChangeWatch({ list, active: () => true, changed, delayMs: 10 });

    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(list).toHaveBeenCalledTimes(1);
    watch.poke();
    first.resolve([entry("a")]);
    await vi.advanceTimersByTimeAsync(10);
    expect(list).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(2);
    watch.dispose();
    vi.useRealTimers();
  });

  it("says nothing when only what the sidebar doesn't show moved", async () => {
    vi.useFakeTimers();
    let current = [entry("a")];
    const changed = vi.fn();
    const watch = new WorktreeChangeWatch({
      list: async () => current,
      active: () => true,
      changed,
      delayMs: 10,
    });
    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    current = [{ ...entry("a"), modifiedCount: 4, lastActivityAt: 99 }];
    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).toHaveBeenCalledTimes(1);
    current = [{ ...entry("a"), observed: { band: "blocked", agentState: "waiting" } }];
    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).toHaveBeenCalledTimes(2);
    // A second agent behind the same top band is something the sidebar counts.
    current = [
      {
        ...current[0]!,
        runs: [
          { terminalId: "t1", band: "blocked", agentState: "waiting" },
          { terminalId: "t2", band: "running", agentState: "working" },
        ],
      },
    ];
    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).toHaveBeenCalledTimes(3);
    watch.dispose();
    vi.useRealTimers();
  });

  it("reads nothing while nobody listens, and tells the next listener even an unchanged list", async () => {
    vi.useFakeTimers();
    let listening = true;
    const list = vi.fn(async () => [entry("a")]);
    const changed = vi.fn();
    const watch = new WorktreeChangeWatch({ list, active: () => listening, changed, delayMs: 10 });

    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).toHaveBeenCalledTimes(1);

    listening = false;
    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(list).toHaveBeenCalledTimes(1);

    // Whoever attached meanwhile never heard the list: the same one is news to them.
    listening = true;
    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).toHaveBeenCalledTimes(2);
    watch.dispose();
    vi.useRealTimers();
  });

  it("tells nobody once disposed, even of a read already running", async () => {
    vi.useFakeTimers();
    const read = deferred<HostWorktreeEntry[]>();
    const changed = vi.fn();
    const watch = new WorktreeChangeWatch({
      list: () => read.promise,
      active: () => true,
      changed,
      delayMs: 10,
    });
    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    watch.dispose();
    read.resolve([entry("a")]);
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
