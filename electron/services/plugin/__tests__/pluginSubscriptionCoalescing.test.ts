import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorktreeChangeTracker,
  createSubscriptionCoalescer,
  resolveSubscriptionDebounceMs,
  worktreeSnapshotFingerprint,
} from "../pluginSubscriptionCoalescing.js";
import { PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS } from "../../../../shared/config/pluginBudgets.js";
import { createMockHost } from "../../../../shared/testing/createMockHost.js";
import type {
  PluginWorktreeSnapshot,
  PluginWorktreesChange,
} from "../../../../shared/types/plugin.js";

function snap(id: string, overrides: Partial<PluginWorktreeSnapshot> = {}): PluginWorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    isCurrent: false,
    linked: null,
    status: null,
    ...overrides,
  };
}

const status = (files: Array<[string, "added" | "modified"]>) => ({
  files: files.map(([path, state]) => ({ path, state })),
  changedFileCount: files.length,
  counts: {
    added: files.filter(([, s]) => s === "added").length,
    modified: files.filter(([, s]) => s === "modified").length,
    deleted: 0,
    untracked: 0,
    renamed: 0,
  },
});

describe("resolveSubscriptionDebounceMs", () => {
  it("defaults an omitted or non-numeric value and honours an explicit zero", () => {
    expect(resolveSubscriptionDebounceMs(undefined)).toBe(PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS);
    expect(resolveSubscriptionDebounceMs(Number.NaN)).toBe(PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS);
    expect(resolveSubscriptionDebounceMs("300")).toBe(PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS);
    expect(resolveSubscriptionDebounceMs(0)).toBe(0);
    expect(resolveSubscriptionDebounceMs(-5)).toBe(0);
  });

  it("clamps into the floor and ceiling", () => {
    expect(resolveSubscriptionDebounceMs(1)).toBe(50);
    expect(resolveSubscriptionDebounceMs(300)).toBe(300);
    expect(resolveSubscriptionDebounceMs(Infinity)).toBe(60_000);
    expect(resolveSubscriptionDebounceMs(1e12)).toBe(60_000);
  });
});

describe("createSubscriptionCoalescer", () => {
  afterEach(() => vi.useRealTimers());

  it("flushes synchronously for a zero window", () => {
    const flush = vi.fn();
    const c = createSubscriptionCoalescer(0, flush);
    c.push();
    c.push();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("flushes once at the trailing edge, and by the deadline under a steady stream", async () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const c = createSubscriptionCoalescer(100, flush);
    for (let i = 0; i < 100; i++) {
      c.push();
      await vi.advanceTimersByTimeAsync(10);
    }
    // 1 s of pushes every 10 ms with a 400 ms max wait.
    expect(flush).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it("drops a pending flush on dispose", async () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const c = createSubscriptionCoalescer(100, flush);
    c.push();
    c.dispose();
    c.push();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("WorktreeChangeTracker", () => {
  it("reports everything as added on the first delivery", () => {
    const t = new WorktreeChangeTracker();
    expect(t.next([snap("a"), snap("b")])).toEqual({ added: ["a", "b"], removed: [], changed: [] });
  });

  it("classifies adds, removes and field changes against the previous delivery", () => {
    const t = new WorktreeChangeTracker();
    t.next([snap("a"), snap("b"), snap("c")]);
    const change = t.next([snap("a"), snap("b", { aheadCount: 2 }), snap("d")]);
    expect(change).toEqual({ added: ["d"], removed: ["c"], changed: ["b"] });
  });

  it("sees a changed file set even when the counts stay the same", () => {
    const t = new WorktreeChangeTracker();
    t.next([snap("a", { status: status([["x.ts", "modified"]]) })]);
    const change = t.next([snap("a", { status: status([["y.ts", "modified"]]) })]);
    expect(change.changed).toEqual(["a"]);
  });

  it("sees a linked PR's state change", () => {
    const t = new WorktreeChangeTracker();
    const pr = (state: "open" | "merged") => ({
      providerId: "github",
      pr: { ref: { kind: "pr", id: "1" }, url: "u", state },
    });
    t.next([snap("a", { linked: pr("open") as never })]);
    expect(t.next([snap("a", { linked: pr("merged") as never })]).changed).toEqual(["a"]);
  });

  it("reports an unchanged re-send as three empty lists", () => {
    const t = new WorktreeChangeTracker();
    t.next([snap("a")]);
    expect(t.next([snap("a")])).toEqual({ added: [], removed: [], changed: [] });
  });

  it("treats a duplicate id in one list as one worktree", () => {
    const t = new WorktreeChangeTracker();
    expect(t.next([snap("a"), snap("a", { name: "dup" })]).added).toEqual(["a"]);
  });

  it("fingerprints every plugin-visible scalar", () => {
    const base = snap("a");
    const fields: Array<Partial<PluginWorktreeSnapshot>> = [
      { path: "/elsewhere" },
      { name: "renamed" },
      { isCurrent: true },
      { branch: "feature" },
      { isMainWorktree: true },
      { aheadCount: 1 },
      { behindCount: 1 },
      { mood: "stale" },
      { lastActivityTimestamp: 5 },
      { createdAt: 5 },
      { worktreeId: "other" },
    ];
    for (const override of fields) {
      expect(worktreeSnapshotFingerprint({ ...base, ...override })).not.toBe(
        worktreeSnapshotFingerprint(base)
      );
    }
  });
});

describe("createMockHost parity with the host's coalescing rules", () => {
  it("computes the same change sets as the host tracker", async () => {
    const host = createMockHost();
    const changes: PluginWorktreesChange[] = [];
    await host.onDidChangeWorktrees((_list, change) => changes.push(change));
    const tracker = new WorktreeChangeTracker();
    const sequence = [
      [snap("a"), snap("b")],
      [snap("a", { branch: "x" }), snap("c")],
      [snap("c", { status: status([["f", "added"]]) })],
      [snap("c", { status: status([["g", "added"]]) })],
      [],
    ];
    const expected: PluginWorktreesChange[] = [];
    for (const list of sequence) {
      host.simulateWorktreesChange(list);
      expected.push(tracker.next(list));
    }
    expect(changes).toEqual(expected);
  });

  it("records the window the host would resolve", async () => {
    const host = createMockHost();
    const inputs = [undefined, 0, -1, 1, 300, 1e12, Number.NaN];
    for (const debounceMs of inputs) {
      await host.onDidChangeWorktrees(() => {}, { debounceMs });
    }
    await host.onDidChangeActiveWorktree(() => {});
    await host.onDidChangeAgentState(() => {}, { debounceMs: 0 });
    expect(host.subscriptionOptions.map((r) => r.debounceMs)).toEqual([
      ...inputs.map(resolveSubscriptionDebounceMs),
      PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS,
      0,
    ]);
    expect(host.subscriptionOptions.slice(-2).map((r) => r.kind)).toEqual([
      "active-worktree",
      "agent-state",
    ]);
  });
});
