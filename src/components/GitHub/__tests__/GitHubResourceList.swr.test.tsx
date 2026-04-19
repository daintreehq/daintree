/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { GitHubIssue, GitHubListResponse } from "@shared/types/github";
import { setCache, buildCacheKey, _resetForTests } from "@/lib/githubResourceCache";

const mockListIssues = vi.fn<() => Promise<GitHubListResponse<GitHubIssue>>>();
const mockListPRs = vi.fn();

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    listIssues: (...args: unknown[]) => mockListIssues(...(args as [])),
    listPullRequests: (...args: unknown[]) => mockListPRs(...(args as [])),
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

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: () => "1m ago",
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
    setCache(cacheKey, {
      items: [makeIssue(20)],
      endCursor: null,
      hasNextPage: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockRejectedValue(new Error("Network error"));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Cached data shown immediately
    expect(screen.getByTestId("item-20")).toBeTruthy();

    // After error, data persists and error banner appears
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeTruthy();
    });
    expect(screen.getByTestId("item-20")).toBeTruthy();
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
