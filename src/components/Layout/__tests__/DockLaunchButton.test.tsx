// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

let mockRecipes: Array<{
  id: string;
  name: string;
  worktreeId?: string;
}> = [];
let mockMruEntries: Array<{ id: string; score: number; lastAccessedAt: number }> = [];
const runRecipeWithResultsMock = vi.fn();
const notifySpawnFailuresMock = vi.fn();
const actionDispatchMock = vi.fn();
const recordActionMruMock = vi.fn();
let dropdownCloseAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let dropdownPointerDownOutsideSpy: (() => void) | null = null;

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(
    (selector: (s: { recipes: typeof mockRecipes }) => unknown) =>
      selector({ recipes: mockRecipes }),
    {
      getState: () => ({ runRecipeWithResults: runRecipeWithResultsMock }),
    }
  ),
}));

vi.mock("@/utils/recipeNotify", () => ({
  notifyRecipeSpawnFailures: (...args: unknown[]) => notifySpawnFailuresMock(...args),
}));

const logErrorMock = vi.fn();
vi.mock("@/utils/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/logger")>()),
  logError: (...args: unknown[]) => logErrorMock(...args),
}));

vi.mock("@/store/actionMruStore", () => ({
  useActionMruStore: Object.assign(
    (selector: (s: { getSortedActionMruList: () => typeof mockMruEntries }) => unknown) =>
      selector({ getSortedActionMruList: () => mockMruEntries }),
    {
      getState: () => ({ recordActionMru: recordActionMruMock }),
    }
  ),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => actionDispatchMock(...args),
  },
}));

// Mock UI primitives so the test focuses on this component's behavior, not
// Radix's pointer-event semantics inside jsdom. Mirrors AgentButton.test.tsx.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
    onPointerDownOutside,
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (e: { preventDefault: () => void }) => void;
    onPointerDownOutside?: () => void;
  }) => {
    dropdownCloseAutoFocusSpy = onCloseAutoFocus ?? null;
    dropdownPointerDownOutsideSpy = onPointerDownOutside ?? null;
    return <div data-testid="dock-launcher-content">{children}</div>;
  },
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    title,
    className,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    title?: string;
    className?: string;
  }) => (
    <button
      type="button"
      onClick={() => onSelect?.()}
      disabled={disabled}
      title={title}
      className={className}
    >
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div data-testid="dock-launcher-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="dock-launcher-separator" />,
}));

import { DockLaunchButton } from "../DockLaunchButton";
import type { DockLaunchAgent } from "../DockLaunchMenuItems";

const AGENTS: DockLaunchAgent[] = [
  { id: "claude", name: "Claude", availability: "ready" },
  { id: "gemini", name: "Gemini", availability: "blocked" },
];

beforeEach(() => {
  mockRecipes = [];
  mockMruEntries = [];
  runRecipeWithResultsMock.mockReset().mockResolvedValue({
    spawned: [{ index: 0, terminalId: "t-0" }],
    failed: [],
  });
  notifySpawnFailuresMock.mockReset();
  logErrorMock.mockReset();
  actionDispatchMock.mockReset();
  recordActionMruMock.mockReset();
  dropdownCloseAutoFocusSpy = null;
  dropdownPointerDownOutsideSpy = null;
});

describe("DockLaunchButton", () => {
  it("renders a launch button with accessible label", () => {
    const { getByLabelText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );
    expect(getByLabelText("Launch panel")).toBeTruthy();
  });

  it("renders sectioned labels for agents, panels, and recipes", () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];

    const { getAllByTestId } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
    expect(labels).toEqual(["Launch agent", "Launch panel", "Launch recipe"]);
  });

  it("splits agents into Pinned/Other groups when pinnedCount is a strict subset", () => {
    const { getAllByTestId, container } = render(
      <DockLaunchButton
        agents={AGENTS}
        pinnedCount={1}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
    expect(labels).toEqual(["Pinned", "Other", "Launch panel", "Launch recipe"]);

    // Assert document order so a regression that puts both agents under one
    // group (or swaps them) is caught: Pinned → Claude → Other → Gemini.
    const text = container.textContent ?? "";
    expect(text.indexOf("Pinned")).toBeLessThan(text.indexOf("Claude"));
    expect(text.indexOf("Claude")).toBeLessThan(text.indexOf("Other"));
    expect(text.indexOf("Other")).toBeLessThan(text.indexOf("Gemini"));
  });

  it("keeps a flat Launch agent group when all agents are pinned", () => {
    const { getAllByTestId } = render(
      <DockLaunchButton
        agents={AGENTS}
        pinnedCount={AGENTS.length}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
    expect(labels).toEqual(["Launch agent", "Launch panel", "Launch recipe"]);
  });

  it("invokes onLaunchAgent for a launchable agent", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={onLaunchAgent}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    fireEvent.click(getByText("Claude"));
    expect(onLaunchAgent).toHaveBeenCalledWith("claude");
    expect(actionDispatchMock).not.toHaveBeenCalled();
    // The dock launch path must record MRU so the agent surfaces in the
    // recency band on the next open (previously this path recorded nothing).
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.claude");
  });

  it("routes non-launchable agent clicks to the agent settings subtab", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={onLaunchAgent}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    fireEvent.click(getByText("Gemini"));
    expect(onLaunchAgent).not.toHaveBeenCalled();
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents", subtab: "gemini" },
      { source: "menu" }
    );
    // A settings redirect is not a launch — it must not pollute the band.
    expect(recordActionMruMock).not.toHaveBeenCalled();
  });

  it("discriminates tooltip copy between blocked and installed-only agents", () => {
    const { getByText } = render(
      <DockLaunchButton
        agents={[
          { id: "claude", name: "Claude", availability: "ready" },
          { id: "gemini", name: "Gemini", availability: "blocked" },
          { id: "codex", name: "Codex", availability: "installed" },
        ]}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    // Launchable: no tooltip override on the row itself.
    expect(getByText("Claude").getAttribute("title")).toBeNull();
    // Blocked: endpoint-security copy.
    expect(getByText("Gemini").getAttribute("title")).toBe(
      "Gemini is blocked by endpoint security. Click to configure."
    );
    // Installed but not launchable (e.g. WSL): generic setup copy.
    expect(getByText("Codex").getAttribute("title")).toBe("Codex needs setup. Click to configure.");
  });

  it("dims non-launchable agent rows with opacity-70", () => {
    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    expect(getByText("Claude").className).not.toContain("opacity-70");
    expect(getByText("Gemini").className).toContain("opacity-70");
  });

  it("treats unauthenticated agents as launchable (CLI handles auth at runtime)", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = render(
      <DockLaunchButton
        agents={[{ id: "codex", name: "Codex", availability: "unauthenticated" }]}
        hasDevPreview={false}
        onLaunchAgent={onLaunchAgent}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    fireEvent.click(getByText("Codex"));
    expect(onLaunchAgent).toHaveBeenCalledWith("codex");
    expect(actionDispatchMock).not.toHaveBeenCalled();
    // Soft dim and settings tooltip must not leak onto a launchable row.
    expect(getByText("Codex").className).not.toContain("opacity-70");
    expect(getByText("Codex").getAttribute("title")).toBeNull();
  });

  it("keeps non-launchable rows selectable (no disabled attribute)", () => {
    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    // Regression guard: the pre-fix behavior was a disabled, dead-end row.
    expect(getByText("Gemini").hasAttribute("disabled")).toBe(false);
  });

  it("offers Terminal and browser but gates non-dockable kinds (dev preview) out of the dock launcher (#11054)", () => {
    // The dock launcher creates panels directly in the dock, so it must only
    // offer kinds the dock can render, gating on the shared `panelKindIsDockable`
    // predicate. Terminal is a PTY kind — always dockable, always offered. Browser
    // is dockable since #11058, so it appears here. Dev preview can't render in the
    // dock, so — even with hasDevPreview — it stays hidden, matching the `addPanel`
    // redirect.
    const onLaunchAgent = vi.fn();
    const { getByText, queryByText } = render(
      <DockLaunchButton
        agents={[]}
        hasDevPreview
        onLaunchAgent={onLaunchAgent}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    expect(getByText("Terminal")).toBeTruthy();
    fireEvent.click(getByText("Terminal"));
    expect(onLaunchAgent).toHaveBeenLastCalledWith("terminal");

    expect(getByText("Browser")).toBeTruthy();
    expect(queryByText("Dev preview")).toBeNull();
  });

  it("shows a No recipes yet discovery cue when no recipes match the active worktree", () => {
    mockRecipes = [];
    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/tmp"
      />
    );
    // The recipe section now always renders so first-run users can discover it.
    expect(getByText("Launch recipe")).toBeTruthy();
    expect(getByText("No recipes yet")).toBeTruthy();
  });

  it("dispatches recipe.editor.open from the No recipes yet cue", () => {
    mockRecipes = [];
    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/tmp"
      />
    );

    fireEvent.click(getByText("No recipes yet"));
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "recipe.editor.open",
      { worktreeId: "wt-1" },
      { source: "menu" }
    );
  });

  it("falls back to the recipe manager from the cue when no worktree is active", () => {
    // recipe.editor.open's handler hard-requires a string worktreeId and
    // silently no-ops on undefined — the common first-run case has no active
    // worktree, so the cue must route to the manager instead of dead-ending.
    mockRecipes = [];
    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    fireEvent.click(getByText("No recipes yet"));
    expect(actionDispatchMock).toHaveBeenCalledWith("recipe.manager.open", {}, { source: "menu" });
    expect(actionDispatchMock).not.toHaveBeenCalledWith(
      "recipe.editor.open",
      expect.anything(),
      expect.anything()
    );
  });

  it("does not render the No recipes yet cue when recipes exist", () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    const { queryByText, getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/tmp"
      />
    );
    expect(getByText("My recipe")).toBeTruthy();
    expect(queryByText("No recipes yet")).toBeNull();
  });

  it("lists project-wide recipes and recipes scoped to the active worktree", () => {
    mockRecipes = [
      { id: "r-global", name: "Project recipe", worktreeId: undefined },
      { id: "r-wt", name: "Worktree recipe", worktreeId: "wt-1" },
      { id: "r-other", name: "Other worktree recipe", worktreeId: "wt-2" },
    ];

    const { getByText, queryByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/tmp"
      />
    );

    expect(getByText("Project recipe")).toBeTruthy();
    expect(getByText("Worktree recipe")).toBeTruthy();
    expect(queryByText("Other worktree recipe")).toBeNull();
  });

  it("calls preventDefault on pointer close so the trigger does not keep its focus ring (issue #6119)", () => {
    render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );
    expect(dropdownCloseAutoFocusSpy).toBeTruthy();
    expect(dropdownPointerDownOutsideSpy).toBeTruthy();

    // Keyboard close (no prior pointer-down-outside) must NOT preventDefault
    // — focus restoration is required for WAI-ARIA Escape/Enter.
    const keyboardPreventDefault = vi.fn();
    dropdownCloseAutoFocusSpy!({ preventDefault: keyboardPreventDefault });
    expect(keyboardPreventDefault).not.toHaveBeenCalled();

    // Pointer close suppresses the focus ring.
    dropdownPointerDownOutsideSpy!();
    const pointerPreventDefault = vi.fn();
    dropdownCloseAutoFocusSpy!({ preventDefault: pointerPreventDefault });
    expect(pointerPreventDefault).toHaveBeenCalledTimes(1);

    // The pointer flag must reset after one onCloseAutoFocus or a later
    // keyboard-driven close would inherit suppression and break focus return.
    const resetPreventDefault = vi.fn();
    dropdownCloseAutoFocusSpy!({ preventDefault: resetPreventDefault });
    expect(resetPreventDefault).not.toHaveBeenCalled();
  });

  it("invokes runRecipeWithResults with cwd, worktreeId, and recipe context when a recipe is selected", async () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];

    const recipeContext = {
      issueNumber: 42,
      prNumber: 100,
      branchName: "feature/abc",
      worktreePath: "/path/to/wt",
    };

    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/path/to/wt"
        recipeContext={recipeContext}
      />
    );

    fireEvent.click(getByText("My recipe"));
    expect(runRecipeWithResultsMock).toHaveBeenCalledWith(
      "r-1",
      "/path/to/wt",
      "wt-1",
      recipeContext
    );
    // Spawn results route through the failure notifier (which no-ops on success).
    await waitFor(() =>
      expect(notifySpawnFailuresMock).toHaveBeenCalledWith(
        { spawned: [{ index: 0, terminalId: "t-0" }], failed: [] },
        { recipeName: "My recipe" }
      )
    );
  });

  it("surfaces spawn failures from dock-launched recipes via the notifier", async () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    const results = {
      spawned: [],
      failed: [{ index: 0, error: "Panel limit reached" }],
    };
    runRecipeWithResultsMock.mockResolvedValue(results);

    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    fireEvent.click(getByText("My recipe"));
    await waitFor(() =>
      expect(notifySpawnFailuresMock).toHaveBeenCalledWith(results, { recipeName: "My recipe" })
    );
  });

  it("logs dock recipe launch rejections without notifying", async () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    runRecipeWithResultsMock.mockRejectedValue(new Error("recipe gone"));

    const { getByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    fireEvent.click(getByText("My recipe"));
    await waitFor(() =>
      expect(logErrorMock).toHaveBeenCalledWith("Recipe launch from dock failed", expect.any(Error))
    );
    expect(notifySpawnFailuresMock).not.toHaveBeenCalled();
  });

  describe("Recently launched band", () => {
    const MANY: DockLaunchAgent[] = [
      { id: "claude", name: "Claude", availability: "ready" },
      { id: "gemini", name: "Gemini", availability: "ready" },
      { id: "codex", name: "Codex", availability: "ready" },
      { id: "cursor", name: "Cursor", availability: "ready" },
    ];

    it("hides the band when the MRU is empty", () => {
      mockMruEntries = [];
      const { queryByText } = render(
        <DockLaunchButton
          agents={MANY}
          hasDevPreview={false}
          onLaunchAgent={vi.fn()}
          activeWorktreeId={null}
          cwd="/tmp"
        />
      );
      expect(queryByText("Recently launched")).toBeNull();
    });

    it("renders recent agents in frecency order, capped at 3", () => {
      // Pre-sorted as getSortedActionMruList would return them; the component
      // does not re-sort. Four entries, cap is 3 — Gemini (4th) is dropped.
      mockMruEntries = [
        { id: "agent.claude", score: 4, lastAccessedAt: 4000 },
        { id: "agent.codex", score: 3, lastAccessedAt: 3000 },
        { id: "agent.cursor", score: 2, lastAccessedAt: 2000 },
        { id: "agent.gemini", score: 1, lastAccessedAt: 1000 },
      ];

      const { getByText, getAllByText, getAllByTestId, container } = render(
        <DockLaunchButton
          agents={MANY}
          hasDevPreview={false}
          onLaunchAgent={vi.fn()}
          activeWorktreeId={null}
          cwd="/tmp"
        />
      );

      // Band header leads the menu.
      const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
      expect(labels[0]).toBe("Recently launched");
      expect(getByText("Recently launched")).toBeTruthy();

      // Band entries are duplicated below in the flat agent group — the band is
      // a shortcut, not a replacement grouping. Capped entries appear twice;
      // the dropped 4th appears only once (in the group).
      expect(getAllByText("Claude").length).toBe(2);
      expect(getAllByText("Codex").length).toBe(2);
      expect(getAllByText("Cursor").length).toBe(2);
      expect(getAllByText("Gemini").length).toBe(1);

      // First occurrence of each name is its band row (band renders first), so
      // first-occurrence order reflects the band's frecency order.
      const text = container.textContent ?? "";
      expect(text.indexOf("Claude")).toBeLessThan(text.indexOf("Codex"));
      expect(text.indexOf("Codex")).toBeLessThan(text.indexOf("Cursor"));
    });

    it("excludes never-launched cold-start entries (lastAccessedAt === 0)", () => {
      mockMruEntries = [{ id: "agent.claude", score: 5, lastAccessedAt: 0 }];
      const { queryByText } = render(
        <DockLaunchButton
          agents={MANY}
          hasDevPreview={false}
          onLaunchAgent={vi.fn()}
          activeWorktreeId={null}
          cwd="/tmp"
        />
      );
      expect(queryByText("Recently launched")).toBeNull();
    });

    it("ignores non-agent MRU entries", () => {
      mockMruEntries = [{ id: "recipe.editor.open", score: 5, lastAccessedAt: 5000 }];
      const { queryByText } = render(
        <DockLaunchButton
          agents={MANY}
          hasDevPreview={false}
          onLaunchAgent={vi.fn()}
          activeWorktreeId={null}
          cwd="/tmp"
        />
      );
      expect(queryByText("Recently launched")).toBeNull();
    });

    it("drops stale MRU entries for agents no longer present", () => {
      mockMruEntries = [{ id: "agent.ghost", score: 5, lastAccessedAt: 5000 }];
      const { queryByText } = render(
        <DockLaunchButton
          agents={MANY}
          hasDevPreview={false}
          onLaunchAgent={vi.fn()}
          activeWorktreeId={null}
          cwd="/tmp"
        />
      );
      expect(queryByText("Recently launched")).toBeNull();
    });

    it("launching a band row records MRU and invokes onLaunchAgent", () => {
      mockMruEntries = [{ id: "agent.codex", score: 3, lastAccessedAt: 3000 }];
      const onLaunchAgent = vi.fn();
      const { getAllByText } = render(
        <DockLaunchButton
          agents={MANY}
          hasDevPreview={false}
          onLaunchAgent={onLaunchAgent}
          activeWorktreeId={null}
          cwd="/tmp"
        />
      );

      // First "Codex" is the band row.
      const codexElement = getAllByText("Codex")[0];
      expect(codexElement).toBeDefined();
      fireEvent.click(codexElement!);
      expect(onLaunchAgent).toHaveBeenCalledWith("codex");
      expect(recordActionMruMock).toHaveBeenCalledWith("agent.codex");
    });
  });
});
