// @vitest-environment jsdom
/**
 * ForgeStatsToolbarButton — per-segment context menus (#12354).
 *
 * Every right-click target in the stats control owns its own menu: each pill
 * leads with its own navigation, and the indicators beside the pills get the
 * repository and toolbar chrome. Real Radix primitives, because the point is
 * that no menu's trigger wraps another's — so a right-click or long-press, even
 * one bubbling out of an open menu's portal, only ever opens one menu.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ForgeProviderEntry } from "@shared/types/forge";
import type { Project } from "@shared/types";

interface WorktreeFixture {
  id: string;
  path: string;
  branch?: string;
  isDetached?: boolean;
}

const dispatchMock = vi.hoisted(() => vi.fn());
const getRepoUrlMock = vi.hoisted(() => vi.fn<(cwd: string) => Promise<string | null>>());
const refreshStatsMock = vi.hoisted(() => vi.fn());
const providerState = vi.hoisted((): { entry: ForgeProviderEntry | null } => ({ entry: null }));
const statsState = vi.hoisted((): { isTokenError: boolean; rateLimitResetAt: number | null } => ({
  isTokenError: false,
  rateLimitResetAt: null,
}));
const worktrees = vi.hoisted(() => new Map<string, WorktreeFixture>());

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    listIssues: vi.fn(),
    listPRs: vi.fn(),
    getRateLimitDetails: vi.fn().mockResolvedValue(null),
    getRepoUrl: (cwd: string) => getRepoUrlMock(cwd),
  },
}));

vi.mock("@/hooks/useRepositoryStats", () => ({
  useRepositoryStats: () => ({
    stats: { issueCount: 3, prCount: 2, commitCount: 5 },
    loading: false,
    error: null,
    isTokenError: statsState.isTokenError,
    refresh: refreshStatsMock,
    isStale: false,
    lastUpdated: Date.now(),
    rateLimitResetAt: statsState.rateLimitResetAt,
    rateLimitKind: null,
    freshnessLevel: "fresh" as const,
  }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: providerState.entry,
    providerId: providerState.entry ? "daintree.github.github" : null,
    resolvedVia: providerState.entry ? "hostname" : null,
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
    sel({ activeWorktreeId: "wt-1" }),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, WorktreeFixture> }) => unknown) =>
    sel({ worktrees }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

// The real Tooltip reads this module's visibility context, so only the dropdown
// shell itself is stubbed.
vi.mock("@/components/ui/fixed-dropdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/fixed-dropdown")>()),
  FixedDropdown: () => null,
}));

vi.mock("../ForgeStatusIndicator", () => ({
  ForgeStatusIndicator: () => null,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { TOOLBAR_CUSTOMIZE_LABEL, TOOLBAR_UNPIN_LABEL } from "../toolbarMenuStrings";
import { ForgeStatsToolbarButton } from "../ForgeStatsToolbarButton";

const PROJECT: Project = {
  id: "test-proj",
  path: "/test/proj",
  name: "proj",
  emoji: "🌲",
  lastOpened: 0,
};

const GITHUB: ForgeProviderEntry = {
  pluginId: "daintree.github",
  contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
};

const CHROME_MENU = ["View repository on GitHub", TOOLBAR_CUSTOMIZE_LABEL, TOOLBAR_UNPIN_LABEL];

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  dispatchMock.mockReset();
  getRepoUrlMock.mockReset();
  getRepoUrlMock.mockResolvedValue("https://github.com/acme/proj");
  providerState.entry = GITHUB;
  statsState.isTokenError = false;
  statsState.rateLimitResetAt = null;
  worktrees.set("wt-1", { id: "wt-1", path: "/test/proj/wt", branch: "feature/x" });
});

afterEach(() => {
  cleanup();
  usePRCircuitBreakerStore.getState().setTripped(false);
});

async function renderStats() {
  render(
    <TooltipProvider>
      <ForgeStatsToolbarButton currentProject={PROJECT} />
    </TooltipProvider>
  );
  // Let the repository-link lookup land so every menu renders its final shape.
  await act(async () => {});
}

async function openMenu(target: HTMLElement): Promise<HTMLElement> {
  fireEvent.contextMenu(target);
  return screen.findByRole("menu");
}

function itemLabels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

// Counts menus aria-hidden by another open menu too: two modal menus hide each
// other, so a visible-only count would miss exactly the co-open it guards.
function openMenuCount(): number {
  return screen.queryAllByRole("menu", { hidden: true }).length;
}

describe("ForgeStatsToolbarButton context menus", () => {
  it("leads the issues pill's menu with its own list, then the repository, then chrome", async () => {
    await renderStats();

    const menu = await openMenu(screen.getByTestId("forge-stat-pill-issues"));

    expect(itemLabels(menu)).toEqual(["View all issues on GitHub", ...CHROME_MENU]);
    expect(openMenuCount()).toBe(1);
  });

  it.each([
    { testId: "forge-stat-pill-prs", first: "View all pull requests on GitHub" },
    { testId: "forge-stat-pill-commits", first: "View commits on GitHub" },
  ])("scopes $testId's menu to its own segment", async ({ testId, first }) => {
    await renderStats();

    const menu = await openMenu(screen.getByTestId(testId));

    expect(itemLabels(menu)[0]).toBe(first);
    expect(openMenuCount()).toBe(1);
  });

  it("opens the active worktree's branch history from the commits pill", async () => {
    await renderStats();
    const menu = await openMenu(screen.getByTestId("forge-stat-pill-commits"));

    fireEvent.click(within(menu).getByRole("menuitem", { name: "View commits on GitHub" }));

    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.openCommits",
      { projectPath: "/test/proj", branch: "feature/x" },
      expect.objectContaining({ source: "context-menu" })
    );
  });

  it("leaves a detached worktree's stale branch out of the commits link", async () => {
    worktrees.set("wt-1", {
      id: "wt-1",
      path: "/test/proj/wt",
      branch: "feature/x",
      isDetached: true,
    });
    await renderStats();
    const menu = await openMenu(screen.getByTestId("forge-stat-pill-commits"));

    fireEvent.click(within(menu).getByRole("menuitem", { name: "View commits on GitHub" }));

    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.openCommits",
      { projectPath: "/test/proj" },
      expect.objectContaining({ source: "context-menu" })
    );
  });

  it("leaves the repository entry out when the provider can't link to one", async () => {
    getRepoUrlMock.mockResolvedValue(null);
    await renderStats();
    expect(getRepoUrlMock).toHaveBeenCalledWith("/test/proj");

    const menu = await openMenu(screen.getByTestId("forge-stat-pill-issues"));

    expect(itemLabels(menu)).toEqual([
      "View all issues on GitHub",
      TOOLBAR_CUSTOMIZE_LABEL,
      TOOLBAR_UNPIN_LABEL,
    ]);
  });

  it("asks again when a menu opens, so a lookup that failed at mount still recovers", async () => {
    getRepoUrlMock.mockRejectedValueOnce(new Error("No remote URL found for this repository"));
    await renderStats();

    const menu = await openMenu(screen.getByTestId("forge-stat-pill-issues"));

    expect(
      await within(menu).findByRole("menuitem", { name: "View repository on GitHub" })
    ).toBeTruthy();
    expect(getRepoUrlMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the forge's own pages on offer while the token needs configuring", async () => {
    statsState.isTokenError = true;
    await renderStats();

    const menu = await openMenu(screen.getByTestId("forge-stat-pill-issues"));

    expect(itemLabels(menu)).toEqual(["View all issues on GitHub", ...CHROME_MENU]);
  });

  it("opens no second menu from a right-click inside an open pill menu", async () => {
    await renderStats();
    const menu = await openMenu(screen.getByTestId("forge-stat-pill-issues"));

    fireEvent.contextMenu(
      within(menu).getByRole("menuitem", { name: "View repository on GitHub" })
    );
    await act(async () => {});

    expect(openMenuCount()).toBe(1);
  });

  it("gives the PR-detection-paused indicator the repository and chrome", async () => {
    usePRCircuitBreakerStore.getState().setTripped(true);
    await renderStats();

    const menu = await openMenu(screen.getByLabelText("PR detection paused — retrying"));

    expect(itemLabels(menu)).toEqual(CHROME_MENU);
  });

  it("gives the rate-limit clock the repository and chrome", async () => {
    statsState.rateLimitResetAt = Date.now() + 10 * 60_000;
    await renderStats();

    const menu = await openMenu(screen.getByLabelText(/GitHub rate limit — resets in/));

    expect(itemLabels(menu)).toEqual(CHROME_MENU);
  });

  it("opens only the pill's menu on a long-press", async () => {
    await renderStats();

    fireEvent.pointerDown(screen.getByTestId("forge-stat-pill-issues"), { pointerType: "touch" });
    // Radix opens a context menu 700 ms into a touch or pen press.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });

    expect(openMenuCount()).toBe(1);
    expect(itemLabels(screen.getByRole("menu"))[0]).toBe("View all issues on GitHub");
  });

  it("offers only toolbar chrome on the commits pill when the project has no forge provider", async () => {
    providerState.entry = null;
    await renderStats();
    expect(screen.queryByTestId("forge-stat-pill-issues")).toBeNull();

    const menu = await openMenu(screen.getByTestId("forge-stat-pill-commits"));

    expect(itemLabels(menu)).toEqual([TOOLBAR_CUSTOMIZE_LABEL, TOOLBAR_UNPIN_LABEL]);
    expect(getRepoUrlMock).not.toHaveBeenCalled();
  });
});
