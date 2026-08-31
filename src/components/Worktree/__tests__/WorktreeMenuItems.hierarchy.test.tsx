/**
 * @vitest-environment jsdom
 *
 * The menu's information architecture, tested as structure rather than as a
 * snapshot: which root rows exist, in what order, and where the separators
 * fall. These are the invariants the redesign exists to establish — a flat
 * root of a dozen unrelated commands is what it replaced — so they are worth
 * pinning independently of any one row's behaviour.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, fireEvent } from "@testing-library/react";
import type { WorktreeState } from "../../../types";
import { fileManagerRevealLabel } from "@/lib/platform";
import {
  makeWorktree,
  renderWorktreeMenu,
  rootRowLabels,
  rootSeparatorCount,
  zeroCounts,
} from "./worktreeMenuHarness";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

afterEach(() => {
  cleanup();
  dispatch.mockClear();
});

/** Every optional group present: the widest root the menu can produce. */
function fullyPopulated(): Parameters<typeof renderWorktreeMenu>[0] {
  return {
    worktree: makeWorktree({
      issueNumber: 42,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the PR ref is read.
      linked: {
        pr: { ref: { number: 7 }, url: "https://example.test/pr/7" },
      } as WorktreeState["linked"],
      worktreeMode: "local",
      aheadCount: 2,
      behindCount: 0,
      // A completed status pass with a tracking branch — without it the Git
      // rows have no upstream to speak of and the group is not "fully
      // populated" at all.
      worktreeChanges: {
        worktreeId: "wt-1",
        rootPath: "/repo/wt-1",
        changes: [],
        changedFileCount: 0,
        tracking: "origin/feature",
      },
    }),
    counts: { grid: 2, dock: 1, active: 3, completed: 0, all: 3, waiting: 1, working: 2 },
    recipes: [{ id: "r1", name: "Two agents" }],
    onSaveLayout: vi.fn(),
    onOpenReviewHub: vi.fn(),
    onGitPullRebase: vi.fn(),
    onGitPush: vi.fn(),
    onGitForcePush: vi.fn(),
    canForcePush: true,
    onOpenChanges: vi.fn(),
    onCompareDiff: vi.fn(),
    onOpenFileBrowser: vi.fn(),
    onOpenPanelPalette: vi.fn(),
    onAttachIssue: vi.fn(),
    onUnlinkIssue: vi.fn(),
    onOpenIssueExternal: vi.fn(),
    onOpenPRExternal: vi.fn(),
    onViewPlan: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleCollapse: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    canMoveUp: true,
    canMoveDown: true,
    hasResourceConfig: true,
    resourceEnvironmentKeys: ["staging"],
    onSwitchEnvironment: vi.fn(),
    onDeleteWorktree: vi.fn(),
    pluginItems: [
      {
        pluginId: "acme",
        item: { location: "worktree", label: "Acme thing", actionId: "acme.go" },
      },
    ],
  };
}

describe("WorktreeMenuItems — root hierarchy", () => {
  it("renders the twelve intent groups in the specified order", () => {
    const { container } = renderWorktreeMenu(fullyPopulated());

    expect(rootRowLabels(container)).toEqual([
      "Launch",
      "Open",
      "Review",
      "Git",
      "Sessions",
      "Recipes",
      "Runtime",
      "Linked work",
      "Copy",
      "Organize",
      "Extensions",
      "Delete worktree…",
    ]);
  });

  it("separates the four bands with exactly three root separators", () => {
    const { container } = renderWorktreeMenu(fullyPopulated());

    expect(rootSeparatorCount(container)).toBe(3);
  });

  it("ends on the destructive row, never on a plugin contribution", () => {
    const { container } = renderWorktreeMenu(fullyPopulated());
    const rows = rootRowLabels(container);

    expect(rows.at(-1)).toBe("Delete worktree…");
    expect(rows.indexOf("Extensions")).toBeLessThan(rows.indexOf("Delete worktree…"));
  });

  it("drops every conditional group on a fresh worktree without ending on a separator", () => {
    const { container } = renderWorktreeMenu({
      onOpenReviewHub: vi.fn(),
      onDeleteWorktree: vi.fn(),
      onTogglePin: vi.fn(),
    });

    expect(rootRowLabels(container)).toEqual([
      "Launch",
      "Open",
      "Review",
      "Git",
      "Sessions",
      "Copy",
      "Organize",
      "Delete worktree…",
    ]);
    expect(container.lastElementChild?.matches("[data-menu-separator]")).toBe(false);
    expect(container.firstElementChild?.matches("[data-menu-separator]")).toBe(false);
  });

  it("never renders two separators in a row", () => {
    const { container } = renderWorktreeMenu({ onDeleteWorktree: vi.fn() });

    const kinds = Array.from(container.children).map((n) =>
      n.matches("[data-menu-separator]") ? "sep" : "row"
    );
    expect(kinds.some((kind, i) => kind === "sep" && kinds[i + 1] === "sep")).toBe(false);
  });

  it("withholds deletion for the main worktree even when a callback is supplied", () => {
    // The card already withholds the callback, but the shared menu must not put
    // the whole safeguard in one caller's hands — pinning is gated here too.
    const { container } = renderWorktreeMenu({
      worktree: makeWorktree({ isMainWorktree: true }),
      onDeleteWorktree: vi.fn(),
      onToggleCollapse: vi.fn(),
    });

    const rows = rootRowLabels(container);
    expect(rows).not.toContain("Delete worktree…");
    expect(container.lastElementChild?.matches("[data-menu-separator]")).toBe(false);
  });

  it("still offers deletion for a non-main worktree", () => {
    // Guards the assertion above against passing for the wrong reason.
    const { container } = renderWorktreeMenu({ onDeleteWorktree: vi.fn() });

    expect(rootRowLabels(container)).toContain("Delete worktree…");
  });
});

describe("WorktreeMenuItems — Launch", () => {
  it("lists pinned agents in the order given, above the fixed panel rows", () => {
    const { container } = renderWorktreeMenu({
      launchAgents: [
        { id: "claude", name: "Claude", isEnabled: true },
        { id: "codex", name: "Codex", isEnabled: true },
      ],
      onLaunchAgent: vi.fn(),
    });

    const launchSub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (sub) => sub.firstElementChild?.textContent?.trim() === "Launch"
    );
    const labels = Array.from(launchSub?.querySelectorAll("[data-menu-item]") ?? []).map(
      (el) => el.textContent
    );

    expect(labels.slice(0, 2)).toEqual(["Claude", "Codex"]);
    expect(labels.slice(2)).toEqual(["Terminal", "Browser", "Dev preview"]);
  });

  it("explains an unavailable agent instead of leaving a bare disabled row", () => {
    renderWorktreeMenu({
      launchAgents: [{ id: "codex", name: "Codex", isEnabled: false }],
      onLaunchAgent: vi.fn(),
    });

    const row = screen.getByLabelText("Codex, not installed");
    expect(row).toHaveProperty("disabled", true);
    expect(row.textContent).toContain("Not installed");
  });

  it("routes the full launcher through the resolved surface source", () => {
    const onOpenPanelPalette = vi.fn();
    renderWorktreeMenu({ onOpenPanelPalette }, "context-menu");

    fireEvent.click(screen.getByText("More agents and panels…"));

    expect(onOpenPanelPalette).toHaveBeenCalledWith("context-menu");
  });

  it("dispatches as `menu` from the dropdown surface", () => {
    const onOpenPanelPalette = vi.fn();
    renderWorktreeMenu({ onOpenPanelPalette }, "menu");

    fireEvent.click(screen.getByText("More agents and panels…"));

    expect(onOpenPanelPalette).toHaveBeenCalledWith("menu");
  });
});

describe("WorktreeMenuItems — Git", () => {
  it("leads with Fetch and Fetch and prune, then the base-integration rows", () => {
    const { container } = renderWorktreeMenu({});

    const git = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (sub) => sub.firstElementChild?.textContent?.trim() === "Git"
    );
    const rows = Array.from(git?.querySelectorAll("[data-menu-item]") ?? []).map((n) =>
      n.textContent?.trim()
    );
    expect(rows).toEqual([
      "Fetch",
      "Fetch and prune",
      "Rebase onto base branch…No base branch",
      "Merge base branch in…No base branch",
    ]);
  });

  it("dispatches git.fetch without prune from the plain row", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ id: "/wt/a" }) }, "context-menu");

    fireEvent.click(screen.getByText("Fetch"));

    expect(dispatch).toHaveBeenCalledWith(
      "git.fetch",
      { worktreeId: "/wt/a" },
      { source: "context-menu" }
    );
  });

  it("dispatches git.fetch with prune from the prune row", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ id: "/wt/a" }) }, "menu");

    fireEvent.click(screen.getByText("Fetch and prune"));

    expect(dispatch).toHaveBeenCalledWith(
      "git.fetch",
      { worktreeId: "/wt/a", prune: true },
      { source: "menu" }
    );
  });

  it("targets the row's own worktree, not whichever card happens to be focused", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ id: "/wt/other" }) });

    fireEvent.click(screen.getByText("Fetch"));

    expect(dispatch).toHaveBeenCalledWith(
      "git.fetch",
      { worktreeId: "/wt/other" },
      expect.anything()
    );
  });
});

describe("WorktreeMenuItems — Sessions", () => {
  const busy = {
    counts: { grid: 2, dock: 1, active: 3, completed: 0, all: 3, waiting: 1, working: 2 },
  };

  it("orders the sections layout → fleet → maintenance → destructive", () => {
    const { container } = renderWorktreeMenu(busy);

    const sessions = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (sub) => sub.firstElementChild?.textContent?.trim() === "Sessions"
    );
    const labels = Array.from(sessions?.querySelectorAll("[data-menu-item]") ?? []).map(
      (el) => el.textContent?.replace(/\d+$/, "") ?? ""
    );

    expect(labels).toEqual([
      "Dock all panels",
      "Move all to grid",
      "Select all terminals",
      "Select waiting agents",
      "Select working agents",
      "Redraw all terminals",
      "Clear session history…",
      "Trash all sessions…",
      "Terminate all sessions…",
    ]);
  });

  it("names the counts each bulk row acts on in its accessible label", () => {
    renderWorktreeMenu(busy);

    expect(screen.queryByLabelText("Dock all panels, 2")).not.toBeNull();
    expect(screen.queryByLabelText("Move all to grid, 1")).not.toBeNull();
    expect(screen.queryByLabelText("Redraw all terminals, 3")).not.toBeNull();
    expect(screen.queryByLabelText("Select waiting agents, 1")).not.toBeNull();
  });

  it("hides the layout, fleet and maintenance sections when nothing is running", () => {
    renderWorktreeMenu();

    expect(screen.queryByText("Dock all panels")).toBeNull();
    expect(screen.queryByText("Select all terminals")).toBeNull();
    expect(screen.queryByText("Redraw all terminals")).toBeNull();
  });

  it("keeps the clear-history route reachable when no session is live", () => {
    // Journal availability isn't cached, and opening a menu must not go and
    // read it — so an unknown count keeps the row rather than guessing zero.
    renderWorktreeMenu();

    expect(screen.queryByText("Clear session history…")).not.toBeNull();
  });
});

describe("WorktreeMenuItems — Runtime", () => {
  it("stays absent when there is neither a dev server nor an environment", () => {
    const { container } = renderWorktreeMenu();

    expect(rootRowLabels(container)).not.toContain("Runtime");
  });

  it("offers a truthful start for a stopped-but-restorable server", () => {
    renderWorktreeMenu({
      devServerState: "restorable",
      onStartDevServer: vi.fn(),
      onStopDevServer: vi.fn(),
      onRestartDevServer: vi.fn(),
    });

    expect(screen.queryByText("Start dev server")).not.toBeNull();
    expect(screen.queryByText("Restart dev server")).toBeNull();
    expect(screen.queryByText("Stop dev server")).toBeNull();
  });

  it("offers restart and stop only while the server is live", () => {
    renderWorktreeMenu({
      devServerState: "running",
      onStartDevServer: vi.fn(),
      onStopDevServer: vi.fn(),
      onRestartDevServer: vi.fn(),
    });

    expect(screen.queryByText("Start dev server")).toBeNull();
    expect(screen.queryByText("Restart dev server")).not.toBeNull();
    expect(screen.queryByText("Stop dev server")).not.toBeNull();
  });

  it("shows only the switcher in local mode, not a wall of dead remote commands", () => {
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "local",
      resourceEnvironmentKeys: ["staging"],
      onSwitchEnvironment: vi.fn(),
      onResourceProvision: vi.fn(),
      onResourceResume: vi.fn(),
      onResourcePause: vi.fn(),
      onResourceConnect: vi.fn(),
      onResourceStatus: vi.fn(),
      onResourceTeardown: vi.fn(),
    });

    expect(screen.queryByText("Switch environment")).not.toBeNull();
    for (const label of [
      "Check status",
      "Connect",
      "Provision",
      "Resume",
      "Pause",
      "Tear down environment…",
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("uses real radio semantics for the environment choice", () => {
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "staging",
      resourceEnvironmentKeys: ["staging", "prod"],
      onSwitchEnvironment: vi.fn(),
    });

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["Local", "staging", "prod"]);
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false");
  });

  it("switches environment through the group's value change", () => {
    const onSwitchEnvironment = vi.fn();
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "staging",
      resourceEnvironmentKeys: ["staging"],
      onSwitchEnvironment,
    });

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Local/ }));

    expect(onSwitchEnvironment).toHaveBeenCalledWith("local");
  });

  it("keeps every configured command reachable when the status is unrecognized", () => {
    // `lastStatus` is free-form output from the project's own status command, so
    // a project that prints "healthy" must not lose Resume, Pause and Connect
    // to a token list that never claimed to be exhaustive.
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "staging",
      resourceStatus: "healthy",
      resourceEnvironmentKeys: ["staging"],
      onSwitchEnvironment: vi.fn(),
      onResourceResume: vi.fn(),
      onResourcePause: vi.fn(),
      onResourceConnect: vi.fn(),
      onResourceStatus: vi.fn(),
    });

    for (const label of ["Resume", "Pause", "Connect", "Check status"]) {
      expect(screen.queryByText(label)).not.toBeNull();
    }
  });

  it("offers Connect on a configured command whatever the status says", () => {
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "staging",
      resourceStatus: "paused",
      resourceEnvironmentKeys: ["staging"],
      onSwitchEnvironment: vi.fn(),
      onResourceConnect: vi.fn(),
    });

    expect(screen.queryByText("Connect")).not.toBeNull();
  });

  it("renders one radio per environment when a key is literally named local", () => {
    // Settings rejects only blank and duplicate names, so "local" is a
    // representable key — and two items sharing the fixed row's value would
    // both come back checked.
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "local",
      resourceEnvironmentKeys: ["local", "staging"],
      onSwitchEnvironment: vi.fn(),
    });

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["Local", "staging"]);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("prefers Pause over Resume while the environment reports running", () => {
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "staging",
      resourceStatus: "running",
      resourceEnvironmentKeys: ["staging"],
      onSwitchEnvironment: vi.fn(),
      onResourceResume: vi.fn(),
      onResourcePause: vi.fn(),
    });

    expect(screen.queryByText("Pause")).not.toBeNull();
    expect(screen.queryByText("Resume")).toBeNull();
  });

  it("renders teardown last within the environment section", () => {
    const { container } = renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "staging",
      resourceStatus: "running",
      resourceEnvironmentKeys: ["staging"],
      onSwitchEnvironment: vi.fn(),
      onResourceStatus: vi.fn(),
      onResourceConnect: vi.fn(),
      onResourceTeardown: vi.fn(),
    });

    const runtime = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (sub) => sub.firstElementChild?.textContent?.trim() === "Runtime"
    );
    const labels = Array.from(runtime?.querySelectorAll("[data-menu-item]") ?? []).map(
      (el) => el.textContent
    );

    expect(labels.at(-1)).toBe("Tear down environment…");
  });
});

describe("WorktreeMenuItems — Linked work", () => {
  it("is absent with no plan, issue, PR or attach capability", () => {
    const { container } = renderWorktreeMenu();

    expect(rootRowLabels(container)).not.toContain("Linked work");
  });

  it("says attach when nothing is linked and change when something is", () => {
    const { unmount } = renderWorktreeMenu({ onAttachIssue: vi.fn() });
    expect(screen.queryByText("Attach issue…")).not.toBeNull();
    unmount();

    renderWorktreeMenu({
      worktree: makeWorktree({ issueNumber: 42 }),
      onAttachIssue: vi.fn(),
    });
    expect(screen.queryByText("Change linked issue…")).not.toBeNull();
  });

  it("offers a direct unlink naming the linked issue", () => {
    const onUnlinkIssue = vi.fn();
    renderWorktreeMenu({
      worktree: makeWorktree({ issueNumber: 42 }),
      onAttachIssue: vi.fn(),
      onUnlinkIssue,
    });

    fireEvent.click(screen.getByText(/Unlink issue #42/));

    expect(onUnlinkIssue).toHaveBeenCalledTimes(1);
  });

  it("has no unlink row when no issue is linked", () => {
    renderWorktreeMenu({ onAttachIssue: vi.fn(), onUnlinkIssue: vi.fn() });

    expect(screen.queryByText(/Unlink issue/)).toBeNull();
  });
});

describe("WorktreeMenuItems — Extensions", () => {
  const item = (pluginId: string, label: string, actionId: string) => ({
    pluginId,
    item: { location: "worktree" as const, label, actionId },
  });

  it("renders no Extensions trigger when no plugin contributes", () => {
    // `when`-clause filtering happens in `usePluginContextMenuItems`; what the
    // menu owns is that an empty list produces no trigger at all.
    const { container } = renderWorktreeMenu({ pluginItems: [] });

    expect(rootRowLabels(container)).not.toContain("Extensions");
  });

  it("keeps a lone plugin's items nested, so the root stays stable", () => {
    const { container } = renderWorktreeMenu({
      pluginItems: [item("acme", "Do the thing", "acme.go")],
    });

    expect(rootRowLabels(container)).toContain("Extensions");
    expect(screen.queryByText("Do the thing")).not.toBeNull();
    // A single contributor gets no group heading — the submenu title is enough.
    expect(container.querySelector("[data-menu-label]")).toBeNull();
  });

  it("groups by contributing plugin once more than one contributes", () => {
    const { container } = renderWorktreeMenu({
      pluginItems: [item("acme", "Acme thing", "acme.go"), item("zeta", "Zeta thing", "zeta.go")],
    });

    const labels = Array.from(container.querySelectorAll("[data-menu-label]")).map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["acme", "zeta"]);
  });

  it("dispatches the plugin's own action id with the surface source", () => {
    renderWorktreeMenu({ pluginItems: [item("acme", "Do the thing", "acme.go")] }, "context-menu");

    fireEvent.click(screen.getByText("Do the thing"));

    expect(dispatch).toHaveBeenCalledWith("acme.go", undefined, { source: "context-menu" });
  });
});

describe("WorktreeMenuItems — Recipes", () => {
  const recipes = [
    { id: "r1", name: "Two agents" },
    { id: "r2", name: "Reviewer" },
  ];

  it("runs the recipe the row names", () => {
    const onRunRecipe = vi.fn();
    renderWorktreeMenu({ recipes, onRunRecipe });

    fireEvent.click(screen.getByText("Reviewer"));

    expect(onRunRecipe).toHaveBeenCalledWith("r2");
  });

  it("disables the run rows while a recipe is spawning and says why", () => {
    // `handleRunRecipe` early-returns while one is in flight, so an enabled row
    // would be a click that silently does nothing.
    renderWorktreeMenu({ recipes, runningRecipeId: "r1" });

    const row = screen.getByLabelText("Reviewer, a recipe is running");
    expect(row).toHaveProperty("disabled", true);
    expect(row.textContent).toContain("Recipe running");
  });

  it("groups running and saving in one submenu", () => {
    const { container } = renderWorktreeMenu({
      recipes,
      onSaveLayout: vi.fn(),
      counts: { ...zeroCounts, active: 2 },
    });

    const sub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (node) => node.firstElementChild?.textContent?.trim() === "Recipes"
    );
    const labels = Array.from(sub?.querySelectorAll("[data-menu-item]") ?? []).map(
      (el) => el.textContent
    );

    expect(labels).toEqual(["Two agents", "Reviewer", "Save current layout as recipe…"]);
  });

  it("withholds save-layout when the worktree has no live session to snapshot", () => {
    renderWorktreeMenu({ recipes, onSaveLayout: vi.fn() });

    expect(screen.queryByText("Save current layout as recipe…")).toBeNull();
  });

  it("drops the submenu with neither applicable recipes nor a snapshot to save", () => {
    const { container } = renderWorktreeMenu({ onSaveLayout: vi.fn() });

    expect(rootRowLabels(container)).not.toContain("Recipes");
  });
});

describe("WorktreeMenuItems — Open", () => {
  it("omits Browse files when no file-browser route is wired", () => {
    const { container } = renderWorktreeMenu();

    const sub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (node) => node.firstElementChild?.textContent?.trim() === "Open"
    );
    const labels = Array.from(sub?.querySelectorAll("[data-menu-item]") ?? []).map(
      (el) => el.textContent
    );

    expect(labels[0]).not.toBe("Browse files");
    expect(labels).toContain("Open in editor");
  });

  it("routes each destination to its own callback", () => {
    const onOpenFileBrowser = vi.fn();
    const onOpenEditor = vi.fn();
    const onRevealInFinder = vi.fn();
    renderWorktreeMenu({ onOpenFileBrowser, onOpenEditor, onRevealInFinder });

    fireEvent.click(screen.getByText("Browse files"));
    fireEvent.click(screen.getByText("Open in editor"));
    fireEvent.click(screen.getByText(fileManagerRevealLabel()));

    expect(onOpenFileBrowser).toHaveBeenCalledTimes(1);
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    expect(onRevealInFinder).toHaveBeenCalledTimes(1);
  });
});

describe("WorktreeMenuItems — Copy", () => {
  it("routes the two context rows to the full and modified-only callbacks", () => {
    const onCopyContextFull = vi.fn();
    const onCopyContextModified = vi.fn();
    const onCopyPath = vi.fn();
    renderWorktreeMenu({ onCopyContextFull, onCopyContextModified, onCopyPath });

    fireEvent.click(screen.getByText("Full context"));
    fireEvent.click(screen.getByText("Modified files only"));
    fireEvent.click(screen.getByText("Path"));

    expect(onCopyContextFull).toHaveBeenCalledTimes(1);
    expect(onCopyContextModified).toHaveBeenCalledTimes(1);
    expect(onCopyPath).toHaveBeenCalledTimes(1);
  });
});

describe("WorktreeMenuItems — Organize", () => {
  it("disables the move that would run off the end of the list", () => {
    const { unmount } = renderWorktreeMenu({
      onMoveUp: vi.fn(),
      onMoveDown: vi.fn(),
      canMoveUp: false,
      canMoveDown: true,
    });
    expect(screen.getByText("Move up").closest("button")).toHaveProperty("disabled", true);
    expect(screen.getByText("Move down").closest("button")).toHaveProperty("disabled", false);
    unmount();

    renderWorktreeMenu({
      onMoveUp: vi.fn(),
      onMoveDown: vi.fn(),
      canMoveUp: true,
      canMoveDown: false,
    });
    expect(screen.getByText("Move up").closest("button")).toHaveProperty("disabled", false);
    expect(screen.getByText("Move down").closest("button")).toHaveProperty("disabled", true);
  });

  it("omits the move rows for a card variant that cannot be reordered", () => {
    renderWorktreeMenu({ onToggleCollapse: vi.fn() });

    expect(screen.queryByText("Move up")).toBeNull();
    expect(screen.queryByText("Move down")).toBeNull();
  });
});
