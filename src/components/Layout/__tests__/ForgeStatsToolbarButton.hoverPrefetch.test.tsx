// @vitest-environment jsdom
/**
 * ForgeStatsToolbarButton — hover-to-prefetch (issue #6282).
 *
 * The Issues and PRs toolbar buttons silently prime the list cache on
 * pointerenter (mouse only) so the dropdown opens with no spinner. The
 * 150ms trailing-edge debounce filters mouse traversal across the toolbar;
 * pointerleave cancels a pending prefetch. Cache freshness, token errors,
 * rate limits, and open dropdowns short-circuit the prefetch so it never
 * duplicates work. Hover never triggers the toolbar status indicator —
 * only an actual click drives visible loading/success state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { fireEvent } from "@testing-library/react";
import type { Issue, Page, PR } from "@shared/types/forge";
import { buildCacheKey, getCache, setCache, _resetForTests } from "@/lib/forgeResourceCache";

const mockListIssues = vi.fn<(cwd: string, opts?: unknown) => Promise<Page<Issue>>>();
const mockListPRs = vi.fn<(cwd: string, opts?: unknown) => Promise<Page<PR>>>();

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    listIssues: (cwd: string, opts?: unknown) => mockListIssues(cwd, opts),
    listPRs: (cwd: string, opts?: unknown) => mockListPRs(cwd, opts),
    getRateLimitDetails: vi.fn().mockResolvedValue(null),
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
    freshnessLevel: "fresh" as const,
  }),
}));

vi.mock("@/hooks/useForgeTokenExpiryNotification", () => ({
  useForgeTokenExpiryNotification: () => {},
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: {
      pluginId: "daintree.github",
      contribution: {
        id: "github",
        name: "GitHub",
        matches: ["github.com"],
        slots: { statsDropdown: "github.statsDropdown" },
      },
    },
    providerId: "daintree.github.github",
    resolvedVia: "hostname",
    loading: false,
    refresh: () => {},
  }),
}));

vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: () => null,
}));

vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteTicker: () => 0,
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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/fixed-dropdown", () => ({
  FixedDropdown: () => null,
}));

vi.mock("../ForgeStatusIndicator", () => ({
  ForgeStatusIndicator: () => null,
}));

import { ForgeStatsToolbarButton } from "../ForgeStatsToolbarButton";
import type { Project } from "@shared/types";

const PROJECT: Project = {
  id: "test-proj",
  path: "/test/proj",
  name: "proj",
  emoji: "🌲",
  lastOpened: 0,
};

const makeIssue = (n: number): Issue => ({
  number: n,
  title: `Issue #${n}`,
  body: "",
  state: "open",
  rawState: "OPEN",
  url: `https://forge.test/repo/issues/${n}`,
  author: { login: "user", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 0,
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

const makePR = (n: number): PR => {
  const base = makeIssue(n) as unknown as Record<string, unknown>;
  return { ...base, isDraft: false, merged: false, baseRef: "main", headRef: "x" } as unknown as PR;
};

const makeIssuePage = (items: Issue[]): Page<Issue> => ({
  items,
  nextCursor: null,
  hasMore: false,
});

const makePRPage = (items: PR[]): Page<PR> => ({
  items,
  nextCursor: null,
  hasMore: false,
});

function renderToolbar() {
  return render(<ForgeStatsToolbarButton currentProject={PROJECT} />);
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
  mockListIssues.mockResolvedValue(makeIssuePage([makeIssue(1)]));
  mockListPRs.mockResolvedValue(makePRPage([makePR(2)]));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ForgeStatsToolbarButton hover prefetch", () => {
  it("fires listIssues 150ms after pointerenter on the Issues button", async () => {
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));

    expect(mockListIssues).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListIssues).toHaveBeenCalledTimes(1);
    expect(mockListIssues.mock.calls[0]?.[0]).toBe("/test/proj");
    expect(mockListIssues.mock.calls[0]?.[1]).toMatchObject({
      state: "open",
      bypassCache: true,
      sort: "created",
    });
  });

  it("fires listPRs 150ms after pointerenter on the PRs button", async () => {
    const { container } = renderToolbar();

    pointerEnter(getPrsButton(container));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockListPRs).toHaveBeenCalledTimes(1);
    expect(mockListPRs.mock.calls[0]?.[0]).toBe("/test/proj");
    expect(mockListPRs.mock.calls[0]?.[1]).toMatchObject({
      state: "open",
      bypassCache: true,
      sort: "created",
    });
  });

  it("does not call refreshStats from the hover path — prefetch must stay silent", async () => {
    const { container } = renderToolbar();

    pointerEnter(getIssuesButton(container));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // Let the prefetch promise settle in case a stats refresh were chained.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(refreshStatsMock).not.toHaveBeenCalled();
    expect(mockListIssues).toHaveBeenCalledTimes(1);
  });

  it("writes prefetch result to the default open/created cache slot", async () => {
    mockListIssues.mockResolvedValue({
      items: [makeIssue(11), makeIssue(12)],
      nextCursor: "cursor-z",
      hasMore: true,
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
    expect(cached!.nextCursor).toBe("cursor-z");
    expect(cached!.hasMore).toBe(true);
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
      nextCursor: null,
      hasMore: false,
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
      nextCursor: null,
      hasMore: false,
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

  it("coalesces concurrent hovers — pointerenter while a prefetch is in flight does not re-fetch", async () => {
    let resolveFirst: (v: Page<Issue>) => void = () => {};
    mockListIssues.mockImplementationOnce(
      () =>
        new Promise<Page<Issue>>((resolve) => {
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
    resolveFirst(makeIssuePage([makeIssue(1)]));
  });

  it("does not prefetch when the dropdown is already open (would duplicate the list's mount fetch)", async () => {
    // Simulate the open state by clicking the button first — onClick toggles
    // open and triggers a forced refresh. The dropdown slot view resolves to
    // null in this suite, but the toolbar tracks issuesOpen=true.
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

  it("does NOT force-refresh on click when stats are within the freshness window", async () => {
    // Default mock: lastUpdated is Date.now() so the polled stats are fresh.
    // Click should rely on the hot cache populated by the 30s poll instead
    // of triggering a full reload.
    const { container } = renderToolbar();
    const button = getIssuesButton(container);

    fireEvent.click(button);

    expect(refreshStatsMock).not.toHaveBeenCalled();
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
      .mockResolvedValue(makeIssuePage([makeIssue(7)]));
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

  it("treats a cache entry exactly at the freshness boundary (10s old) as stale", async () => {
    setCache(buildCacheKey("/test/proj", "issue", "open", "created"), {
      items: [makeIssue(99)],
      nextCursor: null,
      hasMore: false,
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
