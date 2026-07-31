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
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

import { registerWorktreeQueryActions } from "../worktreeQueryActions";

type ActionFactory = () => AnyActionDefinition;

function getRun(id: string): AnyActionDefinition["run"] {
  const registry = new Map<string, ActionFactory>();
  registerWorktreeQueryActions(registry as never, {
    getWorktrees: () => [],
    getActiveWorktreeId: () => null,
  } as never);
  return registry.get(id)!().run;
}

const branches = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    name: `feature/branch-${i}`,
    current: i === 0,
    commit: `sha-${i}`,
    remote: i % 2 === 0 ? "origin" : undefined,
  }));

/**
 * `resultSchema` never parses a result — `ActionService.dispatch` returns `run()`
 * output as-is — so these assert on what `run()` actually returned (#11531).
 */
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

  it("walking nextOffset yields every branch exactly once", async () => {
    mockListBranches.mockResolvedValue(branches(450));
    const run = getRun("worktree.listBranches");

    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = (await run({ rootPath: "/repo", offset, limit: 200 } as never, {} as never)) as {
        branches: { name: string }[];
        nextOffset: number | null;
      };
      seen.push(...page.branches.map((b) => b.name));
      offset = page.nextOffset;
    }

    expect(seen).toHaveLength(450);
    expect(new Set(seen).size).toBe(450);
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
    expect(result.branches[0]?.name).toBe("main");
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
