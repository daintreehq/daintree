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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const providerState = vi.hoisted(
  (): { entry: ForgeProviderEntry | null; issuesEntry: ForgeProviderEntry | null } => ({
    entry: null,
    issuesEntry: null,
  })
);
const statsState = vi.hoisted(
  (): {
    isTokenError: boolean;
    error: string | null;
    issueError: string | undefined;
    issueStale: boolean | undefined;
    freshnessLevel: "fresh" | "aging" | "stale-disk" | "errored";
    rateLimitResetAt: number | null;
    rateLimitKind: "primary" | "secondary" | null;
  } => ({
    isTokenError: false,
    error: null,
    issueError: undefined,
    issueStale: undefined,
    freshnessLevel: "fresh",
    rateLimitResetAt: null,
    rateLimitKind: null,
  })
);
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
    stats: {
      issueCount: 3,
      prCount: 2,
      commitCount: 5,
      issueError: statsState.issueError,
      issueStale: statsState.issueStale,
    },
    loading: false,
    error: statsState.error,
    isTokenError: statsState.isTokenError,
    refresh: refreshStatsMock,
    isStale: false,
    lastUpdated: Date.now(),
    rateLimitResetAt: statsState.rateLimitResetAt,
    rateLimitKind: statsState.rateLimitKind,
    freshnessLevel: statsState.freshnessLevel,
  }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: providerState.entry,
    providerId: providerState.entry ? "daintree.github.github" : null,
    resolvedVia: providerState.entry ? "hostname" : null,
    issues: providerState.issuesEntry
      ? {
          entry: providerState.issuesEntry,
          providerId: `${providerState.issuesEntry.pluginId}.${providerState.issuesEntry.contribution.id}`,
          resolvedVia: "override",
        }
      : {
          entry: providerState.entry,
          providerId: providerState.entry ? "daintree.github.github" : null,
          resolvedVia: providerState.entry ? "code" : null,
        },
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
  providerState.issuesEntry = null;
  statsState.isTokenError = false;
  statsState.error = null;
  statsState.issueError = undefined;
  statsState.issueStale = undefined;
  statsState.freshnessLevel = "fresh";
  statsState.rateLimitResetAt = null;
  statsState.rateLimitKind = null;
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

  it("asks to reconnect an expired token and points the callout at the issues pill", async () => {
    Object.defineProperty(window, "electron", {
      writable: true,
      configurable: true,
      value: {
        forge: {
          getCredentialStatus: vi
            .fn()
            .mockResolvedValue({ hasCredential: true, fingerprint: "fp" }),
        },
      },
    });
    statsState.isTokenError = true;
    statsState.error = "Invalid GitHub token. Please update in Settings.";
    await renderStats();
    await act(async () => {});

    const pill = screen.getByTestId("forge-stat-pill-issues");
    expect(pill.getAttribute("aria-label")).toBe("Reconnect GitHub to see issues");
    expect(screen.getByTestId("forge-stat-pill-prs").getAttribute("aria-label")).toBe(
      "Reconnect GitHub to see pull requests"
    );
    const callout = screen.getByTestId("forge-token-callout");
    expect(pill.getAttribute("aria-describedby")).toBe(callout.id);
  });

  it("keeps the configure wording and no callout for a token never set", async () => {
    statsState.isTokenError = true;
    statsState.error = "GitHub token not configured. Set it in Settings.";
    await renderStats();

    expect(screen.getByTestId("forge-stat-pill-issues").getAttribute("aria-label")).toBe(
      "Configure GitHub token to see issues"
    );
    expect(screen.queryByTestId("forge-token-callout")).toBeNull();
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

    // The clock's name carries the countdown, as the counters' names do.
    const menu = await openMenu(screen.getByLabelText(/^GitHub rate limit, resets in /));

    expect(itemLabels(menu)).toEqual(CHROME_MENU);
  });

  it("keeps the rate-limit clock for a throttle that reported no reset time", async () => {
    statsState.rateLimitKind = "secondary";
    await renderStats();

    const menu = await openMenu(screen.getByLabelText("GitHub secondary rate limit"));

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

const LINEAR: ForgeProviderEntry = {
  pluginId: "daintree.linear",
  contribution: { id: "linear", name: "Linear", matches: [], roles: ["issues"] },
};

describe("ForgeStatsToolbarButton with issues on another tracker (#16944)", () => {
  beforeEach(() => {
    providerState.issuesEntry = LINEAR;
  });

  function stubCredentialStatus(): void {
    Object.defineProperty(window, "electron", {
      writable: true,
      configurable: true,
      value: {
        forge: {
          getCredentialStatus: vi
            .fn()
            .mockResolvedValue({ hasCredential: true, fingerprint: "fp" }),
        },
      },
    });
  }

  it("names the tracker on the issues pill and its menu, and keeps the repository the code forge's", async () => {
    await renderStats();
    const pill = screen.getByTestId("forge-stat-pill-issues");

    expect(pill.getAttribute("aria-label")).toContain("open issues on Linear");
    fireEvent.focus(pill);
    expect((await screen.findByRole("tooltip")).textContent).toContain("Browse Linear issues");

    const menu = await openMenu(pill);
    expect(itemLabels(menu)).toEqual(["View all issues on Linear", ...CHROME_MENU]);
    const prMenuPill = screen.getByTestId("forge-stat-pill-prs");
    expect(prMenuPill.getAttribute("aria-label")).not.toContain("Linear");
  });

  it("keeps a healthy tracker's pill out of the code forge's token prompt", async () => {
    statsState.isTokenError = true;
    statsState.error = "GitHub token not configured. Set it in Settings.";
    await renderStats();

    const issues = screen.getByTestId("forge-stat-pill-issues");
    expect(issues.getAttribute("aria-label")).not.toContain("GitHub");
    expect(issues.getAttribute("aria-label")).toContain("open issues on Linear");
    expect(screen.getByTestId("forge-stat-pill-prs").getAttribute("aria-label")).toBe(
      "Configure GitHub token to see pull requests"
    );

    fireEvent.click(issues);
    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.openIssues",
      { projectPath: PROJECT.path },
      { source: "user" }
    );
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "app.settings.openTab",
      expect.anything(),
      expect.anything()
    );
  });

  it.each([
    ["No Linear API key configured. Add one in Settings → Code forge.", "Configure Linear token"],
    ["Linear rejected the API key", "Reconnect Linear"],
  ])("asks for the tracker's own credentials after %j", async (issueError, verb) => {
    statsState.issueError = issueError;
    await renderStats();

    const issues = screen.getByTestId("forge-stat-pill-issues");
    expect(issues.getAttribute("aria-label")).toBe(`${verb} to see issues`);
    expect(screen.getByTestId("forge-stat-pill-prs").getAttribute("aria-label")).toContain(
      "open pull requests"
    );

    fireEvent.click(issues);
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.linear.linear" },
      { source: "user" }
    );
  });

  it("says the tracker couldn't refresh when it fails for another reason", async () => {
    statsState.issueError = "Couldn't reach Linear";
    await renderStats();

    expect(screen.getByTestId("forge-stat-pill-issues").getAttribute("aria-label")).toBe(
      "3 open issues on Linear · couldn't refresh"
    );
    expect(screen.getByTestId("forge-stat-pill-prs").getAttribute("aria-label")).toBe(
      "2 open pull requests"
    );
  });

  it("keeps a persisted seed's age on a tracker's pill until a poll reads the tracker", async () => {
    statsState.freshnessLevel = "stale-disk";
    await renderStats();

    expect(screen.getByTestId("forge-stat-pill-issues").getAttribute("aria-label")).toBe(
      "3 open issues on Linear · cached from previous session"
    );
  });

  it("dates a tracker's stale read on its own pill alone", async () => {
    statsState.issueStale = true;
    statsState.freshnessLevel = "stale-disk";
    await renderStats();

    expect(screen.getByTestId("forge-stat-pill-issues").getAttribute("aria-label")).toBe(
      "3 open issues on Linear · cached from previous session"
    );
  });

  it("keeps a healthy tracker's pill fresh while the code forge's poll fails", async () => {
    statsState.error = "Cannot reach GitHub. Check your internet connection.";
    statsState.freshnessLevel = "errored";
    statsState.issueStale = false;
    await renderStats();
    const issues = screen.getByTestId("forge-stat-pill-issues");

    expect(issues.getAttribute("aria-label")).toBe("3 open issues on Linear");
    expect(screen.getByTestId("forge-stat-pill-prs").getAttribute("aria-label")).toContain(
      "couldn't refresh"
    );
    fireEvent.focus(issues);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Browse Linear issues (3 open)"
    );
  });

  it("leaves the code forge's rate limit off the tracker's pill", async () => {
    statsState.rateLimitResetAt = Date.now() + 10 * 60_000;
    await renderStats();

    expect(screen.getByTestId("forge-stat-pill-issues").getAttribute("aria-label")).not.toContain(
      "rate limit"
    );
    expect(screen.getByTestId("forge-stat-pill-prs").getAttribute("aria-label")).toContain(
      "GitHub rate limit"
    );
  });

  it("points the code forge's reconnect callout at the PR pill, promising only PR counts", async () => {
    stubCredentialStatus();
    statsState.isTokenError = true;
    statsState.error = "Invalid GitHub token. Please update in Settings.";
    await renderStats();
    await act(async () => {});

    const callout = screen.getByTestId("forge-token-callout");
    expect(screen.getByTestId("forge-stat-pill-prs").getAttribute("aria-describedby")).toBe(
      callout.id
    );
    expect(
      screen.getByTestId("forge-stat-pill-issues").getAttribute("aria-describedby")
    ).toBeNull();
    expect(callout.textContent).toContain("restore pull request counts.");
    expect(callout.textContent).not.toContain("issue");

    // Dismissed from inside, it hands focus back to the pill it points at.
    const close = screen.getByRole("button", { name: "Dismiss GitHub token warning" });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("forge-token-callout")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("forge-stat-pill-prs"));
  });
});
