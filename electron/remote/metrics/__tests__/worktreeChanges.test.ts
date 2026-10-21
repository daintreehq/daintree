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

  it("reads nothing while nobody listens, and tells the next listener even an unchanged list", async () => {
    vi.useFakeTimers();
    let listening = false;
    const list = vi.fn(async () => [entry("a")]);
    const changed = vi.fn();
    const watch = new WorktreeChangeWatch({ list, active: () => listening, changed, delayMs: 10 });

    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(list).not.toHaveBeenCalled();

    listening = true;
    watch.poke();
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).toHaveBeenCalledTimes(1);
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
