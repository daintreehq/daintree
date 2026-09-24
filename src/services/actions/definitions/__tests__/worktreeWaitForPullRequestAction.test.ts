import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

const worktreeClientMock = vi.hoisted(() => ({ getAllWithStatus: vi.fn() }));
const viewStoreMock = vi.hoisted(() => ({ getCurrentViewStore: vi.fn() }));

vi.mock("@/clients", () => ({ worktreeClient: worktreeClientMock }));
vi.mock("@/store/createWorktreeStore", () => viewStoreMock);

import { registerWorktreeQueryActions } from "../worktreeQueryActions";

type Row = { id: string; branch?: string; prNumber?: number; linked?: unknown };

let rows = new Map<string, Row>();

function setRows(next: Row[], hostOnly: Row[] = []): void {
  rows = new Map(next.map((r) => [r.id, r]));
  worktreeClientMock.getAllWithStatus.mockResolvedValue({
    worktrees: [...next, ...hostOnly],
    gitBacked: true,
  });
}

function linkedPr(number: number, state = "open") {
  return {
    providerId: "github",
    pr: {
      ref: { providerId: "github", owner: "o", repo: "r", number, rawData: null },
      url: `https://github.com/o/r/pull/${number}`,
      state,
    },
  };
}

function action(): AnyActionDefinition {
  const registry: ActionRegistry = new Map();
  registerWorktreeQueryActions(registry, {
    getWorktrees: () => [],
    getActiveWorktreeId: () => null,
  } as unknown as ActionCallbacks);
  const factory = registry.get("worktree.waitForPullRequest" as never);
  if (!factory) throw new Error("worktree.waitForPullRequest not registered");
  return factory() as AnyActionDefinition;
}

function run(args: unknown): Promise<Record<string, unknown>> {
  const def = action();
  const parsed = def.argsSchema!.parse(args);
  return def.run!(parsed, {} as ActionContext) as Promise<Record<string, unknown>>;
}

describe("worktree.waitForPullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRows([]);
    viewStoreMock.getCurrentViewStore.mockReturnValue({
      getState: () => ({ worktrees: rows }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns at once for a PR already detected, with every target in request order", async () => {
    setRows([
      { id: "wt-a" },
      { id: "wt-b", linked: linkedPr(12, "merged") },
      { id: "wt-c", linked: linkedPr(13) },
    ]);

    const result = await run({ worktreeIds: ["wt-a", "wt-b", "wt-c"] });

    expect(result).toEqual({
      timedOut: false,
      worktrees: [
        { worktreeId: "wt-a", prNumber: null, prUrl: null, prState: null },
        {
          worktreeId: "wt-b",
          prNumber: 12,
          prUrl: "https://github.com/o/r/pull/12",
          prState: "merged",
        },
        {
          worktreeId: "wt-c",
          prNumber: 13,
          prUrl: "https://github.com/o/r/pull/13",
          prState: "open",
        },
      ],
    });
    // Every row was already in the store, so the host is never asked.
    expect(worktreeClientMock.getAllWithStatus).not.toHaveBeenCalled();
  });

  it("wakes when a PR is detected mid-wait", async () => {
    vi.useFakeTimers();
    setRows([{ id: "wt-a" }, { id: "wt-b" }]);

    const pending = run({ worktreeIds: ["wt-a", "wt-b"] });
    await vi.advanceTimersByTimeAsync(1_000);
    setRows([{ id: "wt-a" }, { id: "wt-b", linked: linkedPr(7) }]);
    await vi.advanceTimersByTimeAsync(300);

    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect((result.worktrees as Array<{ prNumber: number | null }>)[1].prNumber).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out without a PR and reports every target as undetected", async () => {
    vi.useFakeTimers();
    setRows([{ id: "wt-a" }]);

    const pending = run({ worktreeIds: ["wt-a"], timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await pending).toEqual({
      timedOut: true,
      worktrees: [{ worktreeId: "wt-a", prNumber: null, prUrl: null, prState: null }],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads the state without blocking at a zero timeout", async () => {
    setRows([{ id: "wt-a" }]);

    const result = await run({ worktreeIds: ["wt-a"], timeoutMs: 0 });

    expect(result.timedOut).toBe(true);
  });

  it("keeps waiting on an explicit clear or issue-only linkage, and ignores stale flat PR fields", async () => {
    // `linked: null` is a branch switch clearing the PR; the flat `prNumber`
    // can outlive it, so it must not satisfy the wait.
    setRows([
      { id: "wt-a", linked: null, prNumber: 99 },
      {
        id: "wt-b",
        linked: {
          providerId: "github",
          issue: { ref: { providerId: "github", owner: "o", repo: "r", number: 5 } },
        },
      },
    ]);

    const result = await run({ worktreeIds: ["wt-a", "wt-b"], timeoutMs: 0 });

    expect(result.timedOut).toBe(true);
    expect(result.worktrees).toEqual([
      { worktreeId: "wt-a", prNumber: null, prUrl: null, prState: null },
      { worktreeId: "wt-b", prNumber: null, prUrl: null, prState: null },
    ]);
  });

  it("waits on a worktree the host has but the store has not received yet", async () => {
    vi.useFakeTimers();
    // A create result can beat the store update carrying the new row.
    setRows([{ id: "wt-a" }], [{ id: "wt-new" }]);

    const pending = run({ worktreeIds: ["wt-a", "wt-new"] });
    await vi.advanceTimersByTimeAsync(500);
    setRows([{ id: "wt-a" }, { id: "wt-new", linked: linkedPr(4) }]);
    await vi.advanceTimersByTimeAsync(300);

    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect((result.worktrees as Array<{ prNumber: number | null }>)[1].prNumber).toBe(4);
  });

  it("keeps the sibling rows' answer when one worktree is deleted mid-wait", async () => {
    vi.useFakeTimers();
    setRows([{ id: "wt-a" }, { id: "wt-b" }]);

    const pending = run({ worktreeIds: ["wt-a", "wt-b"] });
    await vi.advanceTimersByTimeAsync(500);
    setRows([{ id: "wt-b", linked: linkedPr(9) }]);
    await vi.advanceTimersByTimeAsync(300);

    expect(await pending).toEqual({
      timedOut: false,
      worktrees: [
        { worktreeId: "wt-a", prNumber: null, prUrl: null, prState: null },
        {
          worktreeId: "wt-b",
          prNumber: 9,
          prUrl: "https://github.com/o/r/pull/9",
          prState: "open",
        },
      ],
    });
  });

  it("rejects a worktree neither the store nor the host has, without echoing the id", async () => {
    setRows([{ id: "wt-a" }]);

    await expect(run({ worktreeIds: ["wt-a", "wt-secret"] })).rejects.toThrow(/^Unknown worktree/);
    await expect(run({ worktreeIds: ["wt-secret"] })).rejects.not.toThrow(/wt-secret/);
  });

  it("rejects an empty or oversized target list and an out-of-range timeout", () => {
    const schema = action().argsSchema!;
    expect(schema.safeParse({ worktreeIds: [] }).success).toBe(false);
    expect(
      schema.safeParse({ worktreeIds: Array.from({ length: 33 }, (_, i) => `wt-${i}`) }).success
    ).toBe(false);
    expect(schema.safeParse({ worktreeIds: ["wt-a"], timeoutMs: 25_001 }).success).toBe(false);
    expect(schema.safeParse({ worktreeIds: ["wt-a"], timeoutMs: -1 }).success).toBe(false);
  });

  it("produces results that satisfy its declared schema", async () => {
    setRows([{ id: "wt-a", linked: linkedPr(3, "declined") }, { id: "wt-b" }]);
    const def = action();

    const result = await run({ worktreeIds: ["wt-a", "wt-b"] });

    expect(def.resultSchema!.safeParse(result).success).toBe(true);
  });
});
