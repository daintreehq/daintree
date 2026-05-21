// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

let mockRecipes: Array<{
  id: string;
  name: string;
  worktreeId?: string;
}> = [];
const runRecipeMock = vi.fn();
const actionDispatchMock = vi.fn();
let dropdownCloseAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let dropdownPointerDownOutsideSpy: (() => void) | null = null;

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(
    (selector: (s: { recipes: typeof mockRecipes }) => unknown) =>
      selector({ recipes: mockRecipes }),
    {
      getState: () => ({ runRecipe: runRecipeMock }),
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
  runRecipeMock.mockReset();
  actionDispatchMock.mockReset();
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

  it("always exposes Terminal and Browser, gates Dev preview on hasDevPreview", () => {
    const onLaunchAgent = vi.fn();
    const { getByText, queryByText, rerender } = render(
      <DockLaunchButton
        agents={[]}
        hasDevPreview={false}
        onLaunchAgent={onLaunchAgent}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    expect(getByText("Terminal")).toBeTruthy();
    expect(getByText("Browser")).toBeTruthy();
    expect(queryByText("Dev preview")).toBeNull();

    fireEvent.click(getByText("Terminal"));
    expect(onLaunchAgent).toHaveBeenLastCalledWith("terminal");

    fireEvent.click(getByText("Browser"));
    expect(onLaunchAgent).toHaveBeenLastCalledWith("browser");

    rerender(
      <DockLaunchButton
        agents={[]}
        hasDevPreview
        onLaunchAgent={onLaunchAgent}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    fireEvent.click(getByText("Dev preview"));
    expect(onLaunchAgent).toHaveBeenLastCalledWith("dev-preview");
  });

  it("hides the recipe section when no recipes match the active worktree", () => {
    mockRecipes = [];
    const { queryByText } = render(
      <DockLaunchButton
        agents={AGENTS}
        hasDevPreview={false}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/tmp"
      />
    );
    expect(queryByText("Launch recipe")).toBeNull();
    expect(queryByText("No recipes")).toBeNull();
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

  it("invokes runRecipe with cwd, worktreeId, and recipe context when a recipe is selected", () => {
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
    expect(runRecipeMock).toHaveBeenCalledWith("r-1", "/path/to/wt", "wt-1", recipeContext);
  });
});
