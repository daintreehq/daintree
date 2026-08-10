import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { StagingStatus } from "@shared/types";
import type { AnyActionDefinition } from "../../actionTypes";

const mockGetCurrentViewStore = vi.fn();
const mockHealthProviders: { current: Record<string, unknown> } = { current: {} };

vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: { openPath: vi.fn() },
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => mockGetCurrentViewStore(),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/store/uiStore", () => ({ useUIStore: { getState: vi.fn(() => ({})) } }));
vi.mock("@/store/forgeProviderHealthStore", () => ({
  useForgeProviderHealthStore: {
    getState: () => ({ providers: mockHealthProviders.current }),
  },
}));
vi.mock("@/lib/copyTreeFormat", () => ({ DEFAULT_COPYTREE_FORMAT: "xml" }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

import { registerWorktreeContextActions } from "../worktreeContextActions";
import { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";

type ActionFactory = () => AnyActionDefinition;

const makeStatus = (overrides?: Partial<StagingStatus>): StagingStatus => ({
  staged: [{ path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 }],
  unstaged: [],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: true,
  pushDestination: { remote: "origin", branch: "feature/test" },
  pullSource: { remote: "origin", branch: "feature/test" },
  repoState: "DIRTY",
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
  ...overrides,
});

const mockGetStagingStatus = vi.fn();

interface TestWorktree {
  id: string;
  path: string;
  name: string;
  branch?: string;
  aheadCount?: number;
  behindCount?: number;
  matchedForgeProviderId?: string | null;
  linked?: {
    providerId: string;
    pr?: {
      ref: { providerId: string; owner: string; repo: string; number: number; rawData: unknown };
      url: string;
      state: "open" | "merged" | "closed" | "declined";
      ciStatus?: { state: "success" | "failure" | "pending" | "neutral" | "unknown" };
    };
  } | null;
}

function setWorktrees(entries: TestWorktree[]): void {
  const map = new Map(entries.map((e) => [e.id, e]));
  mockGetCurrentViewStore.mockReturnValue({ getState: () => ({ worktrees: map }) });
}

function getDefinition(): AnyActionDefinition {
  const registry = new Map<string, ActionFactory>();
  registerWorktreeContextActions(registry as never, { onInject: vi.fn() } as never);
  return registry.get("worktree.reviewReadiness")!();
}

const BASE_WORKTREE: TestWorktree = {
  id: "wt-1",
  path: "/repo/wt-1",
  name: "feature-test",
  branch: "feature/test",
  aheadCount: 2,
  behindCount: 0,
};

describe("worktree.reviewReadiness run()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHealthProviders.current = {};
    mockGetStagingStatus.mockResolvedValue(makeStatus());
    // @ts-expect-error - minimal window.electron stub for the renderer IPC call
    globalThis.window = { electron: { git: { getStagingStatus: mockGetStagingStatus } } };
    setWorktrees([BASE_WORKTREE]);
  });

  afterEach(() => {
    // @ts-expect-error - tear down the stub so it doesn't leak to other suites
    delete globalThis.window;
  });

  it("returns a readiness summary for an explicit worktree", async () => {
    const def = getDefinition();
    const result = (await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext)) as Record<
      string,
      unknown
    >;

    expect(mockGetStagingStatus).toHaveBeenCalledWith("/repo/wt-1");
    expect(result.worktreeId).toBe("wt-1");
    expect(result.worktreePath).toBe("/repo/wt-1");
    expect(result.worktreeName).toBe("feature-test");
    expect(result.branch).toBe("feature/test");
    expect(result.level).toBe("ready");
    expect(result.commitReady).toBe(true);
    expect(result.pushReady).toBe(true);
    expect(result.counts).toEqual({ staged: 1, unstaged: 0, conflicted: 0 });
    expect(result.aheadCount).toBe(2);
    expect(result.behindCount).toBe(0);
    expect(result.pr).toBeNull();
    expect(result.reviewDecision).toBeNull();
  });

  it("validates its own resultSchema against a live result", async () => {
    const def = getDefinition();
    const result = await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext);
    const parsed = def.resultSchema!.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("falls back to the focused, then active worktree from context", async () => {
    const def = getDefinition();
    const focused = (await def.run(
      undefined as never,
      {
        focusedWorktreeId: "wt-1",
      } as ActionContext
    )) as { worktreeId: string };
    expect(focused.worktreeId).toBe("wt-1");

    const active = (await def.run(
      undefined as never,
      {
        activeWorktreeId: "wt-1",
      } as ActionContext
    )) as { worktreeId: string };
    expect(active.worktreeId).toBe("wt-1");
  });

  it("throws when no worktree can be resolved", async () => {
    const def = getDefinition();
    await expect(def.run(undefined as never, {} as ActionContext)).rejects.toThrow(
      /No worktree to inspect/
    );
  });

  it("throws for an unknown or stale worktree id", async () => {
    const def = getDefinition();
    await expect(def.run({ worktreeId: "gone" } as never, {} as ActionContext)).rejects.toThrow(
      "Worktree not found: gone"
    );
    expect(mockGetStagingStatus).not.toHaveBeenCalled();
  });

  it("propagates staging-status IPC failures", async () => {
    mockGetStagingStatus.mockRejectedValue(new Error("not a repository"));
    const def = getDefinition();
    await expect(def.run({ worktreeId: "wt-1" } as never, {} as ActionContext)).rejects.toThrow(
      "not a repository"
    );
  });

  it("reports blockers with registered follow-up action ids", async () => {
    mockGetStagingStatus.mockResolvedValue(
      makeStatus({
        staged: [],
        conflicted: ["src/a.ts"],
        conflictedFiles: [{ path: "src/a.ts", xy: "UU", label: "both modified" }],
      })
    );
    const def = getDefinition();
    const result = (await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext)) as {
      level: string;
      blockers: { id: string; actionId?: string }[];
      nextActions: { actionId?: string }[];
    };
    expect(result.level).toBe("blocked");
    expect(result.blockers[0]).toMatchObject({
      id: "conflicts",
      actionId: "worktree.openReviewHub",
      actionArgs: { worktreeId: "wt-1" },
    });
    for (const action of result.nextActions) {
      if (action.actionId) {
        expect(BUILT_IN_ACTION_IDS).toContain(action.actionId);
      }
    }
  });

  it("targets the inspected worktree in every suggested follow-up, never the active one", async () => {
    setWorktrees([
      BASE_WORKTREE,
      { ...BASE_WORKTREE, id: "wt-2", path: "/repo/wt-2", name: "other", behindCount: 3 },
    ]);
    mockGetStagingStatus.mockResolvedValue(makeStatus());
    const def = getDefinition();
    const result = (await def.run(
      { worktreeId: "wt-2" } as never,
      {
        activeWorktreeId: "wt-1",
        focusedWorktreeId: "wt-1",
      } as ActionContext
    )) as {
      nextActions: { actionId?: string; actionArgs?: Record<string, string> }[];
    };
    expect(result.nextActions.length).toBeGreaterThan(0);
    for (const action of result.nextActions) {
      expect(action.actionArgs).toBeDefined();
      const target = action.actionArgs!.worktreeId ?? action.actionArgs!.cwd;
      expect(["wt-2", "/repo/wt-2"]).toContain(target);
    }
  });

  it("suggests opening Review Hub — not git.stageAll — for unstaged-only worktrees", async () => {
    mockGetStagingStatus.mockResolvedValue(
      makeStatus({
        staged: [],
        unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
      })
    );
    const def = getDefinition();
    const result = (await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext)) as {
      warnings: { id: string; actionId?: string }[];
    };
    const item = result.warnings.find((w) => w.id === "nothing-staged");
    expect(item).toBeDefined();
    expect(item!.actionId).toBe("worktree.openReviewHub");
  });

  it("suggests git.pullRebase with the worktree cwd when behind the remote", async () => {
    setWorktrees([{ ...BASE_WORKTREE, behindCount: 2 }]);
    const def = getDefinition();
    const result = (await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext)) as {
      warnings: { id: string; actionId?: string; actionArgs?: Record<string, string> }[];
    };
    const item = result.warnings.find((w) => w.id === "behind-remote");
    expect(item).toMatchObject({
      actionId: "git.pullRebase",
      actionArgs: { cwd: "/repo/wt-1" },
    });
  });

  it("maps the linked PR and its CI rollup into the result", async () => {
    setWorktrees([
      {
        ...BASE_WORKTREE,
        linked: {
          providerId: "daintree.github.github",
          pr: {
            ref: {
              providerId: "daintree.github.github",
              owner: "o",
              repo: "r",
              number: 42,
              rawData: null,
            },
            url: "https://example.com/pr/42",
            state: "open",
            ciStatus: { state: "failure" },
          },
        },
      },
    ]);
    const def = getDefinition();
    const result = (await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext)) as {
      pr: unknown;
      prReady: unknown;
      warnings: { id: string }[];
    };
    expect(result.pr).toEqual({
      number: 42,
      state: "open",
      url: "https://example.com/pr/42",
      ciState: "failure",
    });
    expect(result.prReady).toBe(false);
    expect(result.warnings.map((w) => w.id)).toContain("ci-failing");
  });

  it("surfaces forge provider health for the matched provider", async () => {
    setWorktrees([{ ...BASE_WORKTREE, matchedForgeProviderId: "daintree.github.github" }]);
    mockHealthProviders.current = {
      "daintree.github.github": { rateLimitBlocked: true, tokenUnhealthy: false },
    };
    const def = getDefinition();
    const result = (await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext)) as {
      forge: { providerId: string | null; rateLimited: boolean; authUnhealthy: boolean };
      warnings: { id: string }[];
    };
    expect(result.forge).toEqual({
      providerId: "daintree.github.github",
      rateLimited: true,
      authUnhealthy: false,
    });
    expect(result.warnings.map((w) => w.id)).toContain("forge-rate-limited");
  });

  it("reports no forge context when no provider matched", async () => {
    const def = getDefinition();
    const result = (await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext)) as {
      forge: { providerId: string | null; rateLimited: boolean; authUnhealthy: boolean };
    };
    expect(result.forge).toEqual({ providerId: null, rateLimited: false, authUnhealthy: false });
  });

  it("is idempotent across repeated queries", async () => {
    const def = getDefinition();
    const first = await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext);
    const second = await def.run({ worktreeId: "wt-1" } as never, {} as ActionContext);
    expect(second).toEqual(first);
    expect(mockGetStagingStatus).toHaveBeenCalledTimes(2);
  });
});
