// @vitest-environment jsdom
/**
 * GitHubStatsToolbarButton — onFreshFetch wiring (issue #6390).
 *
 * When `GitHubResourceList` lands fresh first-page data on a SWR revalidation,
 * it calls the `onFreshFetch` callback. The toolbar wires this to
 * `refreshStats()` so the dropdown's just-updated count converges into the
 * badge in the same user interaction (no waiting for the 30s poll).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { _resetForTests } from "@/lib/githubResourceCache";
import { useGitHubFilterStore } from "@/store/githubFilterStore";

const refreshStatsMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    listIssues: vi.fn(),
    listPullRequests: vi.fn(),
  },
}));

vi.mock("@/hooks/useRepositoryStats", () => ({
  useRepositoryStats: () => ({
    stats: { issueCount: 3, prCount: 2, commitCount: 0 },
    loading: false,
    error: null,
    isTokenError: false,
    refresh: refreshStatsMock,
    isStale: false,
    lastUpdated: Date.now(),
    rateLimitResetAt: null,
    rateLimitKind: null,
  }),
}));

vi.mock("@/hooks/useGitHubTokenExpiryNotification", () => ({
  useGitHubTokenExpiryNotification: () => {},
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (sel: (s: { activeWorktreeId: string | null }) => unknown) =>
    sel({ activeWorktreeId: null }),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees: new Map() }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/store/githubConfigStore", () => {
  const mockConfig = { hasToken: true };
  const useGitHubConfigStore = () => mockConfig;
  (useGitHubConfigStore as unknown as { getState: () => unknown }).getState = () => ({
    config: mockConfig,
  });
  return { useGitHubConfigStore };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/fixed-dropdown", () => ({
  FixedDropdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/GitHub/GitHubDropdownSkeletons", () => ({
  GitHubResourceListSkeleton: () => null,
  CommitListSkeleton: () => null,
}));

vi.mock("../GitHubStatusIndicator", () => ({
  GitHubStatusIndicator: () => null,
}));

// Capture `onFreshFetch` props per ResourceList instance keyed by `type`,
// then invoke them from the test to simulate a successful revalidation.
const capturedFreshFetch: { issue?: () => void; pr?: () => void } = {};

vi.mock("@/components/GitHub/GitHubResourceList", () => ({
  GitHubResourceList: ({
    type,
    onFreshFetch,
  }: {
    type: "issue" | "pr";
    onFreshFetch?: () => void;
  }) => {
    capturedFreshFetch[type] = onFreshFetch;
    return null;
  },
}));

vi.mock("@/components/GitHub/CommitList", () => ({
  CommitList: () => null,
}));

import { GitHubStatsToolbarButton } from "../GitHubStatsToolbarButton";
import type { Project } from "@shared/types";

const PROJECT: Project = {
  id: "test-proj",
  path: "/test/proj",
  name: "proj",
  emoji: "🌲",
  lastOpened: 0,
};

beforeEach(() => {
  _resetForTests();
  refreshStatsMock.mockClear();
  capturedFreshFetch.issue = undefined;
  capturedFreshFetch.pr = undefined;
  const filterStore = useGitHubFilterStore.getState();
  filterStore.setIssueFilter("open");
  filterStore.setPrFilter("open");
  filterStore.setIssueSortOrder("created");
  filterStore.setPrSortOrder("created");
});

afterEach(() => {
  cleanup();
});

describe("GitHubStatsToolbarButton onFreshFetch wiring", () => {
  it("passes a stable handler that calls refreshStats() on the issues dropdown", async () => {
    render(<GitHubStatsToolbarButton currentProject={PROJECT} />);

    // Eager dynamic import resolves on a microtask after mount; flush so the
    // ResourceListComponent state lands and the dropdown renders the captured
    // mock with `onFreshFetch` wired through.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(capturedFreshFetch.issue).toBeTypeOf("function");

    act(() => {
      capturedFreshFetch.issue?.();
    });

    expect(refreshStatsMock).toHaveBeenCalledTimes(1);
    // No `force: true` — the call must read from the freshly-updated
    // main-process repoStatsCache, not bypass it with a network round-trip.
    expect(refreshStatsMock.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("passes a stable handler that calls refreshStats() on the PRs dropdown", async () => {
    render(<GitHubStatsToolbarButton currentProject={PROJECT} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(capturedFreshFetch.pr).toBeTypeOf("function");

    act(() => {
      capturedFreshFetch.pr?.();
    });

    expect(refreshStatsMock).toHaveBeenCalledTimes(1);
    expect(refreshStatsMock.mock.calls[0]?.[0]).toBeUndefined();
  });
});
