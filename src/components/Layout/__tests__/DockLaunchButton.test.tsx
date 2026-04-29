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
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={() => onSelect?.()} disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div data-testid="dock-launcher-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="dock-launcher-separator" />,
}));

import { DockLaunchButton } from "../DockLaunchButton";

const AGENTS = [
  { id: "claude", name: "Claude", isEnabled: true },
  { id: "gemini", name: "Gemini", isEnabled: false },
];

beforeEach(() => {
  mockRecipes = [];
  runRecipeMock.mockReset();
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

  it("invokes onLaunchAgent for an agent and respects disabled state", () => {
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

    onLaunchAgent.mockClear();
    fireEvent.click(getByText("Gemini"));
    expect(onLaunchAgent).not.toHaveBeenCalled();
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
