// @vitest-environment jsdom
/**
 * AgentButton — toolbar button with optional flavor picker.
 *
 * Covers the MRU (most-recently-used) flavor launch semantics and the
 * >= 2 threshold for showing the split/chevron UI. These are UX regressions
 * corrected during the flavor PR review:
 *
 *  - Primary-button click launches with the saved `flavorId` when present,
 *    otherwise launches vanilla (no flavorId). Research called out that
 *    always-vanilla on the primary button contradicts the industry-standard
 *    split-button convention.
 *
 *  - The chevron/dropdown only appears when there are at least 2 flavors.
 *    A single flavor is implicitly the default and doesn't warrant a picker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";

const dispatchMock = vi.fn();

let mockSettings: AgentSettings | null = null;
let mockCcrFlavorsByAgent: Record<string, Array<{ id: string; name: string }>> = {};
let mockMergedFlavorsFn: (
  agentId: string
) => Array<{ id: string; name: string; color?: string }> = () => [];

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: Object.assign(
    (selector: (s: { settings: AgentSettings | null }) => unknown) =>
      selector({ settings: mockSettings }),
    {
      getState: () => ({ setAgentPinned: vi.fn() }),
    }
  ),
}));

vi.mock("@/store/ccrFlavorsStore", () => ({
  useCcrFlavorsStore: (
    selector: (s: { ccrFlavorsByAgent: Record<string, unknown[]> }) => unknown
  ) => selector({ ccrFlavorsByAgent: mockCcrFlavorsByAgent }),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ panelsById: {}, panelIds: [] }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: null }),
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktrees: [] }),
}));

vi.mock("@/hooks", () => ({
  useKeybindingDisplay: () => null,
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    icon: () => null,
  }),
  getMergedFlavors: (agentId: string) => mockMergedFlavorsFn(agentId),
}));

vi.mock("@/lib/colorUtils", () => ({
  getBrandColorHex: (id: string) => `#brand-${id}`,
}));

vi.mock("@/components/Worktree/AgentStatusIndicator", () => ({
  getDominantAgentState: () => null,
  agentStateDotColor: () => "",
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
    disabled?: boolean;
  } & React.HTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="flavor-dropdown">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    className?: string;
  }) => (
    <div
      role="menuitem"
      data-testid="flavor-item"
      className={className}
      onClick={(e) => onSelect?.(e as unknown as Event)}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="flavor-menu-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="flavor-menu-separator" />,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSeparator: () => null,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => <span data-testid="chevron-icon" />,
  Unplug: () => <span data-testid="unplug-icon" />,
}));

import { AgentButton } from "../AgentButton";

function settingsWith(agents: Record<string, unknown>): AgentSettings {
  return { agents } as unknown as AgentSettings;
}

describe("AgentButton flavor UX", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    mockSettings = null;
    mockCcrFlavorsByAgent = {};
    mockMergedFlavorsFn = () => [];
  });

  describe("split threshold", () => {
    it("renders plain button (no chevron) when agent has 0 flavors", () => {
      mockMergedFlavorsFn = () => [];
      const { queryByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(queryByTestId("chevron-icon")).toBeNull();
    });

    it("renders plain button (no chevron) when agent has exactly 1 flavor", () => {
      mockMergedFlavorsFn = () => [{ id: "only", name: "Only" }];
      const { queryByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      // Threshold is >= 2, so a single flavor should not trigger the split UI.
      expect(queryByTestId("chevron-icon")).toBeNull();
    });

    it("renders split button (with chevron) when agent has >= 2 flavors", () => {
      mockMergedFlavorsFn = () => [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ];
      const { getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(getByTestId("chevron-icon")).toBeTruthy();
    });
  });

  describe("MRU primary-click launch", () => {
    it("primary click with no savedFlavorId dispatches without flavorId (vanilla fallthrough)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedFlavorsFn = () => [];

      const { getByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      // Plain button branch — single button rendered.
      fireEvent.click(getByRole("button"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude" },
        { source: "user" }
      );
    });

    it("primary click with savedFlavorId dispatches with that flavorId (MRU)", () => {
      mockSettings = settingsWith({ claude: { flavorId: "user-blue" } });
      mockMergedFlavorsFn = () => [
        { id: "user-blue", name: "Blue" },
        { id: "user-red", name: "Red" },
      ];

      const { getAllByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      // Split-button branch — first button is the primary launch button.
      const [primaryBtn] = getAllByRole("button");
      fireEvent.click(primaryBtn);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", flavorId: "user-blue" },
        { source: "user" }
      );
    });

    it("primary click with savedFlavorId dispatches flavorId even when agent has only 1 flavor (no split)", () => {
      // With < 2 flavors we render a plain button, but MRU must still work —
      // the user picked this flavor from Settings and expects it on next click.
      mockSettings = settingsWith({ claude: { flavorId: "user-alpha" } });
      mockMergedFlavorsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      fireEvent.click(getByRole("button"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", flavorId: "user-alpha" },
        { source: "user" }
      );
    });
  });

  describe("dropdown grouping", () => {
    it("does not label groups when only CCR flavors are present", () => {
      mockMergedFlavorsFn = () => [
        { id: "ccr-a", name: "CCR: A" },
        { id: "ccr-b", name: "CCR: B" },
      ];
      mockSettings = settingsWith({ claude: {} });

      const { queryByText } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(queryByText("CCR Routes")).toBeNull();
      expect(queryByText("Custom")).toBeNull();
    });

    it("labels both groups when CCR and custom coexist", () => {
      mockMergedFlavorsFn = () => [
        { id: "ccr-a", name: "CCR: A" },
        { id: "user-beta", name: "Beta" },
      ];
      mockSettings = settingsWith({ claude: {} });

      const { queryAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const labels = queryAllByTestId("flavor-menu-label");
      const texts = labels.map((el) => el.textContent);
      expect(texts).toContain("CCR Routes");
      expect(texts).toContain("Custom");
    });
  });

  describe("not-ready state", () => {
    it("primary click when CLI is not installed opens settings (does not launch)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedFlavorsFn = () => [];

      const { getByRole } = render(
        <AgentButton type="claude" availability={"missing" as unknown as CliAvailability[string]} />
      );
      fireEvent.click(getByRole("button"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "agents", subtab: "claude" },
        { source: "user" }
      );
    });
  });
});
