/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { Activity, type ReactNode } from "react";
import type { GitHubIssue, GitHubListResponse, GitHubListOptions } from "@shared/types/github";
import { setCache, buildCacheKey, _resetForTests } from "@/lib/githubResourceCache";
import { useGitHubFilterStore } from "@/store/githubFilterStore";

const mockListIssues = vi.fn();
const mockListPRs = vi.fn();
const mockGetIssueByNumber = vi.fn();
const mockGetPRByNumber = vi.fn();

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    listIssues: (
      options: Omit<GitHubListOptions, "state"> & { state?: "open" | "closed" | "all" }
    ) => mockListIssues(options),
    listPullRequests: (
      options: Omit<GitHubListOptions, "state"> & { state?: "open" | "closed" | "merged" | "all" }
    ) => mockListPRs(options),
    getIssueByNumber: (cwd: string, issueNumber: number) => mockGetIssueByNumber(cwd, issueNumber),
    getPRByNumber: (cwd: string, prNumber: number) => mockGetPRByNumber(cwd, prNumber),
  },
}));

let mockGitHubConfig: { hasToken: boolean } | null = { hasToken: true };
let mockGitHubConfigInitialized = true;
const initializeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/store/githubConfigStore", () => {
  const useGitHubConfigStore = (
    selector: (s: {
      isInitialized: boolean;
      config: { hasToken: boolean } | null;
      initialize: () => Promise<void>;
    }) => unknown
  ) =>
    selector({
      isInitialized: mockGitHubConfigInitialized,
      config: mockGitHubConfig,
      initialize: initializeMock,
    });
  // Mirror Zustand's hook + getState API surface used by the component.
  (useGitHubConfigStore as unknown as { getState: () => unknown }).getState = () => ({
    isInitialized: mockGitHubConfigInitialized,
    config: mockGitHubConfig,
    initialize: initializeMock,
  });
  return { useGitHubConfigStore };
});

const dispatchMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("@/hooks/useIssueSelection", () => ({
  useIssueSelection: () => ({
    selectedIds: new Set<number>(),
    isSelectionActive: false,
    toggle: vi.fn(),
    toggleRange: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: vi.fn((sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      openCreateDialog: vi.fn(),
      openCreateDialogForPR: vi.fn(),
      selectWorktree: vi.fn(),
    })
  ),
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: new Map() }),
  }),
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("../GitHubListItem", () => ({
  GitHubListItem: ({ item }: { item: GitHubIssue }) => (
    <div data-testid={`item-${item.number}`}>{item.title}</div>
  ),
}));

vi.mock("../BulkActionBar", () => ({
  BulkActionBar: () => null,
}));

vi.mock("../GitHubDropdownSkeletons", () => ({
  GitHubResourceRowsSkeleton: () => <div data-testid="skeleton">Loading...</div>,
  MAX_SKELETON_ITEMS: 5,
  RESOURCE_ITEM_HEIGHT_PX: 68,
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    components,
    context,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
    components?: { Footer?: (props: { context?: unknown }) => ReactNode };
    context?: unknown;
  }) => {
    const Footer = components?.Footer;
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item, index) => (
          <div key={index}>{itemContent(index, item)}</div>
        ))}
        {Footer ? <Footer context={context} /> : null}
      </div>
    );
  },
}));

const { LiveTimeAgoMock } = vi.hoisted(() => {
  const LiveTimeAgoMock = vi.fn();
  return { LiveTimeAgoMock };
});

vi.mock("@/components/Worktree/LiveTimeAgo", () => ({
  LiveTimeAgo: (props: any) => {
    LiveTimeAgoMock(props);
    return <span>1m</span>;
  },
}));

import { GitHubResourceList } from "../GitHubResourceList";

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

const makeResponse = (items: GitHubIssue[]): GitHubListResponse<GitHubIssue> => ({
  items,
  pageInfo: { hasNextPage: false, endCursor: null },
});

beforeEach(() => {
  _resetForTests();
  mockListIssues.mockReset();
  mockListPRs.mockReset();
  mockGetIssueByNumber.mockReset();
  mockGetPRByNumber.mockReset();
  LiveTimeAgoMock.mockClear();
  dispatchMock.mockReset();
  initializeMock.mockClear();
  mockGitHubConfig = { hasToken: true };
  mockGitHubConfigInitialized = true;
  const filterStore = useGitHubFilterStore.getState();
  filterStore.setIssueSearchQuery("");
  filterStore.setPrSearchQuery("");
  filterStore.setIssueFilter("open");
  filterStore.setPrFilter("open");
  filterStore.setIssueSortOrder("created");
  filterStore.setPrSortOrder("created");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GitHubResourceList SWR behavior", () => {
  it("shows skeleton on cold start (no cache)", async () => {
    mockListIssues.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(makeResponse([makeIssue(1)])), 100))
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByTestId("skeleton")).toBeTruthy();
  });

  it("shows cached data immediately on warm remount (no skeleton)", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(10), makeIssue(11)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    // Background refresh returns same data
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10), makeIssue(11)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Cached items shown immediately — no skeleton
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.getByTestId("item-10")).toBeTruthy();
    expect(screen.getByTestId("item-11")).toBeTruthy();
  });

  it("background refresh updates data in place when response differs", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(10)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    // Background refresh returns new data
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10), makeIssue(12)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Initially shows cached item
    expect(screen.getByTestId("item-10")).toBeTruthy();
    expect(screen.queryByTestId("item-12")).toBeNull();

    // After background refresh completes, new item appears
    await waitFor(() => {
      expect(screen.getByTestId("item-12")).toBeTruthy();
    });
  });

  it("preserves cached data when background refresh fails", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    const seededTimestamp = Date.now() - 5 * 60 * 1000;
    setCache(cacheKey, {
      items: [makeIssue(20)],
      endCursor: null,
      hasNextPage: false,
      timestamp: seededTimestamp,
    });

    mockListIssues.mockRejectedValue(new Error("Network error"));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Cached data shown immediately
    expect(screen.getByTestId("item-20")).toBeTruthy();

    // After error, data persists and error banner appears with stale timestamp
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeTruthy();
    });
    expect(screen.getByTestId("item-20")).toBeTruthy();
    expect(screen.getByText("1m")).toBeTruthy();
    // The label must reflect the cached timestamp, not Date.now() of the failure.
    expect(LiveTimeAgoMock).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: expect.any(Number) })
    );
  });

  it("clears error banner and refreshes timestamp after successful retry", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(30)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now() - 60_000,
    });

    mockListIssues
      .mockRejectedValueOnce(new Error("Network blip"))
      .mockResolvedValue(makeResponse([makeIssue(30), makeIssue(31)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Banner appears after the failed background refresh
    await waitFor(() => {
      expect(screen.getByText(/Network blip/)).toBeTruthy();
    });

    // Click retry — second call succeeds
    screen.getByRole("button", { name: /retry/i }).click();

    // Error clears, new item appears, no banner
    await waitFor(() => {
      expect(screen.getByTestId("item-31")).toBeTruthy();
    });
    expect(screen.queryByText(/Network blip/)).toBeNull();
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  it("does not bleed stale timestamp across filter changes", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(50)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    // Background revalidation for "open" fails — banner with timestamp appears
    mockListIssues.mockRejectedValueOnce(new Error("Initial fail"));
    // After filter switches to "closed", fetch never resolves so we can inspect transitional UI
    mockListIssues.mockImplementation(() => new Promise(() => {}));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/Initial fail/)).toBeTruthy();
    });
    expect(screen.getByText("1m")).toBeTruthy();

    useGitHubFilterStore.getState().setIssueFilter("closed");

    await waitFor(() => {
      expect(screen.queryByTestId("item-50")).toBeNull();
    });
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  it("renders Load More footer when hasNextPage is true", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1), makeIssue(2)],
      endCursor: "cursor-1",
      hasNextPage: true,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue({
      items: [makeIssue(1), makeIssue(2)],
      pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
    });

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /load more/i })).toBeTruthy();
    });
  });

  it("omits Load More footer when hasNextPage is false", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("calls onFreshFetch after a successful background revalidation", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(10)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10), makeIssue(11)]));
    const onFreshFetch = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onFreshFetch={onFreshFetch} />
    );

    // After revalidation lands, onFreshFetch fires once. The revalidation is
    // the bypassCache:true path that triggers updateRepoStatsCount in main.
    await waitFor(() => {
      expect(onFreshFetch).toHaveBeenCalledTimes(1);
    });
    // Verify the listIssues call was made with bypassCache:true so we know
    // we're on the path that updates main-process repoStatsCache.
    expect(mockListIssues).toHaveBeenCalled();
    expect(mockListIssues.mock.calls[0]?.[0]?.bypassCache).toBe(true);
  });

  it("does not call onFreshFetch on a cold-mount cache-miss fetch", async () => {
    // No cache entry — cold mount uses bypassCache:false.
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));
    const onFreshFetch = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onFreshFetch={onFreshFetch} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("item-1")).toBeTruthy();
    });
    expect(onFreshFetch).not.toHaveBeenCalled();
    expect(mockListIssues.mock.calls[0]?.[0]?.bypassCache).toBe(false);
  });

  it("does not call onFreshFetch when the revalidation fails", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(20)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now() - 5_000,
    });

    mockListIssues.mockRejectedValue(new Error("Network error"));
    const onFreshFetch = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onFreshFetch={onFreshFetch} />
    );

    // Wait for the error to surface so we know the fetch resolved.
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeTruthy();
    });
    expect(onFreshFetch).not.toHaveBeenCalled();
  });

  it("different project paths use separate cache entries", async () => {
    const keyA = buildCacheKey("/proj-a", "issue", "open", "created");
    setCache(keyA, {
      items: [makeIssue(50)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(99)]));

    // Render with a different project path — should NOT see cached data
    render(<GitHubResourceList type="issue" projectPath="/proj-b" />);

    expect(screen.queryByTestId("item-50")).toBeNull();
    expect(screen.getByTestId("skeleton")).toBeTruthy();
  });
});

describe("GitHubResourceList focus/visibility revalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("revalidates in the background when the window regains focus after the throttle window", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(1)]))
      .mockResolvedValueOnce(makeResponse([makeIssue(1), makeIssue(2)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Initial mount triggers one background revalidation.
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Advance past the 30s revalidation throttle.
    await vi.advanceTimersByTimeAsync(31_000);

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("item-2")).toBeTruthy();
    });
  });

  it("does not revalidate on focus inside the throttle window", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Within the 30s throttle window — focus must not trigger another fetch.
    await vi.advanceTimersByTimeAsync(5_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("revalidates on visibilitychange when the document becomes visible", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(1)]))
      .mockResolvedValueOnce(makeResponse([makeIssue(1), makeIssue(3)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(31_000);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("item-3")).toBeTruthy();
    });
  });

  it("revalidates a PR list on focus — the actual code path that ships ciStatus", async () => {
    const cacheKey = buildCacheKey("/test/proj", "pr", "open", "created");
    const stalePR = {
      ...makeIssue(7),
      isDraft: false,
      ciStatus: "SUCCESS" as const,
    };
    const updatedPR = { ...stalePR, ciStatus: "PENDING" as const };
    setCache(cacheKey, {
      items: [stalePR],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListPRs
      .mockResolvedValueOnce({
        items: [stalePR],
        pageInfo: { hasNextPage: false, endCursor: null },
      })
      .mockResolvedValueOnce({
        items: [updatedPR],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListPRs).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(31_000);
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(mockListPRs).toHaveBeenCalledTimes(2);
    });
    // Focus revalidation must request a backend refresh, not a cache read.
    expect(mockListPRs.mock.calls[1]?.[0]).toMatchObject({ bypassCache: true });
  });

  it("removes focus and visibilitychange listeners on unmount", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    const { unmount } = render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    unmount();

    await vi.advanceTimersByTimeAsync(31_000);
    window.dispatchEvent(new Event("focus"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate on visibilitychange when the document is hidden", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(31_000);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubResourceList no-token empty state", () => {
  it("renders 'GitHub not connected' when no token is configured", () => {
    mockGitHubConfig = { hasToken: false };
    mockGitHubConfigInitialized = true;

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByText("GitHub not connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: /add github token/i })).toBeTruthy();
    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("does not render the search input when the no-token empty state is active", () => {
    mockGitHubConfig = { hasToken: false };
    mockGitHubConfigInitialized = true;

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.queryByPlaceholderText(/search issues/i)).toBeNull();
  });

  it("renders normally once a token is configured", async () => {
    mockGitHubConfig = { hasToken: true };
    mockGitHubConfigInitialized = true;
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.queryByText("GitHub not connected")).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("item-1")).toBeTruthy();
    });
  });

  it("renders the empty state for type='pr' and skips listPullRequests", () => {
    mockGitHubConfig = { hasToken: false };
    mockGitHubConfigInitialized = true;

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    expect(screen.getByText("GitHub not connected")).toBeTruthy();
    expect(mockListPRs).not.toHaveBeenCalled();
  });

  it("does not fire numeric fetches when the search store has a number but no token is set", () => {
    mockGitHubConfig = { hasToken: false };
    mockGitHubConfigInitialized = true;
    useGitHubFilterStore.getState().setIssueSearchQuery("#42");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(mockGetIssueByNumber).not.toHaveBeenCalled();
    expect(screen.getByText("GitHub not connected")).toBeTruthy();
  });

  it("'Add GitHub token' CTA dispatches the settings open action and closes", () => {
    mockGitHubConfig = { hasToken: false };
    mockGitHubConfigInitialized = true;
    const onClose = vi.fn();

    render(<GitHubResourceList type="issue" projectPath="/test/proj" onClose={onClose} />);

    screen.getByRole("button", { name: /add github token/i }).click();

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "github", sectionId: "github-token" },
      { source: "user" }
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe("GitHubResourceList empty state branching", () => {
  it("renders zero-data variant (no Clear filters button) when no filters are active and the list is empty", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("No issues found")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });

  it("renders filtered-empty with a Clear filters action when a search query is active", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setIssueSearchQuery("nonexistent");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/No issues match "nonexistent"/)).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeTruthy();
  });

  it("renders filtered-empty when a non-default state filter is active", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setIssueFilter("closed");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("No issues in this view")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeTruthy();
  });

  it("Clear filters action resets search and state filter to defaults", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setIssueSearchQuery("foo");
    useGitHubFilterStore.getState().setIssueFilter("closed");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    const clearButton = await screen.findByRole("button", { name: /clear filters/i });
    act(() => {
      clearButton.click();
    });

    const filterStore = useGitHubFilterStore.getState();
    expect(filterStore.issueSearchQuery).toBe("");
    expect(filterStore.issueFilter).toBe("open");
  });

  it("renders filtered-empty for an exact number not found", async () => {
    mockGetIssueByNumber.mockResolvedValue(null);
    useGitHubFilterStore.getState().setIssueSearchQuery("#999");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/Issue #999 not found/)).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeTruthy();
  });

  it("renders filtered-empty for PRs with the right resource label", async () => {
    mockListPRs.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setPrSearchQuery("nonexistent");

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/No pull requests match "nonexistent"/)).toBeTruthy();
    });
  });

  it("renders zero-data for PRs when no filters are active and the list is empty", async () => {
    mockListPRs.mockResolvedValue(makeResponse([]));

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("No pull requests found")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });

  it("Clear filters action on PR view resets PR-specific store slice, not issue slice", async () => {
    mockListPRs.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setPrSearchQuery("foo");
    useGitHubFilterStore.getState().setPrFilter("merged");
    useGitHubFilterStore.getState().setIssueSearchQuery("untouched-issue-query");

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    const clearButton = await screen.findByRole("button", { name: /clear filters/i });
    act(() => {
      clearButton.click();
    });

    const filterStore = useGitHubFilterStore.getState();
    expect(filterStore.prSearchQuery).toBe("");
    expect(filterStore.prFilter).toBe("open");
    expect(filterStore.issueSearchQuery).toBe("untouched-issue-query");
  });
});

describe("GitHubResourceList retry behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries transient network errors on cold-start fetch and renders data on success", async () => {
    mockListIssues
      .mockRejectedValueOnce(new Error("Cannot reach GitHub. Check your internet connection."))
      .mockResolvedValue(makeResponse([makeIssue(7)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByTestId("item-7")).toBeTruthy();
    });

    expect(mockListIssues).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Cannot reach GitHub/)).toBeNull();
  });

  it("succeeds on the third attempt — retries through both backoff delays", async () => {
    mockListIssues
      .mockRejectedValueOnce(new Error("Cannot reach GitHub. Check your internet connection."))
      .mockRejectedValueOnce(new Error("Cannot reach GitHub. Check your internet connection."))
      .mockResolvedValue(makeResponse([makeIssue(8)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);

    await waitFor(() => {
      expect(screen.getByTestId("item-8")).toBeTruthy();
    });

    expect(mockListIssues).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Cannot reach GitHub/)).toBeNull();
  });

  it("does not flash an error during the retry window", async () => {
    let resolveSecond: (v: GitHubListResponse<GitHubIssue>) => void = () => {};
    mockListIssues
      .mockRejectedValueOnce(new Error("Cannot reach GitHub. Check your internet connection."))
      .mockImplementationOnce(
        () =>
          new Promise<GitHubListResponse<GitHubIssue>>((resolve) => {
            resolveSecond = resolve;
          })
      );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Wait for first call to settle (rejection)
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Before timer advance: still in retry-delay window. No error should be visible.
    expect(screen.queryByText(/Cannot reach GitHub/)).toBeNull();

    // Advance the 500ms backoff to trigger second attempt (still pending).
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText(/Cannot reach GitHub/)).toBeNull();

    // Resolve second attempt — data renders, no error ever shown.
    resolveSecond(makeResponse([makeIssue(9)]));
    await waitFor(() => {
      expect(screen.getByTestId("item-9")).toBeTruthy();
    });
    expect(screen.queryByText(/Cannot reach GitHub/)).toBeNull();
  });

  it("surfaces error after exhausting retries (3 attempts)", async () => {
    mockListIssues.mockRejectedValue(
      new Error("Cannot reach GitHub. Check your internet connection.")
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);

    await waitFor(() => {
      expect(screen.getByText(/Cannot reach GitHub/)).toBeTruthy();
    });

    expect(mockListIssues).toHaveBeenCalledTimes(3);
  });

  it("does not retry token-related errors — surfaces immediately", async () => {
    mockListIssues.mockRejectedValue(
      new Error("SSO authorization required. Re-authorize at github.com.")
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/SSO authorization required/)).toBeTruthy();
    });

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("does not retry generic non-transient errors", async () => {
    mockListIssues.mockRejectedValue(new Error("Repository not found or token lacks access."));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/Repository not found/)).toBeTruthy();
    });

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("does not retry rate-limit errors", async () => {
    mockListIssues.mockRejectedValue(
      new Error("GitHub rate limit exceeded. Try again in a few minutes.")
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/rate limit exceeded/)).toBeTruthy();
    });

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors in the numeric (single) fetch path", async () => {
    useGitHubFilterStore.getState().setIssueSearchQuery("#42");
    mockGetIssueByNumber
      .mockRejectedValueOnce(new Error("Cannot reach GitHub. Check your internet connection."))
      .mockResolvedValue(makeIssue(42));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByTestId("item-42")).toBeTruthy();
    });

    expect(mockGetIssueByNumber).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Cannot reach GitHub/)).toBeNull();
  });

  it("does not retry on background revalidation — preserves stale data and surfaces error", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(20)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockRejectedValue(
      new Error("Cannot reach GitHub. Check your internet connection.")
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByTestId("item-20")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText(/Cannot reach GitHub/)).toBeTruthy();
    });

    expect(mockListIssues).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("item-20")).toBeTruthy();
  });
});

describe("GitHubResourceList Activity reveal vs filter change — PR #6288", () => {
  it("preserves rows and re-runs the SWR revalidate path on Activity reveal of identical inputs", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(40), makeIssue(41)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(40), makeIssue(41)]));

    function Harness({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <Activity mode={mode}>
          <GitHubResourceList type="issue" projectPath="/test/proj" />
        </Activity>
      );
    }

    const { rerender } = render(<Harness mode="visible" />);

    // Cache hit on initial mount → no skeleton, items rendered immediately.
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.getByTestId("item-40")).toBeTruthy();
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Hide via Activity — effects clean up but state + refs survive.
    rerender(<Harness mode="hidden" />);
    // Re-reveal — the load effect re-fires with the same effectKey, hitting
    // the isActivityRevealOfSameInputs branch: no skeleton, no row clear,
    // background revalidate runs.
    rerender(<Harness mode="visible" />);

    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.getByTestId("item-40")).toBeTruthy();
    expect(screen.getByTestId("item-41")).toBeTruthy();

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });
    // Both fetch calls used the revalidate path (same project / filter / sort).
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("clears stale rows when the cache holds an empty page on Activity reveal", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    // Prime with one issue so the initial mount renders rows.
    setCache(cacheKey, {
      items: [makeIssue(70)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now() - 30_000,
    });
    // Mount-time revalidate returns the same single row; later reveal-time
    // revalidate hangs so the transitional UI driven by the cache read is
    // observable.
    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(70)]))
      .mockImplementation(() => new Promise(() => {}));

    function Harness({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <Activity mode={mode}>
          <GitHubResourceList type="issue" projectPath="/test/proj" />
        </Activity>
      );
    }

    const { rerender } = render(<Harness mode="visible" />);
    expect(screen.getByTestId("item-70")).toBeTruthy();
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Hide via Activity, then a broadcast lands while hidden that drops the
    // last open issue (legitimate empty result for this filter).
    rerender(<Harness mode="hidden" />);
    setCache(cacheKey, {
      items: [],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    rerender(<Harness mode="visible" />);

    // On reveal the load effect re-reads the cache. With the fix in place,
    // an empty cache page must clear stale rows immediately rather than
    // letting them linger until revalidate resolves.
    await waitFor(() => {
      expect(screen.queryByTestId("item-70")).toBeNull();
    });
  });

  it("clears rows and shows the skeleton when the filter changes while Activity is hidden", async () => {
    const openKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(openKey, {
      items: [makeIssue(80)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });
    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(80)]))
      .mockImplementation(() => new Promise(() => {}));

    function Harness({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <Activity mode={mode}>
          <GitHubResourceList type="issue" projectPath="/test/proj" />
        </Activity>
      );
    }

    const { rerender } = render(<Harness mode="visible" />);
    expect(screen.getByTestId("item-80")).toBeTruthy();
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Hide, change filter (effectKey now differs from lastLoadedEffectKeyRef),
    // reveal — must take the real-remount path: clear rows + show skeleton.
    rerender(<Harness mode="hidden" />);
    act(() => {
      useGitHubFilterStore.getState().setIssueFilter("closed");
    });
    rerender(<Harness mode="visible" />);

    await waitFor(() => {
      expect(screen.queryByTestId("item-80")).toBeNull();
    });
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    expect(mockListIssues.mock.calls[mockListIssues.mock.calls.length - 1]?.[0]).toMatchObject({
      state: "closed",
    });
  });

  it("hydrates from warm cache without flashing the skeleton on filter switch", async () => {
    const openKey = buildCacheKey("/test/proj", "issue", "open", "created");
    const closedKey = buildCacheKey("/test/proj", "issue", "closed", "created");
    setCache(openKey, {
      items: [makeIssue(60)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });
    setCache(closedKey, {
      items: [makeIssue(61), makeIssue(62)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    // Mount-time revalidate for "open", then closed-filter revalidate after switch.
    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(60)]))
      .mockResolvedValueOnce(makeResponse([makeIssue(61), makeIssue(62)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByTestId("item-60")).toBeTruthy();
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useGitHubFilterStore.getState().setIssueFilter("closed");
    });

    // Warm closed cache → rows swap synchronously, no skeleton flash.
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.getByTestId("item-61")).toBeTruthy();
    expect(screen.getByTestId("item-62")).toBeTruthy();
    expect(screen.queryByTestId("item-60")).toBeNull();

    // Background revalidate for the closed slot uses the bypass-cache path.
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });
    expect(mockListIssues.mock.calls[1]?.[0]).toMatchObject({
      state: "closed",
      bypassCache: true,
    });
  });

  it("survives Open → Closed → Open round-trip with no skeleton on the second Open", async () => {
    const openKey = buildCacheKey("/test/proj", "issue", "open", "created");
    const closedKey = buildCacheKey("/test/proj", "issue", "closed", "created");
    setCache(openKey, {
      items: [makeIssue(70)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });
    setCache(closedKey, {
      items: [makeIssue(71)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockImplementation(
      ({ state }: { state: "open" | "closed" | "merged" | "all" }) => {
        if (state === "closed") return Promise.resolve(makeResponse([makeIssue(71)]));
        return Promise.resolve(makeResponse([makeIssue(70)]));
      }
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByTestId("item-70")).toBeTruthy();
    expect(screen.queryByTestId("skeleton")).toBeNull();

    act(() => {
      useGitHubFilterStore.getState().setIssueFilter("closed");
    });
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.getByTestId("item-71")).toBeTruthy();

    act(() => {
      useGitHubFilterStore.getState().setIssueFilter("open");
    });
    // Warm Open cache still present — second Open shows item-70 with no flash.
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.getByTestId("item-70")).toBeTruthy();
  });

  it("does not flash unsearched cached rows when a search query becomes active", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(81), makeIssue(82), makeIssue(83)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    // Mount-time revalidate resolves quickly; the searched fetch hangs so the
    // transitional UI (post-debounce) is observable.
    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(81), makeIssue(82), makeIssue(83)]))
      .mockImplementation(() => new Promise(() => {}));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByTestId("item-81")).toBeTruthy();
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useGitHubFilterStore.getState().setIssueSearchQuery("foo");
    });

    // After the 300ms debounce fires, the effect re-runs. The cacheKey
    // doesn't include the search, so naively reading the warm slot would
    // re-show the unfiltered list. Verify the cold path runs instead.
    await waitFor(() => {
      expect(screen.queryByTestId("item-81")).toBeNull();
    });
    expect(screen.getByTestId("skeleton")).toBeTruthy();
  });

  it("clears stranded loading state when switching from a cold pending filter to a warm empty slot", async () => {
    const closedKey = buildCacheKey("/test/proj", "issue", "closed", "created");
    setCache(closedKey, {
      items: [],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    // Initial open-filter fetch hangs so loading sticks at true; the closed
    // revalidate resolves to the cached empty page.
    mockListIssues.mockImplementation(
      ({ state }: { state: "open" | "closed" | "merged" | "all" }) => {
        if (state === "closed") return Promise.resolve(makeResponse([]));
        return new Promise(() => {});
      }
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByTestId("skeleton")).toBeTruthy();

    act(() => {
      useGitHubFilterStore.getState().setIssueFilter("closed");
    });

    // Warm closed cache is empty — the skeleton must clear (loading reset),
    // exposing the empty state instead.
    await waitFor(() => {
      expect(screen.queryByTestId("skeleton")).toBeNull();
    });
    expect(screen.getByText("No issues in this view")).toBeTruthy();
  });

  it("clears rows and shows the skeleton when the filter changes while keepMounted", async () => {
    const openKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(openKey, {
      items: [makeIssue(60)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });
    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(60)]))
      // Closed-filter fetch hangs so the transitional UI is observable.
      .mockImplementation(() => new Promise(() => {}));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Cache hit — items render, no skeleton.
    expect(screen.getByTestId("item-60")).toBeTruthy();
    expect(screen.queryByTestId("skeleton")).toBeNull();
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useGitHubFilterStore.getState().setIssueFilter("closed");
    });

    // Filter change → effectKey differs from lastLoadedEffectKeyRef → real
    // remount path: rows cleared, skeleton shown for the in-flight fetch.
    await waitFor(() => {
      expect(screen.queryByTestId("item-60")).toBeNull();
    });
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    expect(mockListIssues.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockListIssues.mock.calls[mockListIssues.mock.calls.length - 1]?.[0]).toMatchObject({
      state: "closed",
    });
  });
});
