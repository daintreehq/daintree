/**
 * @vitest-environment jsdom
 *
 * The menu's information architecture, tested as structure rather than as a
 * snapshot: which root rows exist, in what order, and where the separators
 * fall. These are the invariants the redesign exists to establish — a flat
 * root of a dozen unrelated commands is what it replaced — so they are worth
 * pinning independently of any one row's behaviour. Each group's own rows are
 * pinned below the structure.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { screen, cleanup, fireEvent } from "@testing-library/react";
import type { WorktreeState } from "../../../types";
import { fileManagerRevealLabel } from "@/lib/platform";
import {
  makeWorktree,
  renderWorkspaceRootMenu,
  renderWorktreeMenu,
  rootRowLabels,
  rootSeparatorCount,
  zeroCounts,
} from "./worktreeMenuHarness";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

/**
 * Resolves an ActionResult, not `undefined`: `ActionService.dispatch` CATCHES
 * an action's error and resolves `{ok:false}` rather than rejecting, and the
 * rows read that result to decide whether to raise a toast.
 *
 * Typed as the union rather than inferred from the default — inference narrows
 * to `{ok: boolean}` and then rejects the `error` field a failing dispatch
 * carries.
 */
type MockActionResult = { ok: true } | { ok: false; error: { code: string; message: string } };
const dispatch = vi.hoisted(() =>
  vi.fn((): Promise<MockActionResult> => Promise.resolve({ ok: true }))
);
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

beforeEach(() => {
  // Reset the IMPLEMENTATION too: a test that swaps in a failing dispatch would
  // otherwise poison every test after it.
  dispatch.mockReset();
  dispatch.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  _resetPluginRuntimeStoreForTest();
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
  it("renders the direct rows, then the twelve intent groups in the specified order", () => {
    const { container } = renderWorktreeMenu(fullyPopulated());

    expect(rootRowLabels(container)).toEqual([
      "New session…",
      "Review worktree",
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

  it("separates the five bands with exactly four root separators", () => {
    const { container } = renderWorktreeMenu(fullyPopulated());

    expect(rootSeparatorCount(container)).toBe(4);
  });

  it("drops every conditional group on a fresh worktree without ending on a separator", () => {
    const { container } = renderWorktreeMenu({
      onOpenReviewHub: vi.fn(),
      onDeleteWorktree: vi.fn(),
      onTogglePin: vi.fn(),
    });

    expect(rootRowLabels(container)).toEqual([
      "Review worktree",
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

  it("drops the dev preview's launch row where the project hides it, keeping its server controls", () => {
    const { container } = renderWorktreeMenu({
      onLaunchAgent: vi.fn(),
      hideDevPreview: true,
      devServerState: "running",
      onStopDevServer: vi.fn(),
      onRestartDevServer: vi.fn(),
    });

    const launchSub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (sub) => sub.firstElementChild?.textContent?.trim() === "Launch"
    );
    const labels = Array.from(launchSub?.querySelectorAll("[data-menu-item]") ?? []).map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["Terminal", "Browser"]);
    expect(container.textContent).toMatch(/Stop dev server/);
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
});

describe("WorktreeMenuItems — quiet git detail", () => {
  function subRows(container: HTMLElement, label: string): Array<string | undefined> {
    const sub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (node) => node.firstElementChild?.textContent?.trim() === label
    );
    return Array.from(
      sub
        ?.querySelector("[data-menu-subcontent]")
        ?.querySelectorAll("[data-menu-item], [data-menu-separator]") ?? []
    ).map((n) => (n.hasAttribute("data-menu-separator") ? "—" : n.textContent?.trim()));
  }

  it("folds Review and the issue and PR rows into the one Git submenu", () => {
    const { container } = renderWorktreeMenu({ ...fullyPopulated(), quietGit: true });

    expect(rootRowLabels(container)).toEqual([
      "New session…",
      "Review worktree",
      "Launch",
      "Open",
      "Git",
      "Sessions",
      "Recipes",
      "Runtime",
      "Copy",
      "Organize",
      "Extensions",
      "Delete worktree…",
    ]);
    const git = subRows(container, "Git");
    expect(git.slice(0, 3)).toEqual([
      "Review worktree",
      "View uncommitted changes0",
      "Compare with another worktree…",
    ]);
    expect(git).toContain("Fetch");
    expect(git).toContain("Force push with lease…");
    expect(git.slice(-6)).toEqual([
      "—",
      "Open issue #42",
      "Open PR #7",
      "—",
      "Change linked issue…",
      "Unlink issue #42",
    ]);
    // The worktree's own plan file is not git, so it moves to Open.
    expect(subRows(container, "Open")).toContain("View plan");
    expect(git).not.toContain("View plan");
  });

  it.each([
    ["fully populated", () => fullyPopulated()],
    // Review and Linked work both empty: only the git rows themselves fold in.
    ["sparse", () => ({})],
  ])("never doubles or strands a separator inside Git (%s)", (_label, props) => {
    const { container } = renderWorktreeMenu({ ...props(), quietGit: true });
    const git = subRows(container, "Git");

    expect(git.length).toBeGreaterThan(0);
    expect(git[0]).not.toBe("—");
    expect(git[git.length - 1]).not.toBe("—");
    git.forEach((row, i) => {
      if (row === "—") expect(git[i + 1]).not.toBe("—");
    });
  });

  it("gives a workspace root no Git submenu, quiet or not", () => {
    const { container } = renderWorkspaceRootMenu({ quietGit: true, onOpenReviewHub: vi.fn() });

    expect(rootRowLabels(container)).not.toContain("Git");
    expect(rootRowLabels(container)).not.toContain("Review");
  });

  it("keeps View plan in Linked work while git detail is shown", () => {
    const { container } = renderWorktreeMenu(fullyPopulated());

    expect(subRows(container, "Linked work")[0]).toBe("View plan");
    expect(subRows(container, "Open")).not.toContain("View plan");
  });

  it("dispatches a folded row exactly as the shown menu does", () => {
    const onOpenReviewHub = vi.fn();
    const { container } = renderWorktreeMenu({
      ...fullyPopulated(),
      onOpenReviewHub,
      quietGit: true,
    });
    const git = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (node) => node.firstElementChild?.textContent?.trim() === "Git"
    );
    const folded = Array.from(
      git?.querySelector("[data-menu-subcontent]")?.querySelectorAll("[data-menu-item]") ?? []
    ).find((n) => n.textContent?.trim() === "Review worktree");
    expect(folded).toBeDefined();

    fireEvent.click(folded!);

    expect(onOpenReviewHub).toHaveBeenCalledTimes(1);
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
      "End all sessions…",
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

  it("renders one radio per environment when a saved key is literally named local", () => {
    // Settings now refuses the name, but older project settings can still carry
    // it — and two items sharing the fixed row's value would both come back checked.
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

  it("keeps a saved Local key, which is a different key from Local mode", () => {
    const onSwitchEnvironment = vi.fn();
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "local",
      resourceEnvironmentKeys: ["local", "Local", "staging"],
      onSwitchEnvironment,
    });

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["Local", "Local", "staging"]);
    fireEvent.click(radios[1]!);
    expect(onSwitchEnvironment).toHaveBeenCalledWith("Local");
  });

  it("offers no environment switch when the only saved key is local", () => {
    renderWorktreeMenu({
      hasResourceConfig: true,
      worktreeMode: "local",
      resourceEnvironmentKeys: ["local"],
      onSwitchEnvironment: vi.fn(),
    });

    expect(screen.queryByText("Switch environment")).toBeNull();
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
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

  it("labels a group with the plugin's display name, never its instance key", () => {
    // A contribution's `pluginId` is the host's instance key, so a project-owned
    // plugin's raw id carries a machine-local project id (#12211).
    const instanceKey = "project__b6700c7a__gregpriday.video-manager";
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([[instanceKey, { devMode: false, displayName: "Video Manager" }]]),
    });

    const { container } = renderWorktreeMenu({
      pluginItems: [
        item(instanceKey, "Do the thing", "vm.go"),
        item("zeta", "Zeta thing", "zeta.go"),
      ],
    });

    const labels = Array.from(container.querySelectorAll("[data-menu-label]")).map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["Video Manager", "zeta"]);
  });

  it("labels a group with the manifest id before the runtime snapshot lands", () => {
    const { container } = renderWorktreeMenu({
      pluginItems: [
        item("project__b6700c7a__gregpriday.video-manager", "Do the thing", "vm.go"),
        item("zeta", "Zeta thing", "zeta.go"),
      ],
    });

    const labels = Array.from(container.querySelectorAll("[data-menu-label]")).map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["gregpriday.video-manager", "zeta"]);
  });

  it("dispatches the plugin's own action id with the clicked worktree and the surface source", () => {
    renderWorktreeMenu(
      {
        worktree: makeWorktree({ id: "/wt/a" }),
        pluginItems: [item("acme", "Do the thing", "acme.go")],
      },
      "context-menu"
    );

    fireEvent.click(screen.getByText("Do the thing"));

    expect(dispatch).toHaveBeenCalledWith(
      "acme.go",
      { worktreeId: "/wt/a" },
      { source: "context-menu" }
    );
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

  it("offers Label on the main worktree, which cannot be pinned", () => {
    renderWorktreeMenu({
      worktree: makeWorktree({ isMainWorktree: true }),
      onSetLabelColor: vi.fn(),
    });

    expect(screen.getByText("Organize")).not.toBeNull();
    expect(screen.getByText("Label")).not.toBeNull();
    expect(screen.queryByText("Pin to top")).toBeNull();
  });

  it("checks the current colour and dispatches only a change", () => {
    const onSetLabelColor = vi.fn();
    renderWorktreeMenu({ labelColor: "category-blue", onSetLabelColor });

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((r) => r.textContent?.trim())).toEqual([
      "None",
      "Teal",
      "Blue",
      "Violet",
      "Pink",
    ]);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(screen.getByText("Blue").closest("button")!.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByText("Blue"));
    expect(onSetLabelColor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Pink"));
    expect(onSetLabelColor).toHaveBeenLastCalledWith("category-pink");

    fireEvent.click(screen.getByText("None"));
    expect(onSetLabelColor).toHaveBeenLastCalledWith(null);
  });

  it("leads the Label submenu with Edit title…, above the colours", () => {
    const onEditTitle = vi.fn();
    renderWorktreeMenu({ onSetLabelColor: vi.fn(), onEditTitle });

    const editTitle = screen.getByText("Edit title…").closest("button")!;
    const firstColour = screen.getAllByRole("menuitemradio")[0]!;
    expect(
      editTitle.compareDocumentPosition(firstColour) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(editTitle);
    expect(onEditTitle).toHaveBeenCalledTimes(1);
  });

  it("offers Edit title… on the main worktree", () => {
    renderWorktreeMenu({
      worktree: makeWorktree({ isMainWorktree: true }),
      onSetLabelColor: vi.fn(),
      onEditTitle: vi.fn(),
    });

    expect(screen.getByText("Edit title…")).not.toBeNull();
  });

  it("checks None on an unlabelled worktree", () => {
    renderWorktreeMenu({ onSetLabelColor: vi.fn() });

    expect(screen.getByText("None").closest("button")!.getAttribute("aria-checked")).toBe("true");
  });

  it("omits the move rows for a card variant that cannot be reordered", () => {
    renderWorktreeMenu({ onToggleCollapse: vi.fn() });

    expect(screen.queryByText("Move up")).toBeNull();
    expect(screen.queryByText("Move down")).toBeNull();
  });
});

/**
 * A worktree with everything the Git submenu's start rows need: a base branch,
 * a known-clean tree, and something to integrate.
 *
 * `worktreeChanges` present with a zero count is deliberately NOT the same as
 * absent — absent means "status not read yet", which the rows must treat as
 * unknown rather than clean.
 */
function integrable(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return makeWorktree({
    baseBranchName: "develop",
    baseBehindCount: 3,
    worktreeChanges: {
      worktreeId: "wt-1",
      rootPath: "/repo/wt-1",
      changedFileCount: 0,
      changes: [],
    },
    ...overrides,
  } as Partial<WorktreeState>);
}

function gitRowLabels(container: HTMLElement): string[] {
  const sub = Array.from(container.querySelectorAll("[data-menu-sub]")).find((node) =>
    node.firstElementChild?.textContent?.trim().startsWith("Git")
  );
  if (!sub) return [];
  return Array.from(sub.querySelectorAll("[data-menu-subcontent] [data-menu-item]")).map(
    (node) => node.textContent?.trim() ?? ""
  );
}

function gitRow(container: HTMLElement, startsWith: string): HTMLButtonElement {
  const sub = Array.from(container.querySelectorAll("[data-menu-sub]")).find((node) =>
    node.firstElementChild?.textContent?.trim().startsWith("Git")
  )!;
  const row = Array.from(
    sub.querySelectorAll<HTMLButtonElement>("[data-menu-subcontent] [data-menu-item]")
  ).find((node) => (node.textContent ?? "").trim().startsWith(startsWith));
  if (!row) throw new Error(`no Git row starting with ${startsWith}`);
  return row;
}

describe("Git submenu — start rows", () => {
  it("names the base branch on both rows", () => {
    const { container } = renderWorktreeMenu({ worktree: integrable() });
    // Fetch and Fetch and prune lead the submenu (#12091) — the base-integration
    // rows are appended to that same array, not a submenu of their own.
    expect(gitRowLabels(container)).toEqual([
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto develop"),
      expect.stringContaining("Merge develop in"),
    ]);
  });

  it("shows the base-relative behind count, not the upstream one", () => {
    // `behindCount` measures against the branch's own upstream and says nothing
    // about the base having moved — the whole reason this feature exists.
    const { container } = renderWorktreeMenu({
      worktree: integrable({ baseBehindCount: 7, behindCount: 99 }),
    });
    expect(gitRow(container, "Rebase onto").textContent).toContain("7");
    expect(gitRow(container, "Rebase onto").textContent).not.toContain("99");
  });

  it("dispatches the rebase action with the worktree id and base branch", () => {
    const { container } = renderWorktreeMenu({ worktree: integrable() }, "context-menu");
    gitRow(container, "Rebase onto").click();
    expect(dispatch).toHaveBeenCalledWith(
      "git.rebaseOntoBase",
      { worktreeId: "wt-1", baseBranch: "develop" },
      { source: "context-menu" }
    );
  });

  it("dispatches the merge action with the worktree id and base branch", () => {
    const { container } = renderWorktreeMenu({ worktree: integrable() });
    gitRow(container, "Merge develop in").click();
    expect(dispatch).toHaveBeenCalledWith(
      "git.mergeBaseIntoBranch",
      { worktreeId: "wt-1", baseBranch: "develop" },
      { source: "menu" }
    );
  });

  it.each([
    ["no base branch", integrable({ baseBranchName: null }), "No base branch"],
    ["detached HEAD", integrable({ isDetached: true }), "No branch checked out"],
    [
      "uncommitted changes",
      integrable({
        worktreeChanges: {
          worktreeId: "wt-1",
          rootPath: "/repo/wt-1",
          changedFileCount: 2,
          changes: [],
        },
      } as Partial<WorktreeState>),
      "Commit or stash first",
    ],
    ["already up to date", integrable({ baseBehindCount: 0 }), "Up to date"],
  ])("disables both rows with a visible reason: %s", (_name, worktree, reason) => {
    const { container } = renderWorktreeMenu({ worktree });
    for (const label of ["Rebase onto", "Merge"]) {
      const row = gitRow(container, label);
      expect(row.disabled).toBe(true);
      expect(row.textContent).toContain(reason);
    }
  });

  it("treats an unread status as unknown rather than clean", () => {
    // `worktreeChanges == null` means the status pass has not answered yet.
    // Reading that as clean would offer a rebase that git then refuses.
    const { container } = renderWorktreeMenu({
      worktree: makeWorktree({ baseBranchName: "develop", baseBehindCount: 3 }),
    });
    const row = gitRow(container, "Rebase onto");
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain("Checking status");
  });

  it("dispatches nothing from a disabled row", () => {
    const { container } = renderWorktreeMenu({ worktree: integrable({ baseBehindCount: 0 }) });
    gitRow(container, "Rebase onto").click();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("Git submenu — recovery rows", () => {
  it.each([
    ["REBASING", "rebase"],
    ["MERGING", "merge"],
    ["CHERRY_PICKING", "cherry-pick"],
    ["REVERTING", "revert"],
  ] as const)("replaces the start rows for %s", (repoState, label) => {
    // A worktree mid-operation has exactly one useful next move, and it is not
    // "start another rebase" — the handler refuses that anyway.
    const { container } = renderWorktreeMenu({
      worktree: integrable({ repoState } as Partial<WorktreeState>),
    });
    const rows = gitRowLabels(container);
    // Fetch survives: it writes only remote-tracking refs, so it is safe and
    // useful mid-operation. Only the start rows are replaced.
    expect(rows).toEqual(["Fetch", "Fetch and prune", `Continue ${label}`, `Abort ${label}…`]);
    expect(rows.some((r) => r.includes("Rebase onto develop"))).toBe(false);
  });

  it("dispatches continue without an operation argument", () => {
    const { container } = renderWorktreeMenu({
      worktree: integrable({ repoState: "REBASING" } as Partial<WorktreeState>),
    });
    gitRow(container, "Continue").click();
    expect(dispatch).toHaveBeenCalledWith(
      "git.continueRepositoryOperation",
      { worktreeId: "wt-1" },
      { source: "menu" }
    );
  });

  it("passes the in-progress operation to abort, so the confirm can name it", () => {
    const { container } = renderWorktreeMenu({
      worktree: integrable({ repoState: "MERGING" } as Partial<WorktreeState>),
    });
    gitRow(container, "Abort").click();
    expect(dispatch).toHaveBeenCalledWith(
      "git.abortRepositoryOperation",
      { worktreeId: "wt-1", operation: "MERGING" },
      { source: "menu" }
    );
  });

  it("marks only Abort as destructive, and only it opens a dialog", () => {
    // Continue advances an operation the user already started and stays
    // abortable afterwards; abort is what discards their conflict work.
    const { container } = renderWorktreeMenu({
      worktree: integrable({ repoState: "REBASING" } as Partial<WorktreeState>),
    });
    expect(gitRow(container, "Abort").textContent).toContain("…");
    expect(gitRow(container, "Continue").textContent).not.toContain("…");
  });

  it("shows recovery rows even on a dirty tree", () => {
    // A halted operation is dirty by definition — conflicts ARE unstaged
    // changes — so the clean-tree gate must not reach these rows.
    const { container } = renderWorktreeMenu({
      worktree: integrable({
        repoState: "REBASING",
        worktreeChanges: {
          worktreeId: "wt-1",
          rootPath: "/repo/wt-1",
          changedFileCount: 4,
          changes: [],
        },
      } as Partial<WorktreeState>),
    });
    for (const label of ["Continue", "Abort"]) {
      expect(gitRow(container, label).disabled).toBe(false);
    }
  });
});

function gitRowMatching(name: RegExp): HTMLElement {
  const row = screen.getAllByRole("button").find((node) => name.test(node.textContent ?? ""));
  if (!row) throw new Error(`no Git row matching ${name.source}`);
  return row;
}

/** The harness renders menu items as plain `<button disabled>`. */
function isDisabled(row: HTMLElement): boolean {
  return row.hasAttribute("disabled");
}

/**
 * A completed status pass. Without one the menu treats the upstream as
 * unknown, which is a different state from having none.
 */
const measured = (tracking: string | null) => ({
  worktreeChanges: {
    worktreeId: "wt-1",
    rootPath: "/repo/wt-1",
    changes: [],
    changedFileCount: 0,
    tracking,
  } as WorktreeState["worktreeChanges"],
});

const gitCallbacks = () => ({
  onGitPullRebase: vi.fn(),
  onGitPush: vi.fn(),
  onGitForcePush: vi.fn(),
});

describe("WorktreeMenuItems Git submenu", () => {
  it("offers pull and push when the branch tracks an upstream", () => {
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ aheadCount: 3, behindCount: 1, ...measured("origin/feature") }),
    });

    expect(gitRowLabels(container)).toEqual([
      "Pull and rebase",
      "Push",
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
    ]);
    expect(isDisabled(gitRowMatching(/Pull and rebase/))).toBe(false);
    expect(isDisabled(gitRowMatching(/^Push$/))).toBe(false);
  });

  it("says why pull is unavailable rather than dropping the row", () => {
    // `GitStatusPass` leaves ahead/behind undefined when there is no tracking
    // branch, which is the same condition `requireRemoteTarget` throws on
    // server-side — so the row states it instead of offering a failing action.
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ ...measured(null) }),
    });

    const pull = gitRowMatching(/Pull and rebase/);
    expect(isDisabled(pull)).toBe(true);
    expect(pull.textContent).toContain("No upstream");
    // The reason is part of what the row says, so it reaches the accessible
    // name too — the Meta slot itself is aria-hidden decoration.
    expect(pull.getAttribute("aria-label")).toBe("Pull and rebase, no upstream");
    // The row states the reason instead of vanishing, so it is still one of the
    // rows alongside push, the two fetch rows and the two base-branch rows.
    expect(gitRowLabels(container)).toHaveLength(6);
  });

  it("disables both fetch rows for a repo with no remote, and says why", () => {
    renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ ...measured(null), hasRemote: false }),
    });

    for (const [pattern, label] of [
      [/^Fetch(No remote)?$/, "Fetch, no remote configured"],
      [/^Fetch and prune/, "Fetch and prune, no remote configured"],
    ] as const) {
      const row = gitRowMatching(pattern);
      expect(isDisabled(row)).toBe(true);
      expect(row.textContent).toContain("No remote");
      expect(row.getAttribute("aria-label")).toBe(label);
    }
  });

  it("keeps fetch live while the remotes are unread", () => {
    // Unknown is not "none": the click is how an unread repo finds out.
    renderWorktreeMenu({ ...gitCallbacks(), worktree: makeWorktree({ ...measured(null) }) });

    expect(isDisabled(gitRowMatching(/^Fetch$/))).toBe(false);
    expect(isDisabled(gitRowMatching(/^Fetch and prune$/))).toBe(false);
  });

  it("does not claim an upstream is missing before anything has looked", () => {
    // A card rendered before the first status pass knows nothing about the
    // upstream. Saying "No upstream" there states a fact nobody established;
    // the action's own error is the honest answer if it turns out to be true.
    renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ worktreeChanges: null }),
    });

    const pull = gitRowMatching(/Pull and rebase/);
    expect(isDisabled(pull)).toBe(false);
    expect(pull.textContent).not.toContain("No upstream");
  });

  it("keeps push live with no upstream, because the push establishes one", () => {
    // `handlePush` retries with `--set-upstream` on "no upstream branch", so
    // the first push of a new worktree branch is exactly the case this row has
    // to serve.
    renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ ...measured(null) }),
    });

    expect(isDisabled(gitRowMatching(/^Push$/))).toBe(false);
  });

  it("disables push when nothing is ahead", () => {
    renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ aheadCount: 0, behindCount: 4, ...measured("origin/feature") }),
    });

    const push = gitRowMatching(/Push/);
    expect(isDisabled(push)).toBe(true);
    expect(push.textContent).toContain("Nothing to push");
    expect(push.getAttribute("aria-label")).toBe("Push, nothing to push");
    // Pull is what this worktree can actually do, and it stays live — which is
    // also what keeps the trigger from opening onto an all-disabled submenu.
    expect(isDisabled(gitRowMatching(/Pull and rebase/))).toBe(false);
  });

  it("hides the force-push row until a lease has been captured", () => {
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ aheadCount: 2, ...measured("origin/feature") }),
    });

    // A lease cannot be derived from divergence — only a real push rejection
    // produces one — so a disabled row here would advertise a capability that
    // does not exist.
    expect(gitRowLabels(container).some((label) => /Force push/.test(label))).toBe(false);
  });

  it("offers force push once a lease is held", () => {
    const callbacks = gitCallbacks();
    const { container } = renderWorktreeMenu({
      ...callbacks,
      canForcePush: true,
      worktree: makeWorktree({ aheadCount: 2, ...measured("origin/feature") }),
    });

    expect(gitRowLabels(container)).toEqual([
      "Pull and rebase",
      "Push",
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
      "Force push with lease…",
    ]);
    gitRowMatching(/Force push/).click();
    expect(callbacks.onGitForcePush).toHaveBeenCalledWith("menu");
  });

  it("passes the resolved surface source to every row", () => {
    const callbacks = gitCallbacks();
    renderWorktreeMenu({ ...callbacks, worktree: makeWorktree({ aheadCount: 1 }) }, "context-menu");

    gitRowMatching(/Pull and rebase/).click();
    gitRowMatching(/^Push$/).click();
    expect(callbacks.onGitPullRebase).toHaveBeenCalledWith("context-menu");
    expect(callbacks.onGitPush).toHaveBeenCalledWith("context-menu");
  });

  it("is absent on a detached worktree", () => {
    // The status pass only overwrites `branch` when it reads a new one, so a
    // detached worktree keeps the name it had before — every row here would
    // name a branch that is not checked out.
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({
        branch: "feature",
        isDetached: true,
        aheadCount: 2,
        ...measured("origin/feature"),
      }),
    });

    // Fetch survives — it only moves remote-tracking refs, so it needs no
    // checked-out branch — which is why the group itself stays (#12099).
    expect(rootRowLabels(container)).toContain("Git");
    expect(gitRowLabels(container)).toEqual([
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
    ]);
  });

  it("gives the main worktree the same rows", () => {
    // It is a real checkout on a real branch; nothing about pushing it differs.
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({
        isMainWorktree: true,
        aheadCount: 2,
        behindCount: 1,
        ...measured("origin/main"),
      }),
    });

    expect(gitRowLabels(container)).toEqual([
      "Pull and rebase",
      "Push",
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
    ]);
  });
});

const onBranch = () => makeWorktree({ branch: "feature/copy-branch-name" });

describe("WorktreeMenuItems — Copy → Branch name (#11930)", () => {
  it("offers the item for a worktree checked out on a branch", () => {
    renderWorktreeMenu({ worktree: onBranch() });

    expect(screen.queryByText("Branch name")).not.toBeNull();
  });

  it("withholds the item when the worktree reports no branch", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ branch: undefined }) });

    expect(screen.queryByText("Branch name")).toBeNull();
  });

  it("withholds the item on a detached HEAD still carrying its pre-detach branch", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ isDetached: true }) });

    expect(screen.queryByText("Branch name")).toBeNull();
  });

  it("invokes the supplied callback when the item is chosen", () => {
    const onCopyBranchName = vi.fn();
    renderWorktreeMenu({ worktree: onBranch(), onCopyBranchName });

    fireEvent.click(screen.getByText("Branch name"));

    expect(onCopyBranchName).toHaveBeenCalledTimes(1);
  });

  it("places the item directly under Path, so the two copy targets read together", () => {
    renderWorktreeMenu({ worktree: onBranch() });

    // Sibling order, not button indices: an index comparison stays green if a
    // separator or label gets inserted between the two, since neither renders
    // as a button.
    const path = screen.getByText("Path");
    const branch = screen.getByText("Branch name");

    expect(path.nextElementSibling).toBe(branch);
  });

  it("gathers every clipboard route under one Copy submenu", () => {
    const { container } = renderWorktreeMenu({ worktree: onBranch() });

    const copySub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (sub) => sub.firstElementChild?.textContent?.trim() === "Copy"
    );
    const labels = Array.from(copySub?.querySelectorAll("[data-menu-item]") ?? []).map(
      (el) => el.textContent
    );

    expect(labels).toEqual(["Full context", "Modified files only", "Path", "Branch name"]);
  });
});

function withChanges(count: number): Partial<WorktreeState> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- WorktreeChanges carries per-file git metadata the menu never reads; only the list length reaches the row.
  const worktreeChanges = {
    changedFileCount: count,
    changes: Array.from({ length: count }, (_, i) => ({ path: `file-${i}.ts` })),
  } as WorktreeState["worktreeChanges"];
  return { worktreeChanges };
}

describe("WorktreeMenuItems — View uncommitted changes (#11420)", () => {
  it("omits the item when no callback is supplied", () => {
    renderWorktreeMenu();

    expect(screen.queryByText("View uncommitted changes")).toBeNull();
  });

  it("renders the item when a callback is supplied", () => {
    renderWorktreeMenu({ onOpenChanges: vi.fn() });

    expect(screen.queryByText("View uncommitted changes")).not.toBeNull();
  });

  it("invokes the supplied callback when the item is chosen", () => {
    const onOpenChanges = vi.fn();
    renderWorktreeMenu({ onOpenChanges });

    fireEvent.click(screen.getByText("View uncommitted changes"));

    expect(onOpenChanges).toHaveBeenCalledTimes(1);
  });

  it("sits inside Review, after the hub, so the hub reads as the entry point", () => {
    const { container } = renderWorktreeMenu({
      onOpenChanges: vi.fn(),
      onOpenReviewHub: vi.fn(),
      onCompareDiff: vi.fn(),
    });

    // Scoped to the Review submenu: a global index comparison would stay green
    // if the row escaped into a different submenu that happens to render later.
    const reviewSub = Array.from(container.querySelectorAll("[data-menu-sub]")).find(
      (node) => node.firstElementChild?.textContent?.trim() === "Review"
    );
    const labels = Array.from(reviewSub?.querySelectorAll("[data-menu-item]") ?? []).map((el) =>
      el.textContent?.replace(/\d+$/, "")
    );

    expect(labels).toEqual([
      "Review worktree",
      "View uncommitted changes",
      "Compare with another worktree…",
    ]);
  });

  it("carries the changed-file count into the accessible name, not just the muted slot", () => {
    renderWorktreeMenu({ onOpenChanges: vi.fn(), worktree: makeWorktree(withChanges(3)) });

    expect(screen.queryByLabelText("View uncommitted changes, 3")).not.toBeNull();
  });

  it("drops the whole Review submenu when no review route applies", () => {
    renderWorktreeMenu();

    expect(screen.queryByText("Review")).toBeNull();
  });
});

describe("WorktreeMenuItems — Park agents / Unpark agents (#13236)", () => {
  const liveCounts = { ...zeroCounts, active: 3, all: 3, grid: 3 };

  function item(name: string): HTMLButtonElement {
    return screen.getByRole("button", { name: new RegExp(`^${name}, \\d+$`) }) as HTMLButtonElement;
  }

  it("counts each row by the agents it would change", () => {
    renderWorktreeMenu({
      counts: liveCounts,
      parking: { parked: 1, unparked: 2 },
      onParkAgents: vi.fn(),
      onUnparkAgents: vi.fn(),
    });

    expect(item("Park agents").getAttribute("aria-label")).toBe("Park agents, 2");
    expect(item("Unpark agents").getAttribute("aria-label")).toBe("Unpark agents, 1");
    expect(item("Park agents").disabled).toBe(false);
    expect(item("Unpark agents").disabled).toBe(false);
  });

  it("runs the matching callback with no confirmation step", () => {
    const onParkAgents = vi.fn();
    const onUnparkAgents = vi.fn();
    renderWorktreeMenu({
      counts: liveCounts,
      parking: { parked: 1, unparked: 2 },
      onParkAgents,
      onUnparkAgents,
    });

    fireEvent.click(item("Park agents"));
    fireEvent.click(item("Unpark agents"));

    expect(onParkAgents).toHaveBeenCalledTimes(1);
    expect(onUnparkAgents).toHaveBeenCalledTimes(1);
  });

  it("disables the side with nothing to change but keeps the inverse visible", () => {
    renderWorktreeMenu({
      counts: liveCounts,
      parking: { parked: 0, unparked: 2 },
      onParkAgents: vi.fn(),
      onUnparkAgents: vi.fn(),
    });

    expect(item("Park agents").disabled).toBe(false);
    expect(item("Unpark agents").disabled).toBe(true);
  });

  it("omits the group when the worktree has no agents on the fleet", () => {
    renderWorktreeMenu({
      counts: liveCounts,
      parking: { parked: 0, unparked: 0 },
      onParkAgents: vi.fn(),
      onUnparkAgents: vi.fn(),
    });

    expect(screen.queryByText("Park agents")).toBeNull();
    expect(screen.queryByText("Parking")).toBeNull();
  });

  it("omits the group for a caller that passes no parking state", () => {
    renderWorktreeMenu({ counts: liveCounts });

    expect(screen.queryByText("Park agents")).toBeNull();
  });

  it("omits the group on a workspace root", () => {
    renderWorkspaceRootMenu({
      parking: { parked: 1, unparked: 1 },
      onParkAgents: vi.fn(),
      onUnparkAgents: vi.fn(),
    });

    expect(screen.queryByText("Park agents")).toBeNull();
  });
});

describe("WorktreeMenuItems — pin suppression for external worktrees (#11434)", () => {
  it("offers the pin action for an internal non-main worktree", () => {
    renderWorktreeMenu({ worktree: makeWorktree(), onTogglePin: vi.fn() });

    expect(screen.queryByText("Pin to top")).not.toBeNull();
  });

  it("withholds the pin action for an external worktree even when a callback is supplied", () => {
    // Sorting already sinks external worktrees below the pinned area, so an
    // offered pin command would be a no-op the user can't explain.
    renderWorktreeMenu({ worktree: makeWorktree({ isExternal: true }), onTogglePin: vi.fn() });

    expect(screen.queryByText("Pin to top")).toBeNull();
  });

  it("withholds the unpin action for an external worktree carrying a stale pin", () => {
    renderWorktreeMenu({
      worktree: makeWorktree({ isExternal: true }),
      onTogglePin: vi.fn(),
      isPinned: true,
    });

    expect(screen.queryByText("Unpin")).toBeNull();
  });

  it("keeps offering the pin action when classification is unknown", () => {
    renderWorktreeMenu({ worktree: makeWorktree({ isExternal: undefined }), onTogglePin: vi.fn() });

    expect(screen.queryByText("Pin to top")).not.toBeNull();
  });

  it("withholds the pin action for the main worktree", () => {
    renderWorktreeMenu({
      worktree: makeWorktree({ isMainWorktree: true }),
      onTogglePin: vi.fn(),
    });

    expect(screen.queryByText("Pin to top")).toBeNull();
  });

  it("drops the whole Organize submenu when nothing about the card can be organized", () => {
    // External + no collapse + no move rows: an Organize trigger opening onto
    // nothing is worse than no trigger.
    renderWorktreeMenu({ worktree: makeWorktree({ isExternal: true }), onTogglePin: vi.fn() });

    expect(screen.queryByText("Organize")).toBeNull();
  });
});

// The menu body with no worktree — the ⋯ and right-click menus of a scratch or
// a folder opened without git (#13225). Git- and worktree-shaped groups must be
// absent rather than disabled (#11499), and the body enforces that itself, so
// these render with every worktree-only callback wired to prove a careless
// caller can't bring a dead row back.
/** Every worktree-only prop a card would pass, handed to a root by mistake. */
function worktreeOnlyProps() {
  return {
    counts: { grid: 2, dock: 1, active: 3, completed: 0, all: 3, waiting: 1, working: 2 },
    onCopyContextModified: vi.fn(),
    onCopyBranchName: vi.fn(),
    onOpenReviewHub: vi.fn(),
    onOpenChanges: vi.fn(),
    onCompareDiff: vi.fn(),
    onGitPullRebase: vi.fn(),
    onGitPush: vi.fn(),
    onGitForcePush: vi.fn(),
    canForcePush: true,
    onSaveLayout: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleCollapse: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onViewPlan: vi.fn(),
    onAttachIssue: vi.fn(),
    onOpenIssueExternal: vi.fn(),
    onDeleteWorktree: vi.fn(),
    onDockAll: vi.fn(),
    onMaximizeAll: vi.fn(),
    onResetRenderers: vi.fn(),
    onSelectAllAgents: vi.fn(),
    onSelectWaitingAgents: vi.fn(),
    onSelectWorkingAgents: vi.fn(),
    onCloseAll: vi.fn(),
    onTerminateAll: vi.fn(),
    onClearHistory: vi.fn(),
    hasResourceConfig: true,
    worktreeMode: "remote",
    resourceEnvironmentKeys: ["remote"],
    onSwitchEnvironment: vi.fn(),
    onResourceStatus: vi.fn(),
    onResourceTeardown: vi.fn(),
    devServerState: "running" as const,
    onStartDevServer: vi.fn(),
    onStopDevServer: vi.fn(),
    onRestartDevServer: vi.fn(),
    pluginItems: [
      {
        pluginId: "acme",
        item: { actionId: "acme.thing", label: "Acme thing", location: "worktree" as const },
      },
    ],
  };
}

function itemLabels(): string[] {
  return screen.getAllByRole("button").map((el) => el.textContent?.trim() ?? "");
}

describe("WorktreeMenuItems — workspace root", () => {
  it("carries only Launch, Open and Copy when there are no recipes", () => {
    const { container } = renderWorkspaceRootMenu({ onOpenEditor: vi.fn() });

    expect(rootRowLabels(container)).toEqual(["Launch", "Open", "Copy"]);
    expect(rootSeparatorCount(container)).toBe(1);
  });

  it("adds Recipes beside Launch's group only when there is one to run", () => {
    const { container } = renderWorkspaceRootMenu({ recipes: [{ id: "r1", name: "Two agents" }] });

    expect(rootRowLabels(container)).toEqual(["Launch", "Open", "Recipes", "Copy"]);
    expect(rootSeparatorCount(container)).toBe(2);
  });

  it("withholds every worktree-shaped group even when its callbacks are wired", () => {
    const { container } = renderWorkspaceRootMenu({
      ...worktreeOnlyProps(),
      recipes: [{ id: "r1", name: "Two agents" }],
    });

    expect(rootRowLabels(container)).toEqual(["Launch", "Open", "Recipes", "Copy"]);
    const labels = itemLabels();
    for (const forbidden of [
      "Review",
      "Git",
      "Fetch",
      "Sessions",
      "Runtime",
      "Linked work",
      "Organize",
      "Extensions",
      "Delete worktree…",
      "Modified files only",
      "Branch name",
      "Save current layout as recipe…",
    ]) {
      expect(labels).not.toContain(forbidden);
    }
  });

  it("offers exactly Full context and Path under Copy", () => {
    const onCopyContextFull = vi.fn();
    const onCopyPath = vi.fn();
    renderWorkspaceRootMenu({ ...worktreeOnlyProps(), onCopyContextFull, onCopyPath });

    const copy = screen.getByRole("button", { name: "Copy" }).parentElement!;
    const rows = Array.from(copy.querySelectorAll("[data-menu-item]")).map((el) =>
      el.textContent?.trim()
    );
    expect(rows).toEqual(["Full context", "Path"]);

    fireEvent.click(screen.getByRole("button", { name: "Full context" }));
    fireEvent.click(screen.getByRole("button", { name: "Path" }));
    expect(onCopyContextFull).toHaveBeenCalledTimes(1);
    expect(onCopyPath).toHaveBeenCalledTimes(1);
  });

  it("offers Open in editor only when the caller wires it", () => {
    renderWorkspaceRootMenu({ onOpenFileBrowser: vi.fn() });
    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
    expect(screen.getByRole("button", { name: "Browse files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: fileManagerRevealLabel() })).toBeTruthy();
    cleanup();

    const onOpenEditor = vi.fn();
    renderWorkspaceRootMenu({ onOpenEditor });
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
  });

  it("launches through the caller and hands the palette the resolved surface", () => {
    const onLaunchAgent = vi.fn();
    const onOpenPanelPalette = vi.fn();
    renderWorkspaceRootMenu(
      {
        launchAgents: [{ id: "claude", name: "Claude", isEnabled: true }],
        onLaunchAgent,
        onOpenPanelPalette,
      },
      "context-menu"
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "More agents and panels…" }));

    expect(onLaunchAgent.mock.calls).toEqual([["claude"], ["terminal"]]);
    expect(onOpenPanelPalette).toHaveBeenCalledWith("context-menu");
  });

  it("runs a recipe by id and dispatches no git action", () => {
    const onRunRecipe = vi.fn();
    renderWorkspaceRootMenu({ recipes: [{ id: "r1", name: "Two agents" }], onRunRecipe });

    fireEvent.click(screen.getByRole("button", { name: "Two agents" }));

    expect(onRunRecipe).toHaveBeenCalledWith("r1");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
