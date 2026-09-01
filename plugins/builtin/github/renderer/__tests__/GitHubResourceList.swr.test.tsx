/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import React, { Activity, type ReactNode } from "react";
import type { Issue, ListOptions, Page } from "@shared/types/forge";
import { setCache, getCache, buildCacheKey, _resetForTests } from "@/lib/forgeResourceCache";
import { MULTI_FETCH_CAP } from "@/lib/parseNumberQuery";
import { useGitHubFilterStore } from "../stores/githubFilterStore";
import { useIssueSelectionStore } from "@/store/issueSelectionStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import { useSystemWakeStore } from "@/store/systemWakeStore";
import { FixedDropdownVisibleContext } from "@/components/ui/fixed-dropdown";

// The header's refresh control is a real tooltip trigger now (it carries the
// list's freshness). The shared `Tooltip` lazy-loads its Radix primitives, so
// an unmocked provider swaps component types mid-test and remounts the subtree
// under it — same flattening mock GitHubListItem's suite uses.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const mockListIssues = vi.fn();
const mockListPRs = vi.fn();
const mockGetIssueByNumber = vi.fn();
const mockGetPRByNumber = vi.fn();
const mockGetIssuesByNumbers = vi.fn();
const mockGetPRsByNumbers = vi.fn();

// The shim merges `cwd` into the options object so assertions can keep
// matching a single flat shape.
vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    listIssues: (cwd: string, opts?: ListOptions) => mockListIssues({ cwd, ...opts }),
    listPRs: (cwd: string, opts?: ListOptions) => mockListPRs({ cwd, ...opts }),
    getIssue: (cwd: string, issueNumber: number) => mockGetIssueByNumber(cwd, issueNumber),
    getPR: (cwd: string, prNumber: number) => mockGetPRByNumber(cwd, prNumber),
    getIssueUrl: vi.fn().mockResolvedValue("https://github.com/acme/repo/issues/1"),
    getIssuesByNumbers: (cwd: string, numbers: number[]) => mockGetIssuesByNumbers(cwd, numbers),
    getPRsByNumbers: (cwd: string, numbers: number[]) => mockGetPRsByNumbers(cwd, numbers),
  },
}));

let mockGitHubConfig: { hasToken: boolean } | null = { hasToken: true };
let mockGitHubConfigInitialized = true;
const initializeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../stores/githubConfigStore", () => {
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

const notifyMock = vi.fn();

vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

let mockIsSelectionActive = false;
const mockSelectionClear = vi.fn();
// Stable identities — the component memoizes and effects off these.
const EMPTY_ITEMS = new Map();
const mockReconcile = vi.fn();

vi.mock("@/hooks/useIssueSelection", () => ({
  useIssueSelection: () => ({
    selectedIds: new Set<number>(),
    get isSelectionActive() {
      return mockIsSelectionActive;
    },
    selectedItems: EMPTY_ITEMS,
    toggle: vi.fn(),
    toggleRange: vi.fn(),
    selectAll: vi.fn(),
    reconcile: mockReconcile,
    clear: mockSelectionClear,
  }),
}));

// Stable identities, so a test can assert which one the Enter path reached.
// Fresh `vi.fn()`s per selector call recorded nothing anything could read.
const mockOpenCreateDialog = vi.fn();
const mockOpenCreateDialogForPR = vi.fn();
const mockSelectWorktree = vi.fn();

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: vi.fn((sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      openCreateDialog: mockOpenCreateDialog,
      openCreateDialogForPR: mockOpenCreateDialogForPR,
      selectWorktree: mockSelectWorktree,
    })
  ),
}));

// The list resolves every row's worktree once and hands it down, so this is
// the seam that decides what the rows are told.
const worktreeMap = new Map<string, { id: string; issueNumber?: number; prNumber?: number }>();

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: (selector: (s: { worktrees: unknown }) => unknown) =>
    selector({ worktrees: worktreeMap }),
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

/** What the list passed each row, keyed by resource number. */
const rowProps = new Map<number, { worktreeId?: string; timeField?: string }>();

vi.mock("../components/GitHubListItem", () => ({
  GitHubListItem: ({
    item,
    worktree,
    timeField,
  }: {
    item: Issue;
    worktree?: { id: string };
    timeField?: string;
  }) => {
    rowProps.set(item.number, { worktreeId: worktree?.id, timeField });
    return <div data-testid={`item-${item.number}`}>{item.title}</div>;
  },
}));

vi.mock("../components/BulkActionBar", () => ({
  BulkActionBar: () => null,
}));

const mockAnimate = vi.fn();

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useAnimate: () => [{ current: null } as unknown as React.RefObject<HTMLElement>, mockAnimate],
    useReducedMotion: () => false,
  };
});

vi.mock("../components/GitHubDropdownSkeletons", () => ({
  GitHubResourceRowsSkeleton: () => <div data-testid="skeleton">Loading...</div>,
  MAX_SKELETON_ITEMS: 6,
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

import { GitHubResourceList } from "../components/GitHubResourceList";

const makeIssue = (n: number): Issue => ({
  number: n,
  title: `Issue #${n}`,
  body: "",
  url: `https://github.com/test/repo/issues/${n}`,
  state: "open",
  rawState: "OPEN",
  updatedAt: 0,
  createdAt: 0,
  author: { login: "user", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 0,
  rawData: null,
});

const makeResponse = (items: Issue[], totalCount?: number): Page<Issue> => ({
  items,
  nextCursor: null,
  hasMore: false,
  ...(totalCount === undefined ? {} : { totalCount }),
});

const setRateLimit = (
  blocked: boolean,
  kind: "primary" | "secondary" | null,
  resetAt: number | null
) => {
  useForgeProviderHealthStore.getState().applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
    blocked,
    kind,
    resetAt,
  });
};

beforeEach(() => {
  _resetForTests();
  mockListIssues.mockReset();
  mockListPRs.mockReset();
  mockGetIssueByNumber.mockReset();
  mockGetPRByNumber.mockReset();
  // Reset drops the default, and the hook calls `.filter` straight on the
  // result — leave every batch lookup resolving to an empty array.
  mockGetIssuesByNumbers.mockReset().mockResolvedValue([]);
  mockGetPRsByNumbers.mockReset().mockResolvedValue([]);
  LiveTimeAgoMock.mockClear();
  dispatchMock.mockReset();
  notifyMock.mockReset();
  initializeMock.mockClear();
  mockSelectionClear.mockReset();
  mockOpenCreateDialog.mockReset();
  mockOpenCreateDialogForPR.mockReset();
  mockSelectWorktree.mockReset();
  useIssueSelectionStore.setState({ selections: new Map() });
  setRateLimit(false, null, null);
  mockIsSelectionActive = false;
  mockGitHubConfig = { hasToken: true };
  mockGitHubConfigInitialized = true;
  const filterStore = useGitHubFilterStore.getState();
  filterStore.setIssueSearchQuery("");
  filterStore.setPrSearchQuery("");
  filterStore.setIssueFilter("open");
  filterStore.setPrFilter("open");
  filterStore.setIssueSortOrder("created");
  filterStore.setPrSortOrder("created");
  worktreeMap.clear();
  rowProps.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("open-time fetch policy (count-as-cache-buster, #10122 family)", () => {
  const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");

  it("skips the mount revalidate when the entry was written by a bypass fetch <10s ago", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
      freshBypassAt: Date.now(),
      countAtWrite: 1,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByTestId("item-10")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("stale wins over the skip window — a count delta after a hover prefetch still bypasses", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
      freshBypassAt: Date.now(),
      countAtWrite: 1,
      stale: true,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => expect(mockListIssues).toHaveBeenCalled());
    expect(mockListIssues).toHaveBeenCalledWith(expect.objectContaining({ bypassCache: true }));
  });

  it("a fresh `timestamp` alone does NOT skip — broadcast-seeded entries still revalidate", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => expect(mockListIssues).toHaveBeenCalled());
  });

  it("downgrades the issues revalidate to bypassCache:false while the count fingerprint holds", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10), makeIssue(11)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now() - 30_000,
      countAtWrite: 2,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10), makeIssue(11)], 2));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => expect(mockListIssues).toHaveBeenCalled());
    expect(mockListIssues).toHaveBeenCalledWith(expect.objectContaining({ bypassCache: false }));
  });

  it("keeps bypassCache:true when the count buster marked the entry stale", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now() - 30_000,
      countAtWrite: 2,
      stale: true,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => expect(mockListIssues).toHaveBeenCalled());
    expect(mockListIssues).toHaveBeenCalledWith(expect.objectContaining({ bypassCache: true }));
  });

  it("keeps bypassCache:true for entries with no count fingerprint (disk hydration, old writers)", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now() - 30_000,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => expect(mockListIssues).toHaveBeenCalled());
    expect(mockListIssues).toHaveBeenCalledWith(expect.objectContaining({ bypassCache: true }));
  });

  it("the PR list never downgrades — CI rollup flips are invisible to the count signal", async () => {
    const prKey = buildCacheKey("/test/proj", "pr", "open", "created");
    setCache(prKey, {
      items: [makeIssue(40)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now() - 30_000,
      countAtWrite: 1,
    });
    mockListPRs.mockResolvedValue(makeResponse([makeIssue(40)]));

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    await waitFor(() => expect(mockListPRs).toHaveBeenCalled());
    expect(mockListPRs).toHaveBeenCalledWith(expect.objectContaining({ bypassCache: true }));
  });

  it("manual refresh still bypasses even when the entry is inside the skip window", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
      freshBypassAt: Date.now(),
      countAtWrite: 1,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mockListIssues).not.toHaveBeenCalled();

    screen.getByRole("button", { name: /refresh issues/i }).click();

    await waitFor(() => expect(mockListIssues).toHaveBeenCalled());
    expect(mockListIssues).toHaveBeenCalledWith(expect.objectContaining({ bypassCache: true }));
  });

  it("does not fire onFreshFetch for a downgraded (non-bypass) revalidate", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now() - 30_000,
      countAtWrite: 1,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)], 1));
    const onFreshFetch = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onFreshFetch={onFreshFetch} />
    );

    await waitFor(() => expect(mockListIssues).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onFreshFetch).not.toHaveBeenCalled();
  });

  it("fires onFreshFetch when the revalidate actually bypassed", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now() - 30_000,
      countAtWrite: 1,
      stale: true,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)], 1));
    const onFreshFetch = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onFreshFetch={onFreshFetch} />
    );

    await waitFor(() => expect(onFreshFetch).toHaveBeenCalled());
  });

  it("a downgraded revalidate re-stamps the count fingerprint from the response", async () => {
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now() - 30_000,
      countAtWrite: 1,
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10), makeIssue(11)], 2));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => expect(screen.getByTestId("item-11")).toBeTruthy());
    const entry = (await import("@/lib/forgeResourceCache")).getCache(cacheKey);
    expect(entry?.countAtWrite).toBe(2);
    // Non-bypass responses may come from the backend cache — they must not
    // arm the skip-revalidate gate.
    expect(entry?.freshBypassAt).toBeUndefined();
  });
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
    // Freshness stays off the surface while the data is fresh — the retry just
    // landed, so there is nothing for the footer to warn about.
    expect(screen.queryByText(/^Updated/)).toBeNull();
  });

  it("does not bleed stale timestamp across filter changes", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(50)],
      nextCursor: null,
      hasMore: false,
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
      nextCursor: "cursor-1",
      hasMore: true,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue({
      items: [makeIssue(1), makeIssue(2)],
      nextCursor: "cursor-1",
      hasMore: true,
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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

  it("calls onCountUpdate with the loaded length and hasMore on a cold-mount fetch (issue #9693)", async () => {
    // No cache — cold mount. The badge must bind to what the list loads, not
    // the stats query's totalCount, so onCountUpdate fires even though this is
    // not a revalidation (unlike onFreshFetch).
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1), makeIssue(2)]));
    const onCountUpdate = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onCountUpdate={onCountUpdate} />
    );

    await waitFor(() => {
      expect(onCountUpdate).toHaveBeenCalledWith(2, false);
    });
    // Cold mount is the bypassCache:false path — onFreshFetch would skip here,
    // but onCountUpdate must still fire.
    expect(mockListIssues.mock.calls[0]?.[0]?.bypassCache).toBe(false);
  });

  it("falls back to loaded length + hasMore via onCountUpdate when no totalCount is present", async () => {
    // No server totalCount (e.g. search/cache path): the badge approximates
    // with the loaded length and the real hasNextPage flag, yielding "2+".
    mockListIssues.mockResolvedValue({
      items: [makeIssue(1), makeIssue(2)],
      nextCursor: "cursor-1",
      hasMore: true,
    });
    const onCountUpdate = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onCountUpdate={onCountUpdate} />
    );

    await waitFor(() => {
      expect(onCountUpdate).toHaveBeenCalledWith(2, true);
    });
  });

  it("reports the server totalCount as an exact count via onCountUpdate when paginated (issue #9717)", async () => {
    // First page is capped at 20 with more pages, but the GraphQL response
    // carries the real open total. The badge must show that total exactly,
    // not "20+": the count is the totalCount and the approximate flag is false
    // even though hasNextPage is true.
    const items = Array.from({ length: 20 }, (_, i) => makeIssue(i + 1));
    mockListIssues.mockResolvedValue({
      items,
      nextCursor: "cursor-1",
      hasMore: true,
      totalCount: 47,
    });
    const onCountUpdate = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onCountUpdate={onCountUpdate} />
    );

    await waitFor(() => {
      expect(onCountUpdate).toHaveBeenCalled();
    });
    const [count, isApproximate] = onCountUpdate.mock.calls.at(-1) ?? [];
    // totalCount is preferred over the loaded length (20)...
    expect(count).toBe(47);
    expect(count).not.toBe(items.length);
    // ...and the count is exact, so the badge drops the "+" suffix.
    expect(isApproximate).toBe(false);
  });

  it("treats a server totalCount of 0 as authoritative via onCountUpdate", async () => {
    // `?? items.length` (not `|| items.length`) must keep a real zero total.
    mockListIssues.mockResolvedValue(makeResponse([], 0));
    const onCountUpdate = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onCountUpdate={onCountUpdate} />
    );

    await waitFor(() => {
      expect(onCountUpdate).toHaveBeenCalledWith(0, false);
    });
  });

  it("reports the server totalCount exactly for PR lists too (issue #9717)", async () => {
    const prs = Array.from({ length: 20 }, (_, i) => ({
      ...makeIssue(i + 1),
      isDraft: false,
      ciStatus: "SUCCESS" as const,
    }));
    mockListPRs.mockResolvedValue({
      items: prs,
      nextCursor: "cursor-1",
      hasMore: true,
      totalCount: 61,
    });
    const onCountUpdate = vi.fn();

    render(<GitHubResourceList type="pr" projectPath="/test/proj" onCountUpdate={onCountUpdate} />);

    await waitFor(() => {
      expect(onCountUpdate).toHaveBeenCalled();
    });
    const [count, isApproximate] = onCountUpdate.mock.calls.at(-1) ?? [];
    expect(count).toBe(61);
    expect(count).not.toBe(prs.length);
    expect(isApproximate).toBe(false);
  });

  it("calls onCountUpdate again after a successful background revalidation", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    // Revalidation lands a larger page — the badge must converge to it.
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10), makeIssue(11)]));
    const onCountUpdate = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onCountUpdate={onCountUpdate} />
    );

    await waitFor(() => {
      expect(onCountUpdate).toHaveBeenCalledWith(2, false);
    });
    expect(mockListIssues.mock.calls[0]?.[0]?.bypassCache).toBe(true);
  });

  it("does not call onCountUpdate when loading more (append) pages", async () => {
    mockListIssues.mockResolvedValueOnce({
      items: [makeIssue(1), makeIssue(2)],
      nextCursor: "cursor-1",
      hasMore: true,
    });
    const onCountUpdate = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onCountUpdate={onCountUpdate} />
    );

    await waitFor(() => {
      expect(onCountUpdate).toHaveBeenCalledTimes(1);
    });

    // Second page (append) — must not move the badge count.
    mockListIssues.mockResolvedValueOnce({
      items: [makeIssue(3), makeIssue(4)],
      nextCursor: null,
      hasMore: false,
    });
    const loadMore = await screen.findByRole("button", { name: /load more/i });
    act(() => {
      loadMore.click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("item-3")).toBeTruthy();
    });
    // Still exactly one onCountUpdate call — the append fetch is gated out.
    expect(onCountUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not poison the badge count when the dropdown filter switches away from open", async () => {
    // The badge shows the OPEN count. Switching the dropdown to Closed must
    // not overwrite it with the closed count (the hook stays mounted across
    // filter tabs).
    mockListIssues.mockResolvedValueOnce(makeResponse([makeIssue(1), makeIssue(2)]));
    const onCountUpdate = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onCountUpdate={onCountUpdate} />
    );

    await waitFor(() => {
      expect(onCountUpdate).toHaveBeenCalledWith(2, false);
    });
    onCountUpdate.mockClear();

    // Switch to the "closed" tab — a fresh first-page fetch fires for the
    // closed filter key, carrying the closed totalCount. It must NOT report
    // into the open-count badge (the open gate, not the count source, is the
    // defense).
    mockListIssues.mockResolvedValue(
      makeResponse([makeIssue(3), makeIssue(4), makeIssue(5), makeIssue(6)], 500)
    );
    act(() => {
      useGitHubFilterStore.getState().setIssueFilter("closed");
    });

    await waitFor(() => {
      expect(screen.getByTestId("item-3")).toBeTruthy();
    });
    expect(onCountUpdate).not.toHaveBeenCalled();
  });

  it("does not call onCountUpdate for search-filtered fetches", async () => {
    useGitHubFilterStore.getState().setIssueSearchQuery("needle");
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));
    const onCountUpdate = vi.fn();

    render(
      <GitHubResourceList type="issue" projectPath="/test/proj" onCountUpdate={onCountUpdate} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("item-1")).toBeTruthy();
    });
    // Search results aren't cached and must not drive the badge count, which
    // tracks the unfiltered list.
    expect(onCountUpdate).not.toHaveBeenCalled();
  });

  it("different project paths use separate cache entries", async () => {
    const keyA = buildCacheKey("/proj-a", "issue", "open", "created");
    setCache(keyA, {
      items: [makeIssue(50)],
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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

  it("does not revalidate on visibilitychange (consolidated onto wake-coordinator in #8066)", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // visibilitychange must NOT trigger a refetch after migration — sleep-wake
    // is dispatched through `useSystemWakeStore.wakeEpoch` (separate test).
    await vi.advanceTimersByTimeAsync(31_000);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockListIssues).toHaveBeenCalledTimes(1);
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
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    mockListPRs
      .mockResolvedValueOnce({
        items: [stalePR],
        nextCursor: null,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        items: [updatedPR],
        nextCursor: null,
        hasMore: false,
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

  it("removes the focus listener on unmount", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
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
    await vi.advanceTimersByTimeAsync(0);

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate on focus when the keepMounted dropdown body is hidden (#10125)", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    const { rerender } = render(
      <FixedDropdownVisibleContext.Provider value={false}>
        <GitHubResourceList type="issue" projectPath="/test/proj" />
      </FixedDropdownVisibleContext.Provider>
    );

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Advance past the 30s revalidation throttle.
    await vi.advanceTimersByTimeAsync(31_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    // Focus while the dropdown body is hidden must NOT trigger a revalidate.
    expect(mockListIssues).toHaveBeenCalledTimes(1);

    // Reopening the dropdown (visibility flip) must also not replay a hidden
    // focus — the listener is gated on the latest context value, not
    // buffered, so the gating carries through.
    await act(async () => {
      rerender(
        <FixedDropdownVisibleContext.Provider value={true}>
          <GitHubResourceList type="issue" projectPath="/test/proj" />
        </FixedDropdownVisibleContext.Provider>
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubResourceList wake-coordinator revalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useSystemWakeStore.setState({
      wakeEpoch: 0,
      lastSleepDuration: 0,
      isWakeRevalidating: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("revalidates when wakeEpoch bumps, bypassing the focus throttle window", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(1)]))
      .mockResolvedValueOnce(makeResponse([makeIssue(1), makeIssue(4)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // No timer advance — the wake path must NOT respect the 30s throttle.
    await act(async () => {
      useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
    });

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("item-4")).toBeTruthy();
    });
  });

  it("does not revalidate when wakeEpoch is unchanged from the mount value", async () => {
    // A previous wake landed before this list mounts — the consumer must NOT
    // retroactively refetch on mount.
    useSystemWakeStore.setState({
      wakeEpoch: 4,
      lastSleepDuration: 0,
      isWakeRevalidating: false,
    });

    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("consumes the epoch even when a numeric search is active so a later search-clear doesn't replay it", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));
    mockGetIssueByNumber.mockResolvedValue(makeIssue(42));

    // Enter a numeric search before the wake fires.
    useGitHubFilterStore.getState().setIssueSearchQuery("#42");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // The numeric-query effect fires getByNumber, not listIssues.
    await waitFor(() => {
      expect(mockGetIssueByNumber).toHaveBeenCalledTimes(1);
    });
    expect(mockListIssues).toHaveBeenCalledTimes(0);

    // Wake while the numeric search is still active.
    await act(async () => {
      useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
    });

    // The numeric path does not re-fetch the list, so listIssues stays at 0.
    expect(mockListIssues).toHaveBeenCalledTimes(0);

    // User clears the search. The wake should have been consumed by the wake
    // effect already, so clearing must not replay it as an extra list call.
    // The only listIssues call after clearing is the natural mount-style
    // revalidate driven by the list-query effect.
    await act(async () => {
      useGitHubFilterStore.getState().setIssueSearchQuery("");
    });

    // Advance past debounce.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    // The list-query effect re-runs twice on search-clear (numberQuery flip,
    // then debouncedSearch flip after the debounce timer) — both calls are
    // pre-existing behavior. The wake epoch must NOT add a third call: the
    // consume-during-numeric-search fix guarantees the stale wake doesn't
    // replay when numberQuery transitions back to null. waitFor on the exact
    // count so CI doesn't race the second effect flush.
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });
  });

  it("consumes the wake epoch even when the dropdown body is hidden so a later open doesn't replay it (#10125)", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    mockListIssues
      .mockResolvedValueOnce(makeResponse([makeIssue(1)]))
      .mockResolvedValueOnce(makeResponse([makeIssue(1), makeIssue(5)]));

    // Mount with the dropdown body hidden.
    const { rerender } = render(
      <FixedDropdownVisibleContext.Provider value={false}>
        <GitHubResourceList type="issue" projectPath="/test/proj" />
      </FixedDropdownVisibleContext.Provider>
    );

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Wake fires while hidden — must NOT refetch.
    await act(async () => {
      useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
    });
    expect(mockListIssues).toHaveBeenCalledTimes(1);

    // Reopen (now visible). The visibility flip alone must NOT trigger a
    // fetch — guards against a regression where the wake-effect dep array
    // loses `dropdownVisible` and the flip itself behaves like a wake.
    await act(async () => {
      rerender(
        <FixedDropdownVisibleContext.Provider value={true}>
          <GitHubResourceList type="issue" projectPath="/test/proj" />
        </FixedDropdownVisibleContext.Provider>
      );
    });
    expect(mockListIssues).toHaveBeenCalledTimes(1);

    // Bump wake again. If the hidden wake had NOT been consumed, the wake
    // effect's next run would see the new wakeEpoch plus a stale ref and
    // refetch on top of the visibility-flip fetch (total 2 from this phase
    // + initial 1 = 3). Consumed means the ref is already at the latest
    // epoch — this fresh wake is the only thing that fetches.
    await act(async () => {
      useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
    });

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });
  });

  it("clears the refreshing spinner when a wake revalidation is interrupted by a numeric search", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    // Mount-time revalidate resolves immediately. Wake revalidate hangs so we
    // can observe the `refreshing` flag set, then get aborted by the search.
    let resolveWakeRevalidate: ((value: Page<Issue>) => void) | undefined;
    mockListIssues.mockResolvedValueOnce(makeResponse([makeIssue(1)])).mockImplementationOnce(
      () =>
        new Promise<Page<Issue>>((resolve) => {
          resolveWakeRevalidate = resolve;
        })
    );
    mockGetIssueByNumber.mockResolvedValue(makeIssue(42));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Trigger wake revalidation — `refreshing` flips true while the request
    // hangs.
    await act(async () => {
      useSystemWakeStore.setState((s) => ({ wakeEpoch: s.wakeEpoch + 1 }));
    });

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });

    // User types a `#`-prefixed search before the wake revalidate resolves.
    await act(async () => {
      useGitHubFilterStore.getState().setIssueSearchQuery("#42");
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(mockGetIssueByNumber).toHaveBeenCalled();
    });

    // Now resolve the aborted wake revalidate. Without the fix, fetchData's
    // finally block would skip `setRefreshing(false)` because the signal is
    // aborted, leaking `refreshing=true` indefinitely. With the fix, the
    // numeric-query effect's setup block has already cleared it. We can't
    // observe `refreshing` directly through DOM here, but we can assert no
    // additional listIssues fires after the numeric path takes over.
    await act(async () => {
      resolveWakeRevalidate?.(makeResponse([makeIssue(1), makeIssue(99)]));
      await Promise.resolve();
    });

    // The aborted revalidate's response is dropped (signal aborted in
    // fetchData), so no extra rows are appended and listIssues count stays at
    // 2 (mount + wake).
    expect(mockListIssues).toHaveBeenCalledTimes(2);
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
      { tab: "code-forge", subtab: "github", sectionId: "github-token" },
      { source: "user" }
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe("GitHubResourceList empty state branching", () => {
  it("renders zero-data with a create CTA (no clear action) when nothing is filtered and the list is empty", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("No open issues")).toBeTruthy();
    });
    // Nothing is narrowing the view, so the way out is creating the first item,
    // not undoing a filter that was never applied.
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
    expect(screen.getByRole("button", { name: /new issue/i })).toBeTruthy();
  });

  it("renders filtered-empty with a Clear search action when only a search query is active", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setIssueSearchQuery("nonexistent");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/No matches for "nonexistent"/)).toBeTruthy();
    });
    // The state tab is still the default, so the action names only what it
    // actually undoes.
    // The search field's X carries the same accessible name, so pick the one
    // whose label is its own text content.
    const clearButton = screen
      .getAllByRole("button", { name: "Clear search" })
      .find((b) => b.textContent === "Clear search");
    expect(clearButton).toBeTruthy();
    // CLAUDE.md popover/palette empty-state rule: never render primary-weight
    // buttons. The Clear filters CTA must use the ghost variant — locking the
    // class signature catches a regression to outline (ring-border-strong) or
    // any other heavier variant.
    expect(clearButton!.className).toContain("text-text-secondary");
    expect(clearButton!.className).not.toContain("ring-border-strong");
  });

  it("routes an empty non-default state tab back to the tab that has data", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setIssueFilter("closed");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("No closed issues")).toBeTruthy();
    });
    const showOpen = screen.getByRole("button", { name: /show open issues/i });
    act(() => {
      showOpen.click();
    });
    expect(useGitHubFilterStore.getState().issueFilter).toBe("open");
  });

  it("resets both search and state filter when both are narrowing the view", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setIssueSearchQuery("foo");
    useGitHubFilterStore.getState().setIssueFilter("closed");

    // Both narrow, so the one action covers both — and says so.
    const clearButton = await (async () => {
      render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
      return screen.findByRole("button", { name: "Clear search and filters" });
    })();
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
      expect(screen.getByText(/No issue #999 in this view/)).toBeTruthy();
    });
    expect(
      screen
        .getAllByRole("button", { name: "Clear search" })
        .some((b) => b.textContent === "Clear search")
    ).toBe(true);
  });

  it("renders filtered-empty for PRs with the right resource label", async () => {
    mockListPRs.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setPrSearchQuery("nonexistent");

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/No matches for "nonexistent"/)).toBeTruthy();
    });
  });

  it("renders zero-data for PRs when no filters are active and the list is empty", async () => {
    mockListPRs.mockResolvedValue(makeResponse([]));

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("No open pull requests")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
    expect(screen.getByRole("button", { name: /new pull request/i })).toBeTruthy();
  });

  it("Clear filters action on PR view resets PR-specific store slice, not issue slice", async () => {
    mockListPRs.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setPrSearchQuery("foo");
    useGitHubFilterStore.getState().setPrFilter("merged");
    useGitHubFilterStore.getState().setIssueSearchQuery("untouched-issue-query");

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    const clearButton = await screen.findByRole("button", { name: "Clear search and filters" });
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
    let resolveSecond: (v: Page<Issue>) => void = () => {};
    mockListIssues
      .mockRejectedValueOnce(new Error("Cannot reach GitHub. Check your internet connection."))
      .mockImplementationOnce(
        () =>
          new Promise<Page<Issue>>((resolve) => {
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

  it("does not retry rate-limit errors and surfaces the paused empty state", async () => {
    mockListIssues.mockRejectedValue(
      new Error("GitHub rate limit exceeded. Try again in a few minutes.")
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Raw IPC message is suppressed; the dropdown shows the paused empty state
    // sourced from the new rate-limit signal instead of the noisy error string.
    await waitFor(() => {
      expect(screen.getByText(/GitHub requests are paused/)).toBeTruthy();
    });
    expect(screen.queryByText(/rate limit exceeded\./)).toBeNull();

    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("skips fetches entirely when the rate-limit store reports blocked", async () => {
    setRateLimit(true, "primary", Date.now() + 60_000);
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/GitHub requests are paused/)).toBeTruthy();
    });
    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("clears the sticky paused state once the rate-limit store unblocks", async () => {
    // Reproduces the race window: a fetch fails with a rate-limit error
    // (catch path sets the sticky flag), the push arrives blocking the
    // store, then the block later clears. The sticky flag MUST auto-clear
    // when `rateLimitBlocked` returns to false — otherwise the dropdown
    // would stay paused forever despite the empty-state copy promising
    // automatic resume.
    mockListIssues.mockRejectedValueOnce(
      new Error("GitHub rate limit exceeded. Try again in a few minutes.")
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/GitHub requests are paused/)).toBeTruthy();
    });

    // Push arrives, confirming the block at the store level.
    act(() => {
      setRateLimit(true, "primary", Date.now() + 60_000);
    });
    expect(screen.getByText(/GitHub requests are paused/)).toBeTruthy();

    // Quota resets — push arrives clearing the block. Sticky flag must
    // auto-clear so `isRateLimited` returns to false.
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));
    act(() => {
      setRateLimit(false, null, null);
    });

    await waitFor(() => {
      expect(screen.queryByText(/GitHub requests are paused/)).toBeNull();
    });
  });

  it("shows an inline paused banner over cached data while rate-limited", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(60)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    setRateLimit(true, "primary", Date.now() + 60_000);
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(60)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Cached row stays visible; inline paused banner appears above it.
    expect(screen.getByTestId("item-60")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByText(/GitHub requests are paused\. Showing last known results\./)
      ).toBeTruthy();
    });
    // Fetch never fires because the store-driven guard short-circuits.
    expect(mockListIssues).not.toHaveBeenCalled();
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
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });

    mockListIssues.mockRejectedValue(
      new Error("Cannot reach GitHub. Check your internet connection.")
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    expect(screen.getByTestId("item-20")).toBeTruthy();

    // The stale-while-error banner uses the friendlier rewrite for transient
    // network errors; only this surface is rewritten — the cold-error path still
    // surfaces the raw message.
    await waitFor(() => {
      expect(screen.getByText(/Couldn't reach GitHub\. Showing last known results\./)).toBeTruthy();
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
      nextCursor: null,
      hasMore: false,
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
    // The mount revalidate stamped `freshBypassAt`, and a reveal inside the
    // 10s window deliberately skips the refetch (hide/reveal must not
    // double-spend GraphQL). Age the stamp past the window so this test keeps
    // pinning the reveal-time revalidate itself.
    const entry = getCache(cacheKey)!;
    setCache(cacheKey, { ...entry, freshBypassAt: Date.now() - 11_000 });
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    setCache(closedKey, {
      items: [makeIssue(61), makeIssue(62)],
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    setCache(closedKey, {
      items: [makeIssue(71)],
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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
    expect(screen.getByText("No closed issues")).toBeTruthy();
  });

  it("clears rows and shows the skeleton when the filter changes while keepMounted", async () => {
    const openKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(openKey, {
      items: [makeIssue(60)],
      nextCursor: null,
      hasMore: false,
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

describe("GitHubResourceList aria-busy placement (#6867)", () => {
  it("sets aria-busy on the results grid during background revalidation, not on the refresh button", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    // Hang the revalidation so refreshing stays true.
    mockListIssues.mockImplementation(() => new Promise(() => {}));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    const listbox = screen.getByRole("grid");
    await waitFor(() => {
      expect(listbox.getAttribute("aria-busy")).toBe("true");
    });

    const refreshButton = screen.getByRole("button", { name: /^refresh/i });
    expect(refreshButton.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("GitHubResourceList success-path freshness (#6867)", () => {
  it("keeps the footer quiet while the loaded page is fresh", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByTestId("item-1")).toBeTruthy();
    });
    expect(screen.queryByText(/^Updated/)).toBeNull();
  });

  it("surfaces freshness in the footer once the loaded page goes stale", async () => {
    // A cache entry old enough to cross FRESHNESS_VISIBLE_AFTER_MS, with the
    // revalidation left pending so `lastUpdatedAt` keeps the stale timestamp.
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now() - 10 * 60_000,
    });
    mockListIssues.mockReturnValue(new Promise(() => {}));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/^Updated/)).toBeTruthy();
    });
  });

  it("hides the freshness row while a number-query chip is active", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(42)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    mockGetIssueByNumber.mockResolvedValue(makeIssue(42));
    useGitHubFilterStore.getState().setIssueSearchQuery("#42");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing issue #42")).toBeTruthy();
    });
    // The chip provides context — the freshness row stays hidden during searches.
    expect(screen.queryByText(/^Updated/)).toBeNull();
  });

  it("does not render the freshness row when an error is active", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    mockListIssues.mockRejectedValue(new Error("Boom"));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/Boom/)).toBeTruthy();
    });
    // The freshness row is suppressed; only the banner-side timestamp remains.
    expect(screen.queryByText(/^Updated/)).toBeNull();
  });
});

describe("GitHubResourceList stale-while-error banner copy (#6867)", () => {
  it("rewrites transient network errors to friendlier copy in the stale banner", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(20)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    mockListIssues.mockRejectedValue(
      new Error("Cannot reach GitHub. Check your internet connection.")
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't reach GitHub\. Showing last known results\./)).toBeTruthy();
    });
    expect(screen.queryByText(/Check your internet connection/)).toBeNull();
  });

  it("keeps the sanitized raw message for non-transient errors", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(20)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    mockListIssues.mockRejectedValue(new Error("Repository not found or token lacks access."));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/Repository not found/)).toBeTruthy();
    });
    expect(screen.queryByText(/Couldn't reach GitHub/)).toBeNull();
  });
});

describe("GitHubResourceList number-query chip (#6867)", () => {
  it("shows 'Showing issue #N' for a single-number query", async () => {
    mockGetIssueByNumber.mockResolvedValue(makeIssue(42));
    useGitHubFilterStore.getState().setIssueSearchQuery("#42");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing issue #42")).toBeTruthy();
    });
  });

  it("shows 'Showing PR #N' for the PR variant", async () => {
    mockGetPRByNumber.mockResolvedValue({
      ...makeIssue(7),
      isDraft: false,
      ciStatus: "SUCCESS" as const,
    });
    useGitHubFilterStore.getState().setPrSearchQuery("#7");

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing PR #7")).toBeTruthy();
    });
  });

  it("shows comma-separated numbers for a multi query and truncates after three", async () => {
    mockGetIssueByNumber.mockImplementation((_cwd: string, n: number) =>
      Promise.resolve(makeIssue(n))
    );
    useGitHubFilterStore.getState().setIssueSearchQuery("#1, #2, #3, #4, #5");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing #1, #2, #3 + 2 more")).toBeTruthy();
    });
  });

  it("shows 'Showing range #from..#to' for a small range", async () => {
    mockGetIssueByNumber.mockImplementation((_cwd: string, n: number) =>
      Promise.resolve(makeIssue(n))
    );
    useGitHubFilterStore.getState().setIssueSearchQuery("#1..5");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing range #1..#5")).toBeTruthy();
    });
  });

  it("shows '(capped)' marker for a range that exceeds the multi-fetch cap", async () => {
    mockGetIssueByNumber.mockImplementation((_cwd: string, n: number) =>
      Promise.resolve(makeIssue(n))
    );
    useGitHubFilterStore.getState().setIssueSearchQuery("#1..100");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/Showing first 20 of range #1\.\.#20 \(capped\)/)).toBeTruthy();
    });
  });

  it("shows 'Showing #N and above' for an open-ended query", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(130)]));
    useGitHubFilterStore.getState().setIssueSearchQuery("#130+");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing #130 and above")).toBeTruthy();
    });
  });

  it("hides the chip when the lookup yields exact-number-not-found", async () => {
    mockGetIssueByNumber.mockResolvedValue(null);
    useGitHubFilterStore.getState().setIssueSearchQuery("#999");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/No issue #999 in this view/)).toBeTruthy();
    });
    // The chip would contradict the empty state — it must not render alongside.
    expect(screen.queryByText("Showing issue #999")).toBeNull();
  });

  it("hides the chip while the numeric fetch is in flight", async () => {
    mockGetIssueByNumber.mockImplementation(() => new Promise(() => {}));
    useGitHubFilterStore.getState().setIssueSearchQuery("#42");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Skeleton is up while the numeric lookup hangs.
    await waitFor(() => {
      expect(screen.getByTestId("skeleton")).toBeTruthy();
    });
    expect(screen.queryByText("Showing issue #42")).toBeNull();
  });

  const FALLBACK_COPY = "Showing text matches — separate numbers with commas or spaces";

  it("routes a trailing-comma list to the batch lookup, not full-text search", async () => {
    mockGetIssuesByNumbers.mockResolvedValue([makeIssue(123), makeIssue(124)]);
    useGitHubFilterStore.getState().setIssueSearchQuery("123, 124,");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing #123, #124")).toBeTruthy();
    });
    expect(mockGetIssuesByNumbers).toHaveBeenCalledWith("/test/proj", [123, 124]);
    expect(mockListIssues).not.toHaveBeenCalled();
    expect(screen.queryByText(FALLBACK_COPY)).toBeNull();
  });

  it("routes a whitespace-separated list to the batch lookup", async () => {
    mockGetIssuesByNumbers.mockResolvedValue([makeIssue(12036), makeIssue(12037)]);
    useGitHubFilterStore.getState().setIssueSearchQuery("12036 12037");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing #12036, #12037")).toBeTruthy();
    });
    expect(mockGetIssuesByNumbers).toHaveBeenCalledWith("/test/proj", [12036, 12037]);
    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("caps an explicit list at the multi-fetch cap and says so", async () => {
    const asked = Array.from({ length: MULTI_FETCH_CAP + 1 }, (_, i) => i + 1);
    mockGetIssuesByNumbers.mockResolvedValue(asked.slice(0, MULTI_FETCH_CAP).map(makeIssue));
    useGitHubFilterStore.getState().setIssueSearchQuery(asked.join(", "));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(
        screen.getByText(`Showing first ${MULTI_FETCH_CAP} of ${asked.length} numbers (capped)`)
      ).toBeTruthy();
    });
    expect(mockGetIssuesByNumbers).toHaveBeenCalledWith(
      "/test/proj",
      asked.slice(0, MULTI_FETCH_CAP)
    );
    // The point of the cap is one batch, not a sequential fan-out over the rest.
    expect(mockGetIssuesByNumbers).toHaveBeenCalledTimes(1);
  });

  it("leaves a list of exactly the cap uncapped", async () => {
    const asked = Array.from({ length: MULTI_FETCH_CAP }, (_, i) => i + 1);
    mockGetIssuesByNumbers.mockResolvedValue(asked.map(makeIssue));
    useGitHubFilterStore.getState().setIssueSearchQuery(asked.join(", "));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText("Showing #1, #2, #3 + 17 more")).toBeTruthy();
    });
    expect(mockGetIssuesByNumbers).toHaveBeenCalledWith("/test/proj", asked);
    expect(screen.queryByText(/\(capped\)/)).toBeNull();
  });

  it("caps the PR variant through its own batch lookup", async () => {
    const asked = Array.from({ length: MULTI_FETCH_CAP + 5 }, (_, i) => i + 1);
    mockGetPRsByNumbers.mockResolvedValue(
      asked.slice(0, MULTI_FETCH_CAP).map((n) => ({
        ...makeIssue(n),
        isDraft: false,
        ciStatus: "SUCCESS" as const,
      }))
    );
    useGitHubFilterStore.getState().setPrSearchQuery(asked.join(" "));

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(
        screen.getByText(`Showing first ${MULTI_FETCH_CAP} of ${asked.length} numbers (capped)`)
      ).toBeTruthy();
    });
    expect(mockGetPRsByNumbers).toHaveBeenCalledWith("/test/proj", asked.slice(0, MULTI_FETCH_CAP));
    expect(mockGetPRsByNumbers).toHaveBeenCalledTimes(1);
    expect(mockListPRs).not.toHaveBeenCalled();
  });

  it("says the results are text matches when a number list fails to parse", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(500)]));
    useGitHubFilterStore.getState().setIssueSearchQuery("123,,124");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledWith(expect.objectContaining({ search: "123,,124" }));
    });
    await waitFor(() => {
      expect(screen.getByText(FALLBACK_COPY)).toBeTruthy();
    });
    // The chip has to sit over the text-search rows it describes, not over a
    // skeleton.
    expect(screen.getByTestId("item-500")).toBeTruthy();
    expect(mockGetIssuesByNumbers).not.toHaveBeenCalled();
  });

  it("holds the text-match chip back until the search settles", async () => {
    mockListIssues.mockImplementation(() => new Promise(() => {}));
    useGitHubFilterStore.getState().setIssueSearchQuery("123,,124");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByTestId("skeleton")).toBeTruthy();
    });
    expect(screen.queryByText(FALLBACK_COPY)).toBeNull();
  });

  it("yields the chip slot to an error rather than claiming text matches", async () => {
    mockListIssues.mockRejectedValue(new Error("Couldn't reach GitHub."));
    useGitHubFilterStore.getState().setIssueSearchQuery("123,,124");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't reach GitHub/)).toBeTruthy();
    });
    expect(screen.queryByText(FALLBACK_COPY)).toBeNull();
  });

  it("drops a stale exact-number miss when the query falls back to text search", async () => {
    mockGetIssueByNumber.mockResolvedValue(null);
    // Empty on purpose: a returned row would hide the empty state whether or
    // not the stale miss was cleared, which is exactly how this test can pass
    // without testing anything.
    mockListIssues.mockResolvedValue(makeResponse([]));
    useGitHubFilterStore.getState().setIssueSearchQuery("#999");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/No issue #999 in this view/)).toBeTruthy();
    });

    // Falling through to text search must not leave the miss behind, or the
    // empty state goes on naming #999 over rows that have nothing to do with it.
    act(() => {
      useGitHubFilterStore.getState().setIssueSearchQuery("123,,124");
    });

    // The empty state must stop naming #999 and start naming the query that
    // actually ran.
    await waitFor(() => {
      expect(screen.getByText('No matches for "123,,124"')).toBeTruthy();
    });
    expect(screen.queryByText(/No issue #999 in this view/)).toBeNull();
  });

  it("yields the chip slot to a rate-limit pause", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));
    setRateLimit(true, "primary", Date.now() + 60_000);
    useGitHubFilterStore.getState().setIssueSearchQuery("123,,124");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(screen.getByText(/paused/i)).toBeTruthy();
    });
    expect(screen.queryByText(FALLBACK_COPY)).toBeNull();
  });

  it("stays quiet for an ordinary text search that contains numbers", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(500)]));
    useGitHubFilterStore.getState().setIssueSearchQuery("fix 123 crash");

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledWith(
        expect.objectContaining({ search: "fix 123 crash" })
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Issue #500")).toBeTruthy();
    });
    expect(screen.queryByText(FALLBACK_COPY)).toBeNull();
  });
});

describe("GitHubResourceList spinner gate (#6867)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Windows CI runners are slow enough that the wall-clock time between
  // `shouldAdvanceTime: true` (from the parent beforeEach) can chain through
  // cascading timers during render and leap past 400ms before
  // `advanceTimersByTimeAsync` runs, making any sub-400ms assertion flaky.
  // Switch to manual-advance timers for this test so the gate is deterministic.
  it("does not show the spinner before the 400ms Doherty threshold elapses", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    // Hang revalidation so refreshing stays true.
    mockListIssues.mockImplementation(() => new Promise(() => {}));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await vi.advanceTimersByTimeAsync(390);

    const refreshIcon = screen.getByRole("button", { name: /^refresh/i }).querySelector("svg");
    expect(refreshIcon?.classList.contains("animate-spin")).toBe(false);
  });

  it("shows the spinner once the 400ms gate elapses on a long background revalidation", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    mockListIssues.mockImplementation(() => new Promise(() => {}));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await vi.advanceTimersByTimeAsync(450);

    const refreshIcon = screen.getByRole("button", { name: /^refresh/i }).querySelector("svg");
    expect(refreshIcon?.classList.contains("animate-spin")).toBe(true);
  });

  it("never flashes the spinner when a background refresh completes faster than the gate", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Let the fetch settle well within the 400ms gate.
    await vi.advanceTimersByTimeAsync(50);

    const refreshIcon = screen.getByRole("button", { name: /^refresh/i }).querySelector("svg");
    expect(refreshIcon?.classList.contains("animate-spin")).toBe(false);
  });

  it("holds an explicit refresh to the same 400ms gate as a background one", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    // Mount-time revalidate succeeds so loading clears before the click.
    mockListIssues.mockResolvedValueOnce(makeResponse([makeIssue(1)]));
    // Manual click hangs so we can observe the spinner gate.
    mockListIssues.mockImplementation(() => new Promise(() => {}));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(1);
    });

    // Let the mount-time revalidate fully settle so any pending spinner timer
    // is cleared before the click.
    await vi.advanceTimersByTimeAsync(500);

    const refreshButton = screen.getByRole("button", { name: /^refresh/i });
    act(() => {
      refreshButton.click();
    });
    await waitFor(() => {
      expect(mockListIssues).toHaveBeenCalledTimes(2);
    });

    // A press buys no exemption from the Doherty gate — the button's press
    // state and the grid's `aria-busy` flip are the acknowledgement, so a
    // refresh that resolves inside 400ms shows no spinner at all.
    await vi.advanceTimersByTimeAsync(350);
    const refreshIconBefore = refreshButton.querySelector("svg");
    expect(refreshIconBefore?.classList.contains("animate-spin")).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await waitFor(() => {
      const icon = refreshButton.querySelector("svg");
      expect(icon?.classList.contains("animate-spin")).toBe(true);
    });
  });

  it("dwells the spinner ≥500ms once visible to avoid a quick flash", async () => {
    const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
    setCache(cacheKey, {
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
    });
    let resolveFetch: (v: Page<Issue>) => void = () => {};
    mockListIssues.mockImplementationOnce(
      () =>
        new Promise<Page<Issue>>((resolve) => {
          resolveFetch = resolve;
        })
    );

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    // Cross the 400ms gate so the spinner becomes visible.
    await vi.advanceTimersByTimeAsync(450);
    const refreshIcon = screen.getByRole("button", { name: /^refresh/i }).querySelector("svg");
    expect(refreshIcon?.classList.contains("animate-spin")).toBe(true);

    // Resolve immediately — dwell timer kicks in for the remaining 500ms.
    resolveFetch(makeResponse([makeIssue(1)]));
    await vi.advanceTimersByTimeAsync(0);
    const stillSpinning = screen.getByRole("button", { name: /^refresh/i }).querySelector("svg");
    expect(stillSpinning?.classList.contains("animate-spin")).toBe(true);

    // After the full 500ms minimum dwell elapses, the spinner clears.
    await vi.advanceTimersByTimeAsync(550);
    const finalIcon = screen.getByRole("button", { name: /^refresh/i }).querySelector("svg");
    expect(finalIcon?.classList.contains("animate-spin")).toBe(false);
  });
});

describe("GitHubResourceList polish (#7202)", () => {
  it("state filter renders as a radiogroup with aria-checked + roving tabindex", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    const group = await screen.findByRole("radiogroup", { name: /filter by state/i });
    const radios = group.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(radios.length).toBe(2); // Open, Closed for issues

    const openRadio = radios[0]!;
    const closedRadio = radios[1]!;
    expect(openRadio.getAttribute("aria-checked")).toBe("true");
    expect(openRadio.tabIndex).toBe(0);
    expect(closedRadio.getAttribute("aria-checked")).toBe("false");
    expect(closedRadio.tabIndex).toBe(-1);

    // ArrowRight on the active radio moves checked state, tabindex, and focus to the next.
    act(() => {
      openRadio.focus();
      openRadio.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    await waitFor(() => {
      const updated = group.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      expect(updated[1]!.getAttribute("aria-checked")).toBe("true");
      expect(updated[0]!.getAttribute("aria-checked")).toBe("false");
      expect(updated[1]!.tabIndex).toBe(0);
      expect(updated[0]!.tabIndex).toBe(-1);
      expect(document.activeElement).toBe(updated[1]);
    });
  });

  it("sort popover ArrowDown moves checked + focus to the next radio", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    const sortButton = await screen.findByRole("button", { name: /^sort/i });
    act(() => {
      sortButton.click();
    });

    const newest = await screen.findByRole("radio", { name: /newest/i });
    expect(newest.getAttribute("aria-checked")).toBe("true");

    act(() => {
      newest.focus();
      newest.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    await waitFor(() => {
      const recent = screen.getByRole("radio", { name: /recently updated/i });
      expect(recent.getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(recent);
    });
  });

  it("sort trigger has no accent dot on the default sort", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    const sortButton = await screen.findByRole("button", { name: /^sort/i });
    expect(sortButton.querySelector("span.bg-status-info")).toBeNull();
  });

  it("sort popover trigger reflects open state via aria-expanded", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    const sortButton = await screen.findByRole("button", { name: /^sort/i });
    expect(sortButton.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      sortButton.click();
    });

    await waitFor(() => {
      expect(sortButton.getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("marks a non-default sort with a neutral lift, never a status badge", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    // The default order is the baseline: whatever the lift is, it has to be a
    // difference from this, not a fixed class.
    const defaultView = render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    const defaultSortClass = (await screen.findByRole("button", { name: /^sort/i })).className;
    defaultView.unmount();

    useGitHubFilterStore.getState().setIssueSortOrder("updated");
    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    const sortButton = await screen.findByRole("button", { name: /^sort/i });
    // The old signal was a `bg-status-info` dot, which read as unread activity
    // and said nothing about which order was in force.
    expect(sortButton.querySelector("span.bg-status-info")).toBeNull();
    expect(sortButton.classList.contains("text-status-info")).toBe(false);
    expect(sortButton.className).not.toBe(defaultSortClass);
    // ...and the order itself is now stated, not implied.
    expect(sortButton.getAttribute("title")).toMatch(/recently updated/i);
  });

  it("declares aria-multiselectable as a capability, not as current state", async () => {
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));
    // It used to flip with `isSelectionActive`, which told a screen-reader user
    // the grid could not be multi-selected right up until it already was.
    mockIsSelectionActive = false;

    const { unmount } = render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    expect((await screen.findByRole("grid")).getAttribute("aria-multiselectable")).toBe("true");

    unmount();

    mockIsSelectionActive = true;
    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    expect((await screen.findByRole("grid")).getAttribute("aria-multiselectable")).toBe("true");
  });

  it("refresh button aria-label flips to 'Refreshing…' once the spinner fires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const cacheKey = buildCacheKey("/test/proj", "issue", "open", "created");
      setCache(cacheKey, {
        items: [makeIssue(1)],
        nextCursor: null,
        hasMore: false,
        timestamp: Date.now(),
      });
      mockListIssues.mockImplementation(() => new Promise(() => {}));

      render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

      // Before the gate elapses, label is "Refresh issues".
      await vi.advanceTimersByTimeAsync(50);
      expect(screen.getByRole("button", { name: /refresh issues/i })).toBeTruthy();

      // After the 400ms gate, the label should reflect the active spinner.
      await vi.advanceTimersByTimeAsync(450);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /refreshing/i })).toBeTruthy();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GitHubResourceList dismissal preserves bulk selection", () => {
  it("does not clear selection when the dropdown is dismissed via outside click", () => {
    // Dropdown unmount/dismissal must preserve selection so the user can
    // reopen and finish picking. Selection only clears when worktrees are
    // actually created (Done in BulkCreateWorktreeDialog).
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));

    const { unmount } = render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    unmount();

    expect(mockSelectionClear).not.toHaveBeenCalled();
  });

  it("does not clear selection when the no-token settings link is clicked", () => {
    mockGitHubConfig = { hasToken: false };
    mockGitHubConfigInitialized = true;
    const onClose = vi.fn();

    render(<GitHubResourceList type="issue" projectPath="/test/proj" onClose={onClose} />);

    screen.getByRole("button", { name: /add github token/i }).click();

    expect(mockSelectionClear).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the outgoing project's keyed selection on projectPath change", () => {
    // Bulk selection is keyed by `${type}:${projectPath}` in useIssueSelectionStore
    // so it survives the toolbar's lazy/direct remount. On a real project switch
    // the component must still clear the project it's leaving, otherwise a stale
    // selection outlives the switch and the bulk bar offers to act on another
    // project's issues.
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(1)]));
    useIssueSelectionStore
      .getState()
      .selectAll("issue:/test/proj-a", [makeIssue(1), makeIssue(2), makeIssue(3)]);

    const { rerender } = render(<GitHubResourceList type="issue" projectPath="/test/proj-a" />);
    expect(useIssueSelectionStore.getState().selections.get("issue:/test/proj-a")?.items.size).toBe(
      3
    );

    rerender(<GitHubResourceList type="issue" projectPath="/test/proj-b" />);

    // Cleared, and the entry is gone entirely — a visited project should not
    // leave a resident empty entry behind.
    expect(useIssueSelectionStore.getState().selections.has("issue:/test/proj-a")).toBe(false);
  });

  it("surfaces a failed open-in-GitHub dispatch as an error toast with retry", async () => {
    mockListIssues.mockResolvedValue(makeResponse([]));
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "No remote URL found for this repository" },
    });

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);

    screen.getByRole("button", { name: "View on GitHub" }).click();

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.openIssues",
      { projectPath: "/test/proj", query: undefined, state: "open" },
      { source: "user" }
    );

    const payload = notifyMock.mock.calls[0]?.[0] as {
      type: string;
      title: string;
      action: { label: string; onClick: () => void };
      actions: Array<{ label: string }>;
    };
    expect(payload.type).toBe("error");
    expect(payload.action.label).toBe("Try again");
    expect(payload.actions[0]?.label).toBe("Copy details");

    // "Try again" re-dispatches with the args captured at click time.
    dispatchMock.mockClear();
    payload.action.onClick();
    await waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        "forge.openIssues",
        { projectPath: "/test/proj", query: undefined, state: "open" },
        { source: "user" }
      )
    );
  });

  it("does not toast when the open-in-GitHub dispatch succeeds", async () => {
    mockListPRs.mockResolvedValue(makeResponse([]));
    dispatchMock.mockResolvedValue({ ok: true, result: undefined });

    render(<GitHubResourceList type="pr" projectPath="/test/proj" />);

    screen.getByRole("button", { name: "View on GitHub" }).click();

    await waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        "forge.openPRs",
        { projectPath: "/test/proj", query: undefined, state: "open" },
        { source: "user" }
      )
    );
    await act(async () => {});
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("GitHubResourceList — the row model it hands down", () => {
  const key = buildCacheKey("/test/proj", "issue", "open", "created");

  const seed = (items: Issue[]) => {
    setCache(key, {
      items,
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
      freshBypassAt: Date.now(),
      countAtWrite: items.length,
    });
    mockListIssues.mockResolvedValue(makeResponse(items));
  };

  it("resolves each row's worktree once and hands it down", async () => {
    // The row used to scan the whole worktree map for itself, so nothing above
    // it could be wrong — and nothing could test it either.
    worktreeMap.set("wt-a", { id: "wt-a", issueNumber: 11 });
    seed([makeIssue(10), makeIssue(11)]);

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await waitFor(() => expect(screen.getByTestId("item-11")).toBeTruthy());

    expect(rowProps.get(11)?.worktreeId).toBe("wt-a");
    expect(rowProps.get(10)?.worktreeId).toBeUndefined();
  });

  it("does not match an issue against a worktree made for the same-numbered PR", async () => {
    worktreeMap.set("wt-a", { id: "wt-a", prNumber: 10 });
    seed([makeIssue(10)]);

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await waitFor(() => expect(screen.getByTestId("item-10")).toBeTruthy());

    expect(rowProps.get(10)?.worktreeId).toBeUndefined();
  });

  it("tells rows which timestamp the sort order implies", async () => {
    // Showing "updated" under a "Newest" sort made the ages read out of order
    // against the very list they were sorting.
    seed([makeIssue(10)]);
    const created = render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await waitFor(() => expect(rowProps.get(10)?.timeField).toBe("created"));
    created.unmount();

    rowProps.clear();
    useGitHubFilterStore.getState().setIssueSortOrder("updated");
    setCache(buildCacheKey("/test/proj", "issue", "open", "updated"), {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
      freshBypassAt: Date.now(),
      countAtWrite: 1,
    });
    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await waitFor(() => expect(rowProps.get(10)?.timeField).toBe("updated"));
  });
});

describe("GitHubResourceList — activating the row under the cursor", () => {
  // The pointer and the keyboard split the row's two actions differently: a
  // pointer aims at the title for the forge and anywhere else for the
  // worktree, while the keyboard cursor addresses a whole row and takes the
  // modifier instead. Nothing pinned the keyboard half, so Cmd/Ctrl+Enter —
  // now the only keyboard route to the forge — could have been deleted
  // without a single test noticing.
  const key = buildCacheKey("/test/proj", "issue", "open", "created");

  const seedAndRender = async (items: Issue[]) => {
    // The open path checks the dispatch result and notifies on `ok: false`,
    // so a bare mock returning undefined rejects inside `.then`.
    dispatchMock.mockResolvedValue({ ok: true, result: undefined });
    setCache(key, {
      items,
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
      freshBypassAt: Date.now(),
      countAtWrite: items.length,
    });
    mockListIssues.mockResolvedValue(makeResponse(items));
    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await waitFor(() => expect(screen.getByTestId(`item-${items[0]!.number}`)).toBeTruthy());
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    return input;
  };

  it("creates a worktree on a plain Enter", async () => {
    const input = await seedAndRender([makeIssue(10)]);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockOpenCreateDialog).toHaveBeenCalledWith(expect.objectContaining({ number: 10 }));
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "system.openExternal",
      expect.anything(),
      expect.anything()
    );
  });

  it("switches to the worktree the resource already has, rather than making a second", async () => {
    worktreeMap.set("wt-a", { id: "wt-a", issueNumber: 10 });
    const input = await seedAndRender([makeIssue(10)]);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockSelectWorktree).toHaveBeenCalledWith("wt-a");
    expect(mockOpenCreateDialog).not.toHaveBeenCalled();
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
  ])("opens the forge on %s+Enter instead of the worktree", async (_name, modifier) => {
    const input = await seedAndRender([makeIssue(10)]);
    fireEvent.keyDown(input, { key: "Enter", ...modifier });

    expect(dispatchMock).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://github.com/test/repo/issues/10" },
      { source: "user" }
    );
    expect(mockOpenCreateDialog).not.toHaveBeenCalled();
  });

  it("still opens the forge on a modified Enter while selection is active", async () => {
    // The pointer's route to the forge is the title, and in selection mode the
    // title toggles membership instead. The keyboard's route has no such mode.
    mockIsSelectionActive = true;
    const input = await seedAndRender([makeIssue(10)]);
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(dispatchMock).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://github.com/test/repo/issues/10" },
      { source: "user" }
    );
  });
});

describe("GitHubResourceList — the keyboard cursor across a refresh", () => {
  const key = buildCacheKey("/test/proj", "issue", "open", "created");

  const seed = (items: Issue[]) => {
    setCache(key, {
      items,
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
      freshBypassAt: Date.now(),
      countAtWrite: items.length,
    });
  };

  const activeDescendant = () => screen.getByRole("combobox").getAttribute("aria-activedescendant");

  it("keeps the cursor on the same resource when a refresh reorders the list", async () => {
    // A background revalidation landing mid-navigation used to reset the
    // cursor to nothing, silently throwing away your place.
    seed([makeIssue(10), makeIssue(11)]);
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10), makeIssue(11)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await waitFor(() => expect(screen.getByTestId("item-11")).toBeTruthy());

    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeDescendant()).toBe("github-issue-option-11");

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(11), makeIssue(10)]));
    fireEvent.click(screen.getByRole("button", { name: /^Refresh issues/ }));

    await waitFor(() => expect(activeDescendant()).toBe("github-issue-option-11"));
  });

  it("drops the cursor when the resource it was on is gone", async () => {
    seed([makeIssue(10), makeIssue(11)]);
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10), makeIssue(11)]));

    render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await waitFor(() => expect(screen.getByTestId("item-11")).toBeTruthy());

    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeDescendant()).toBe("github-issue-option-11");

    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)]));
    fireEvent.click(screen.getByRole("button", { name: /^Refresh issues/ }));

    await waitFor(() => expect(activeDescendant()).toBeNull());
  });

  it("does not carry the cursor across a project switch", async () => {
    // A resource number only identifies a row within one project and one kind:
    // issue #10 over there is a different issue #10.
    seed([makeIssue(10)]);
    mockListIssues.mockResolvedValue(makeResponse([makeIssue(10)]));

    const view = render(<GitHubResourceList type="issue" projectPath="/test/proj" />);
    await waitFor(() => expect(screen.getByTestId("item-10")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(activeDescendant()).toBe("github-issue-option-10");

    setCache(buildCacheKey("/other/proj", "issue", "open", "created"), {
      items: [makeIssue(10)],
      nextCursor: null,
      hasMore: false,
      timestamp: Date.now(),
      freshBypassAt: Date.now(),
      countAtWrite: 1,
    });
    view.rerender(<GitHubResourceList type="issue" projectPath="/other/proj" />);

    await waitFor(() => expect(activeDescendant()).toBeNull());
  });
});
