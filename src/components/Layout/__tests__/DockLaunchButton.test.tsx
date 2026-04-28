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
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dock-launcher-content">{children}</div>
  ),
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr data-testid="dock-launcher-separator" />,
}));

import { DockLaunchButton } from "../DockLaunchButton";

const AGENT_OPTIONS = [
  { type: "claude", label: "Claude" },
  { type: "terminal" as const, label: "Terminal" },
  { type: "browser" as const, label: "Browser" },
];

beforeEach(() => {
  mockRecipes = [];
  runRecipeMock.mockReset();
});

describe("DockLaunchButton", () => {
  it("renders a launch button with accessible label", () => {
    const { getByLabelText } = render(
      <DockLaunchButton
        agentOptions={AGENT_OPTIONS}
        onLaunchAgent={vi.fn()}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );
    expect(getByLabelText("Launch panel")).toBeTruthy();
  });

  it("lists every agent option and invokes onLaunchAgent when one is selected", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = render(
      <DockLaunchButton
        agentOptions={AGENT_OPTIONS}
        onLaunchAgent={onLaunchAgent}
        activeWorktreeId={null}
        cwd="/tmp"
      />
    );

    expect(getByText("New Claude")).toBeTruthy();
    expect(getByText("New Terminal")).toBeTruthy();
    expect(getByText("New Browser")).toBeTruthy();

    fireEvent.click(getByText("New Claude"));
    expect(onLaunchAgent).toHaveBeenCalledWith("claude");
  });

  it("renders 'No recipes' when no recipes match the active worktree", () => {
    mockRecipes = [];
    const { getByText } = render(
      <DockLaunchButton
        agentOptions={AGENT_OPTIONS}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/tmp"
      />
    );
    expect(getByText("No recipes")).toBeTruthy();
  });

  it("lists project-wide recipes and recipes scoped to the active worktree", () => {
    mockRecipes = [
      { id: "r-global", name: "Project recipe", worktreeId: undefined },
      { id: "r-wt", name: "Worktree recipe", worktreeId: "wt-1" },
      { id: "r-other", name: "Other worktree recipe", worktreeId: "wt-2" },
    ];

    const { getByText, queryByText } = render(
      <DockLaunchButton
        agentOptions={AGENT_OPTIONS}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/tmp"
      />
    );

    expect(getByText("Project recipe")).toBeTruthy();
    expect(getByText("Worktree recipe")).toBeTruthy();
    expect(queryByText("Other worktree recipe")).toBeNull();
  });

  it("invokes runRecipe with cwd and worktreeId when a recipe is selected", () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];

    const { getByText } = render(
      <DockLaunchButton
        agentOptions={AGENT_OPTIONS}
        onLaunchAgent={vi.fn()}
        activeWorktreeId="wt-1"
        cwd="/path/to/wt"
      />
    );

    fireEvent.click(getByText("My recipe"));
    expect(runRecipeMock).toHaveBeenCalledWith("r-1", "/path/to/wt", "wt-1");
  });
});
