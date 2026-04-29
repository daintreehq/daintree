/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { GitHubIssue, GitHubListResponse } from "@shared/types/github";
import { setCache, buildCacheKey, _resetForTests } from "@/lib/githubResourceCache";
import { useGitHubFilterStore } from "@/store/githubFilterStore";

const mockListIssues = vi.fn<() => Promise<GitHubListResponse<GitHubIssue>>>();
const mockListPRs = vi.fn();
const mockGetIssueByNumber = vi.fn();
const mockGetPRByNumber = vi.fn();

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    listIssues: (...args: unknown[]) => mockListIssues(...(args as [])),
    listPullRequests: (...args: unknown[]) => mockListPRs(...(args as [])),
    getIssueByNumber: (...args: unknown[]) => mockGetIssueByNumber(...(args as [])),
    getPRByNumber: (...args: unknown[]) => mockGetPRByNumber(...(args as [])),
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
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

const { formatTimeAgoMock } = vi.hoisted(() => ({
  formatTimeAgoMock: vi.fn<(value: number | string) => string>(() => "1m ago"),
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: formatTimeAgoMock,
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
  formatTimeAgoMock.mockClear();
  formatTimeAgoMock.mockImplementation(() => "1m ago");
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
    expect(screen.getByText(/Updated 1m ago/)).toBeTruthy();
    // The label must reflect the cached timestamp, not Date.now() of the failure.
    expect(formatTimeAgoMock).toHaveBeenCalledWith(seededTimestamp);
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
    expect(screen.getByText(/Updated 1m ago/)).toBeTruthy();

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
