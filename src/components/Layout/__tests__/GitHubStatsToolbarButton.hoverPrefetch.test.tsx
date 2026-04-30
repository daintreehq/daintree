// @vitest-environment jsdom
/**
 * GitHubStatsToolbarButton — hover-to-prefetch (issue #6282).
 *
 * The Issues and PRs toolbar buttons start the list and stats fetch on
 * pointerenter (mouse only) so the requests are already in flight by the
 * time the user clicks. The 150ms trailing-edge debounce filters mouse
 * traversal across the toolbar; pointerleave cancels a pending prefetch.
 * Cache freshness, token errors, rate limits, and open dropdowns short-
 * circuit the prefetch so it never duplicates work.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { fireEvent } from "@testing-library/react";
import type { GitHubIssue, GitHubPR, GitHubListResponse } from "@shared/types/github";
import { buildCacheKey, getCache, setCache, _resetForTests } from "@/lib/githubResourceCache";
import { useGitHubFilterStore } from "@/store/githubFilterStore";

const mockListIssues = vi.fn<(args: unknown) => Promise<GitHubListResponse<GitHubIssue>>>();
const mockListPRs = vi.fn<(args: unknown) => Promise<GitHubListResponse<GitHubPR>>>();

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    listIssues: (args: unknown) => mockListIssues(args),
    listPullRequests: (args: unknown) => mockListPRs(args),
  },
}));

const refreshStatsMock = vi.fn().mockResolvedValue(undefined);
let mockIsTokenError = false;
let mockRateLimitResetAt: number | null = null;

vi.mock("@/hooks/useRepositoryStats", () => ({
  useRepositoryStats: () => ({
    stats: { issueCount: 3, prCount: 2, commitCount: 0 },
    loading: false,
    error: null,
    isTokenError: mockIsTokenError,
    refresh: refreshStatsMock,
    isStale: false,
    lastUpdated: Date.now(),
    rateLimitResetAt: mockRateLimitResetAt,
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

let mockGitHubConfig: { hasToken: boolean } | null = { hasToken: true };
vi.mock("@/store/githubConfigStore", () => {
  const useGitHubConfigStore = () => mockGitHubConfig;
  (useGitHubConfigStore as unknown as { getState: () => unknown }).getState = () => ({
    config: mockGitHubConfig,
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
  FixedDropdown: () => null,
}));

vi.mock("@/components/GitHub/GitHubDropdownSkeletons", () => ({
  GitHubResourceListSkeleton: () => null,
  CommitListSkeleton: () => null,
}));

vi.mock("../GitHubStatusIndicator", () => ({
  GitHubStatusIndicator: () => null,
}));

vi.mock("@/components/GitHub/GitHubResourceList", () => ({
  GitHubResourceList: () => null,
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

const makeIssue = (n: number): GitHubIssue => ({
  number: n,
  title: `Issue #${n}`,
  url: `https://github.com/test/repo/issues/${n}`,
  state: "OPEN",
  updatedAt: "2026-01-01",
  author: { login: "user", avatarUrl: "" },
  assignees: [],
  commentCount: 0,
});

const makePR = (n: number): GitHubPR => {
  const base = makeIssue(n) as unknown as Record<string, unknown>;
  return { ...base, isDraft: false } as unknown as GitHubPR;
};

const makeIssueResponse = (items: GitHubIssue[]): GitHubListResponse<GitHubIssue> => ({
  items,
  pageInfo: { hasNextPage: false, endCursor: null },
});

const makePRResponse = (items: GitHubPR[]): GitHubListResponse<GitHubPR> => ({
  items,
  pageInfo: { hasNextPage: false, endCursor: null },
});

function renderToolbar() {
  return render(<GitHubStatsToolbarButton currentProject={PROJECT} />);
}

function getIssuesButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(
    'button[aria-label*="open issues"], button[aria-label*="Configure GitHub token to see issues"]'
  );
  if (!btn) throw new Error("Issues button not found");
  return btn;
}

function getPrsButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(
    'button[aria-label*="open pull requests"], button[aria-label*="Configure GitHub token to see pull requests"]'
  );
  if (!btn) throw new Error("PRs button not found");
  return btn;
}

function pointerEnter(el: Element, pointerType: "mouse" | "touch" | "pen" = "mouse"): void {
  fireEvent.pointerEnter(el, { pointerType });
}

function pointerLeave(el: Element, pointerType: "mouse" | "touch" | "pen" = "mouse"): void {
  fireEvent.pointerLeave(el, { pointerType });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  _resetForTests();
  mockListIssues.mockReset();
  mockListPRs.mockReset();
  refreshStatsMock.mockClear();
  mockIsTokenError = false;
  mockRateLimitResetAt = null;
  mockGitHubConfig = { hasToken: true };
  const filterStore = useGitHubFilterStore.getState();
  filterStore.setIssueFilter("open");
  filterStore.setPrFilter("open");
  filterStore.setIssueSortOrder("created");
  filterStore.setPrSortOrder("created");
  mockListIssues.mockResolvedValue(makeIssueResponse([makeIssue(1)]));
  mockListPRs.mockResolvedValue(makePRResponse([makePR(2)]));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GitHubStatsToolbarButton hover prefetch", () => {
  it("fires listIssues 150ms after pointerenter on the Issues button", async () => {
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));

    expect(mockListIssues).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).toHaveBeenCalledTimes(1);
    expect(mockListIssues.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/test/proj",
      state: "open",
      bypassCache: true,
      sortOrder: "created",
    });
  });

  it("fires listPullRequests 150ms after pointerenter on the PRs button", async () => {
    const { container } = renderToolbar();

    pointerEnter(getPrsButton(container));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListPRs).toHaveBeenCalledTimes(1);
    expect(mockListPRs.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/test/proj",
      state: "open",
      bypassCache: true,
      sortOrder: "created",
    });
  });

  it("calls refreshStats (non-forced) when prefetch fires", async () => {
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(refreshStatsMock).toHaveBeenCalled();
    // Non-forced: refresh() called with no args (or no force flag).
    const call = refreshStatsMock.mock.calls[refreshStatsMock.mock.calls.length - 1];
    expect(call?.[0]?.force).toBeUndefined();
  });

  it("writes prefetch result to the cache under the matching key", async () => {
    mockListIssues.mockResolvedValue({
      items: [makeIssue(11), makeIssue(12)],
      pageInfo: { hasNextPage: true, endCursor: "cursor-z" },
    });
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // Allow the request promise to settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const cached = getCache(buildCacheKey("/test/proj", "issue", "open", "created"));
    expect(cached).toBeDefined();
    expect(cached!.items.map((i) => i.number)).toEqual([11, 12]);
    expect(cached!.endCursor).toBe("cursor-z");
    expect(cached!.hasNextPage).toBe(true);
  });

  it("does not fire when pointerleave happens before the debounce elapses", async () => {
    const { container } = renderToolbar();
    const button = getIssuesButton(container);

    pointerEnter(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    pointerLeave(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("ignores non-mouse pointer types (touch)", async () => {
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container), "touch");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
    expect(refreshStatsMock).not.toHaveBeenCalled();
  });

  it("skips the prefetch when the cache entry is fresh (<10s)", async () => {
    setCache(buildCacheKey("/test/proj", "issue", "open", "created"), {
      items: [makeIssue(99)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now() - 1_000,
    });
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
    expect(refreshStatsMock).not.toHaveBeenCalled();
  });

  it("does fire the prefetch when the cache entry is stale (>10s)", async () => {
    setCache(buildCacheKey("/test/proj", "issue", "open", "created"), {
      items: [makeIssue(99)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now() - 11_000,
    });
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("does not fire when isTokenError is true", async () => {
    mockIsTokenError = true;
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
    expect(refreshStatsMock).not.toHaveBeenCalled();
  });

  it("does not fire when rate limit is active", async () => {
    mockRateLimitResetAt = Date.now() + 60_000;
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("uses the current filter and sort when constructing the cache key", async () => {
    useGitHubFilterStore.getState().setPrFilter("merged");
    useGitHubFilterStore.getState().setPrSortOrder("updated");
    mockListPRs.mockResolvedValue({
      items: [makePR(50)],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    const { container } = renderToolbar();

    pointerEnter(getPrsButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockListPRs.mock.calls[0]?.[0]).toMatchObject({
      state: "merged",
      sortOrder: "updated",
    });
    const cached = getCache(buildCacheKey("/test/proj", "pr", "merged", "updated"));
    expect(cached).toBeDefined();
    expect(cached!.items.map((i) => i.number)).toEqual([50]);
  });

  it("coalesces concurrent hovers — pointerenter while a prefetch is in flight does not re-fetch", async () => {
    let resolveFirst: (v: GitHubListResponse<GitHubIssue>) => void = () => {};
    mockListIssues.mockImplementationOnce(
      () =>
        new Promise<GitHubListResponse<GitHubIssue>>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const { container } = renderToolbar();
    const button = getIssuesButton(container);

    pointerEnter(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(mockListIssues).toHaveBeenCalledTimes(1);

    // Hover again while the first request is still in flight.
    pointerLeave(button);
    pointerEnter(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(mockListIssues).toHaveBeenCalledTimes(1);

    // Settle the first request.
    resolveFirst(makeIssueResponse([makeIssue(1)]));
  });

  it("does not prefetch when the dropdown is already open (would duplicate the list's mount fetch)", async () => {
    // Simulate the open state by clicking the button first — onClick toggles
    // open and triggers a forced refresh. The mounted GitHubResourceList is
    // mocked to render nothing, but the toolbar tracks issuesOpen=true.
    const { container } = renderToolbar();
    const button = getIssuesButton(container);

    fireEvent.click(button);
    refreshStatsMock.mockClear();
    mockListIssues.mockClear();

    pointerEnter(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
    expect(refreshStatsMock).not.toHaveBeenCalled();
  });

  it("clears pending hover timer on unmount (no fetch after unmount)", async () => {
    const { container, unmount } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("preserves click-time forced refresh as a fallback for touch/keyboard users", async () => {
    const { container } = renderToolbar();
    const button = getIssuesButton(container);

    fireEvent.click(button);

    expect(refreshStatsMock).toHaveBeenCalledWith({ force: true });
  });

  it("hover-then-click within the debounce window cancels the pending prefetch", async () => {
    const { container } = renderToolbar();
    const button = getIssuesButton(container);

    pointerEnter(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    fireEvent.click(button);
    refreshStatsMock.mockClear();
    mockListIssues.mockClear();

    // Even though the timer was scheduled before the click, the dropdown is
    // now open and the timer must short-circuit when it fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
    expect(refreshStatsMock).not.toHaveBeenCalled();
  });

  it("clears the in-flight ref after a rejection so a subsequent hover refetches", async () => {
    mockListIssues
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue(makeIssueResponse([makeIssue(7)]));
    const { container } = renderToolbar();
    const button = getIssuesButton(container);

    pointerEnter(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // Let the rejection settle through the .catch/.finally chain.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockListIssues).toHaveBeenCalledTimes(1);

    // Second hover after rejection should refetch — but the cached freshness
    // skip would block it if a stale entry got written. Verify no entry
    // exists, then re-hover.
    expect(getCache(buildCacheKey("/test/proj", "issue", "open", "created"))).toBeUndefined();
    pointerLeave(button);
    pointerEnter(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).toHaveBeenCalledTimes(2);
  });

  it("skips the prefetch when the user has no GitHub token configured", async () => {
    mockGitHubConfig = { hasToken: false };
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).not.toHaveBeenCalled();
    expect(refreshStatsMock).not.toHaveBeenCalled();
  });

  it("treats a cache entry exactly at the freshness boundary (10s old) as stale", async () => {
    setCache(buildCacheKey("/test/proj", "issue", "open", "created"), {
      items: [makeIssue(99)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now() - 10_000,
    });
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });
});
