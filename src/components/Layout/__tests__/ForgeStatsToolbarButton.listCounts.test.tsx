// @vitest-environment jsdom
/**
 * ForgeStatsToolbarButton — which list totals reach the issue and PR badges
 * (#16866). A list report is dated by when its read was requested, so it wins
 * over a stats count read before it and loses to one read after; a report that
 * lands after a later one is dropped, per kind, until the project changes. A
 * hover prefetch that read the forge reports like the dropdown does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Issue, Page, PR } from "@shared/types/forge";
import type { ForgeStatsDropdownProps } from "../forgeStatsDropdownContract";
import { _resetForTests } from "@/lib/forgeResourceCache";

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
const statsState = { lastUpdated: 1_000, sharedCounts: false };

vi.mock("@/hooks/useRepositoryStats", () => ({
  useRepositoryStats: () => ({
    stats: { issueCount: 3, prCount: 2, commitCount: 0 },
    loading: false,
    error: null,
    isTokenError: false,
    sharedCounts: statsState.sharedCounts,
    refresh: refreshStatsMock,
    isStale: false,
    lastUpdated: statsState.lastUpdated,
    rateLimitResetAt: null,
    rateLimitKind: null,
    freshnessLevel: "fresh" as const,
  }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => {
  const entry = {
    pluginId: "daintree.github",
    contribution: {
      id: "github",
      name: "GitHub",
      matches: ["github.com"],
      slots: { statsDropdown: "github.statsDropdown" },
    },
  };
  return {
    useResolvedForgeProvider: () => ({
      entry,
      providerId: "daintree.github.github",
      resolvedVia: "hostname",
      issues: { entry, providerId: "daintree.github.github", resolvedVia: "code" },
      loading: false,
      refresh: () => {},
    }),
  };
});

// The dropdown view only records the props the toolbar hands it, so a test can
// drive `onCountUpdate` the way the plugin's list does.
const viewProps = new Map<string, ForgeStatsDropdownProps>();
function CaptureView(props: ForgeStatsDropdownProps) {
  viewProps.set(props.kind, props);
  return null;
}
vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: (slotId: string) => (slotId === "github.statsDropdown" ? CaptureView : null),
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

// Kept mounted like the real one, so the dropdown view is always rendered.
vi.mock("@/components/ui/fixed-dropdown", () => ({
  FixedDropdown: ({ children }: { children: ReactNode }) => <>{children}</>,
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
const OTHER_PROJECT: Project = { ...PROJECT, id: "other-proj", path: "/test/other" };

function badge(container: HTMLElement, noun: "open issue" | "open pull request"): number {
  const label = container
    .querySelector<HTMLButtonElement>(`button[aria-label*="${noun}"]`)
    ?.getAttribute("aria-label");
  const match = /^(\d+) /.exec(label ?? "");
  if (!match) throw new Error(`No ${noun} badge in "${label}"`);
  return Number(match[1]);
}

function report(kind: "issues" | "prs", count: number, observedAt: number): void {
  const props = viewProps.get(kind);
  if (!props?.onCountUpdate) throw new Error(`No ${kind} view rendered`);
  act(() => props.onCountUpdate?.(count, false, observedAt));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  _resetForTests();
  viewProps.clear();
  mockListIssues.mockReset();
  mockListPRs.mockReset();
  refreshStatsMock.mockClear();
  statsState.lastUpdated = 1_000;
  statsState.sharedCounts = false;
});

afterEach(() => {
  cleanup();
});

describe("ForgeStatsToolbarButton list counts (#16866)", () => {
  it("shows a list total read after the stats count, and drops an older report that lands later", () => {
    const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);
    expect(badge(container, "open issue")).toBe(3);

    report("issues", 0, 5_000);
    expect(badge(container, "open issue")).toBe(0);

    report("issues", 7, 4_000);
    expect(badge(container, "open issue")).toBe(0);

    report("issues", 5, 6_000);
    expect(badge(container, "open issue")).toBe(5);
  });

  it("orders each kind's reports on its own", () => {
    const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);

    report("issues", 0, 6_000);
    report("prs", 9, 3_000);
    expect(badge(container, "open pull request")).toBe(9);

    report("prs", 4, 2_000);
    expect(badge(container, "open pull request")).toBe(9);
    expect(badge(container, "open issue")).toBe(0);
  });

  it("keeps the stats count over a list read before it", () => {
    statsState.lastUpdated = 10_000;
    const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);

    report("issues", 0, 9_000);

    expect(badge(container, "open issue")).toBe(3);
  });

  it("accepts an earlier-dated report again once the project changes", () => {
    const { container, rerender } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);
    report("issues", 0, 6_000);
    report("prs", 0, 6_000);

    rerender(<ForgeStatsToolbarButton currentProject={OTHER_PROJECT} />);
    report("issues", 1, 2_000);
    report("prs", 8, 2_000);

    expect(badge(container, "open issue")).toBe(1);
    expect(badge(container, "open pull request")).toBe(8);
  });

  describe("hover prefetch", () => {
    function hoverIssues(container: HTMLElement): void {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label*="open issue"]');
      if (!button) throw new Error("Issues button not found");
      act(() => {
        fireEvent.pointerEnter(button, { pointerType: "mouse" });
      });
    }

    it("reports a read that reached the forge to the badge", async () => {
      mockListIssues.mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
        totalCount: 0,
        source: "network",
      });
      const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);

      hoverIssues(container);
      await settle();

      expect(badge(container, "open issue")).toBe(0);
      // Without shared counts the badge already shows it; no stats round trip.
      expect(refreshStatsMock).not.toHaveBeenCalled();
    });

    it("reads the held total back with shared counts on, since the badge shows the record", async () => {
      statsState.sharedCounts = true;
      mockListIssues.mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
        totalCount: 0,
        source: "network",
      });
      const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);

      hoverIssues(container);
      await settle();

      expect(refreshStatsMock).toHaveBeenCalledTimes(1);
      // The record, not the list, drives the badge while counts are shared.
      expect(badge(container, "open issue")).toBe(3);
    });

    it("leaves the badge alone for a page the provider served from its cache", async () => {
      statsState.sharedCounts = true;
      mockListIssues.mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
        totalCount: 0,
        source: "cache",
      });
      const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);

      hoverIssues(container);
      await settle();

      expect(badge(container, "open issue")).toBe(3);
      expect(refreshStatsMock).not.toHaveBeenCalled();
    });
  });
});
