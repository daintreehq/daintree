import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AnyActionDefinition } from "../../actionTypes";

const mockListBranches = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    listBranches: (...args: unknown[]) => mockListBranches(...args),
    getDefaultPath: vi.fn(),
    getAvailableBranch: vi.fn(),
  },
}));
const viewWorktrees = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: viewWorktrees }) }),
}));

import { registerWorktreeQueryActions } from "../worktreeQueryActions";

type ActionFactory = () => AnyActionDefinition;

function getDefinition(
  id: string,
  worktrees: unknown[] = [],
  activeWorktreeId: string | null = null
): AnyActionDefinition {
  const registry = new Map<string, ActionFactory>();
  registerWorktreeQueryActions(
    registry as never,
    {
      getWorktrees: () => worktrees,
      getActiveWorktreeId: () => activeWorktreeId,
    } as never
  );
  return registry.get(id)!();
}

function getRun(id: string): AnyActionDefinition["run"] {
  return getDefinition(id).run;
}

const branches = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    name: `feature/branch-${i}`,
    current: i === 0,
    commit: `sha-${i}`,
    remote: i % 2 === 0 ? "origin" : undefined,
  }));

/**
 * These assert on what `run()` actually returned (#11531). Since #11539
 * `ActionService.dispatch` also parses that value through `resultSchema`, so a
 * shape `run()` can produce but the schema rejects fails the whole action.
 */
describe("worktree.list result shape", () => {
  it("survives its own resultSchema when a worktree is on a detached HEAD", async () => {
    // `Worktree.branch` is undefined with no branch checked out, while the
    // summary shape declares `string | null`. Returning it unmapped made the
    // entire list action fail once dispatch started parsing results.
    const definition = getDefinition("worktree.list", [
      { id: "wt-1", path: "/repo/detached", isMainWorktree: false },
    ]);

    const result = await definition.run(undefined as never, {} as never);

    expect(definition.resultSchema?.safeParse(result).success).toBe(true);
  });
});

describe("worktree.listBranches bounded reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caps the branch list at the default page size", async () => {
    mockListBranches.mockResolvedValue(branches(2000));
    const run = getRun("worktree.listBranches");

    const result = (await run({ rootPath: "/repo" } as never, {} as never)) as {
      branches: unknown[];
      total: number;
      hasMore: boolean;
      nextOffset: number | null;
    };

    expect(result.branches).toHaveLength(100);
    expect(result.total).toBe(2000);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(100);
  });

  it("returns everything and closes the cursor when the repo has few branches", async () => {
    mockListBranches.mockResolvedValue(branches(3));
    const run = getRun("worktree.listBranches");

    const result = (await run({ rootPath: "/repo" } as never, {} as never)) as {
      branches: unknown[];
      hasMore: boolean;
      nextOffset: number | null;
    };

    expect(result.branches).toHaveLength(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBeNull();
  });

  it("walking nextOffset yields every branch once, in source order", async () => {
    const source = branches(450);
    mockListBranches.mockResolvedValue(source);
    const run = getRun("worktree.listBranches");

    const seen: string[] = [];
    let offset: number | null = 0;
    let iterations = 0;
    while (offset !== null) {
      const current: number = offset;
      const page = (await run(
        { rootPath: "/repo", offset: current, limit: 200 } as never,
        {} as never
      )) as { branches: { name: string }[]; nextOffset: number | null };
      seen.push(...page.branches.map((b) => b.name));
      offset = page.nextOffset;
      expect(++iterations).toBeLessThan(20);
    }

    // Exact ordered identity — a count-and-Set check passes even if pages come
    // back reversed or a page repeats a slice another page already yielded.
    expect(seen).toEqual(source.map((b) => b.name));
  });

  it("clamps an over-ceiling limit reaching run() unvalidated", async () => {
    mockListBranches.mockResolvedValue(branches(2000));
    const run = getRun("worktree.listBranches");

    const result = (await run({ rootPath: "/repo", limit: 100000 } as never, {} as never)) as {
      branches: unknown[];
      limit: number;
    };

    expect(result.branches).toHaveLength(200);
    expect(result.limit).toBe(200);
  });

  it("drops fields the schema does not advertise", async () => {
    mockListBranches.mockResolvedValue([
      { name: "main", current: true, commit: "abc", label: "internal", blob: "z".repeat(5000) },
    ]);
    const run = getRun("worktree.listBranches");

    const result = (await run({ rootPath: "/repo" } as never, {} as never)) as {
      branches: Record<string, unknown>[];
    };

    expect(result.branches[0]).not.toHaveProperty("label");
    expect(result.branches[0]).not.toHaveProperty("blob");
    // Every advertised field must survive the projection, not just `name`.
    expect(result.branches[0]).toEqual({
      name: "main",
      current: true,
      commit: "abc",
      remote: undefined,
    });
  });

  it("returns an empty page past the end rather than throwing", async () => {
    mockListBranches.mockResolvedValue(branches(5));
    const run = getRun("worktree.listBranches");

    const result = (await run({ rootPath: "/repo", offset: 999 } as never, {} as never)) as {
      branches: unknown[];
      total: number;
      hasMore: boolean;
    };

    expect(result.branches).toEqual([]);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(false);
  });
});

describe("worktree.getCurrent follows the dispatch context (#12486)", () => {
  beforeEach(() => {
    viewWorktrees.clear();
    viewWorktrees.set("wt-launch", { id: "wt-launch", path: "/repo/launch", branch: "launch" });
    viewWorktrees.set("wt-selected", {
      id: "wt-selected",
      path: "/repo/selected",
      branch: "selected",
    });
  });

  it("answers with the worktree a replayed launch context names, not the live selection", async () => {
    // An agent pane launched in one worktree keeps calling this after the
    // user selects another; "current" is the pane's own (#8317).
    const definition = getDefinition("worktree.getCurrent", [], "wt-selected");

    const result: unknown = await definition.run(undefined, { activeWorktreeId: "wt-launch" });

    expect(result).toMatchObject({ worktree: { id: "wt-launch", path: "/repo/launch" } });
  });

  it("falls back to the live selection when the context names no worktree", async () => {
    const definition = getDefinition("worktree.getCurrent", [], "wt-selected");

    const result: unknown = await definition.run(undefined, {});

    expect(result).toMatchObject({ worktree: { id: "wt-selected" } });
  });

  it("reports no worktree when the replayed one is gone, rather than borrowing the selection", async () => {
    const definition = getDefinition("worktree.getCurrent", [], "wt-selected");

    const result: unknown = await definition.run(undefined, { activeWorktreeId: "wt-deleted" });

    expect(result).toEqual({ worktree: null });
  });
});
