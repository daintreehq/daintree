// @vitest-environment jsdom
/**
 * AgentButton — toolbar button with optional preset picker.
 *
 * Covers the MRU (most-recently-used) preset launch semantics and the
 * >= 1 threshold for showing the split/chevron UI. These are UX regressions
 * corrected during the preset PR review:
 *
 *  - Primary-button click launches with the saved `presetId` when present,
 *    otherwise launches default (no presetId). Research called out that
 *    always-default on the primary button contradicts the industry-standard
 *    split-button convention.
 *
 *  - The chevron/dropdown appears whenever there is at least one named preset.
 *    The dropdown always renders the implicit "Default" entry alongside named
 *    presets, so one named preset already gives the user two real launch
 *    choices and warrants the picker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";

const dispatchMock = vi.fn();
const updateWorktreePresetMock = vi.fn();

let mockSettings: AgentSettings | null = null;
let mockActiveWorktreeId: string | null = null;
let mockCcrPresetsByAgent: Record<string, Array<{ id: string; name: string }>> = {};
let mockMergedPresetsFn: (
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
      getState: () => ({
        setAgentPinned: vi.fn(),
        updateWorktreePreset: updateWorktreePresetMock,
      }),
    }
  ),
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: (
    selector: (s: { ccrPresetsByAgent: Record<string, unknown[]> }) => unknown
  ) => selector({ ccrPresetsByAgent: mockCcrPresetsByAgent }),
}));

let mockCliDetails: Record<string, { authConfirmed?: boolean } | undefined> = {};

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (
    selector: (s: { details: Record<string, { authConfirmed?: boolean } | undefined> }) => unknown
  ) => selector({ details: mockCliDetails }),
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: (
    selector: (s: { presetsByAgent: Record<string, unknown[]> }) => unknown
  ) => selector({ presetsByAgent: {} }),
}));

let mockPanelsById: Record<string, unknown> = {};
let mockPanelIds: string[] = [];
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ panelsById: mockPanelsById, panelIds: mockPanelIds }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: mockActiveWorktreeId }),
}));

let mockWorktrees: Array<{
  id: string;
  name: string;
  branch?: string | null;
  isMainWorktree?: boolean;
}> = [];

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktrees: mockWorktrees }),
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
  getMergedPresets: (agentId: string) => mockMergedPresetsFn(agentId),
}));

vi.mock("@/lib/colorUtils", () => ({
  getBrandColorHex: (id: string) => `#brand-${id}`,
}));

// Defaults match the historical "ignore the badge in these tests" stance;
// individual badge tests override these to drive the indicator render path.
let mockDominantState: string | null = null;
let mockDotColor: string | null = "";
vi.mock("@/components/Worktree/AgentStatusIndicator", () => ({
  getDominantAgentState: () => mockDominantState,
  agentStateDotColor: () => mockDotColor,
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
    <div data-testid="preset-dropdown">{children}</div>
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
      data-testid="preset-item"
      className={className}
      onClick={(e) => onSelect?.(e as unknown as Event)}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="preset-menu-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="preset-menu-separator" />,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
    disabled,
    className,
    "data-testid": dataTestId,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    disabled?: boolean;
    className?: string;
    "data-testid"?: string;
  }) => (
    <div
      role="menuitem"
      data-testid={dataTestId ?? "context-menu-item"}
      data-disabled={disabled ? "true" : undefined}
      className={className}
      onClick={(e) => {
        if (disabled) return;
        onSelect?.(e as unknown as Event);
      }}
    >
      {children}
    </div>
  ),
  ContextMenuSeparator: () => null,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubTrigger: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <div
      role="menuitem"
      data-testid="context-menu-sub-trigger"
      data-disabled={disabled ? "true" : undefined}
    >
      {children}
    </div>
  ),
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => <span data-testid="chevron-icon" />,
  PanelBottom: () => <span data-testid="panel-bottom-icon" />,
  Unplug: () => <span data-testid="unplug-icon" />,
}));

import { AgentButton } from "../AgentButton";

function settingsWith(agents: Record<string, unknown>): AgentSettings {
  return { agents } as unknown as AgentSettings;
}

describe("AgentButton preset UX", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    updateWorktreePresetMock.mockClear();
    mockSettings = null;
    mockActiveWorktreeId = null;
    mockCcrPresetsByAgent = {};
    mockMergedPresetsFn = () => [];
    mockCliDetails = {};
    mockDominantState = null;
    mockDotColor = "";
    mockPanelsById = {};
    mockPanelIds = [];
    mockWorktrees = [];
  });

  describe("split threshold", () => {
    it("renders plain button (no chevron) when agent has 0 presets", () => {
      mockMergedPresetsFn = () => [];
      const { queryByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(queryByTestId("chevron-icon")).toBeNull();
    });

    it("renders split button (with chevron) when agent has exactly 1 preset", () => {
      mockMergedPresetsFn = () => [{ id: "only", name: "Only" }];
      const { getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      // The dropdown always includes an implicit Default entry, so a single
      // named preset already represents two real launch choices.
      expect(getByTestId("chevron-icon")).toBeTruthy();
    });

    it("renders split button (with chevron) when agent has >= 2 presets", () => {
      mockMergedPresetsFn = () => [
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
    it("primary click with no savedPresetId dispatches without presetId (default fallthrough)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];

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

    it("primary click with savedPresetId dispatches with that presetId (MRU)", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [
        { id: "user-blue", name: "Blue" },
        { id: "user-red", name: "Red" },
      ];

      const { getAllByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      // Split-button branch — first button is the primary launch button.
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-blue" },
        { source: "user" }
      );
    });

    it("primary click with savedPresetId dispatches presetId when agent has only 1 preset", () => {
      // With 1 named preset the split UI now renders (Default + the preset),
      // and the primary button must still honor the saved MRU selection.
      mockSettings = settingsWith({ claude: { presetId: "user-alpha" } });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-alpha" },
        { source: "user" }
      );
    });
  });

  describe("dropdown grouping", () => {
    it("does not label groups when only CCR presets are present", () => {
      mockMergedPresetsFn = () => [
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
      mockMergedPresetsFn = () => [
        { id: "ccr-a", name: "CCR: A" },
        { id: "user-beta", name: "Beta" },
      ];
      mockSettings = settingsWith({ claude: {} });

      const { queryAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const labels = queryAllByTestId("preset-menu-label");
      const texts = labels.map((el) => el.textContent);
      expect(texts).toContain("CCR Routes");
      expect(texts).toContain("Custom");
    });
  });

  describe("worktree-scoped preset", () => {
    it("primary click reads the worktree override when present, not the agent-level default", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: {
          presetId: "user-global",
          worktreePresets: { "wt-A": "user-scoped" },
        },
      });
      mockMergedPresetsFn = () => [
        { id: "user-global", name: "Global" },
        { id: "user-scoped", name: "Scoped" },
      ];

      const { getAllByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-scoped" },
        { source: "user" }
      );
    });

    it("primary click falls back to agent-level default when the active worktree has no override", () => {
      mockActiveWorktreeId = "wt-B";
      mockSettings = settingsWith({
        claude: {
          presetId: "user-global",
          worktreePresets: { "wt-A": "user-scoped" },
        },
      });
      mockMergedPresetsFn = () => [
        { id: "user-global", name: "Global" },
        { id: "user-scoped", name: "Scoped" },
      ];

      const { getAllByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-global" },
        { source: "user" }
      );
    });

    it("dropdown preset selection persists the pick to the worktree slot before dispatch", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      // Dropdown items: 0 = Default, 1 = Alpha, 2 = Beta (first occurrence only
      // — presets list is unsorted in tests so take items in render order).
      const items = getAllByTestId("preset-item") as HTMLElement[];
      // Pick the preset that is not "Default". Items include one "Default"
      // menu entry plus one per preset.
      const alphaItem = items.find((el) => el.textContent?.includes("Alpha"))!;
      fireEvent.click(alphaItem);

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "user-alpha");
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-alpha" },
        { source: "user" }
      );
    });

    it("dropdown Default clears the worktree override before dispatching null", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: { worktreePresets: { "wt-A": "user-alpha" } },
      });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const items = getAllByTestId("preset-item") as HTMLElement[];
      const defaultItem = items.find((el) => el.textContent?.includes("Default"))!;
      fireEvent.click(defaultItem);

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", undefined);
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: null },
        { source: "user" }
      );
    });

    it("no-ops the worktree persist when no active worktree is set", () => {
      mockActiveWorktreeId = null;
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const items = getAllByTestId("preset-item") as HTMLElement[];
      const alphaItem = items.find((el) => el.textContent?.includes("Alpha"))!;
      fireEvent.click(alphaItem);

      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-alpha" },
        { source: "user" }
      );
    });
  });

  describe("not-ready state", () => {
    it("primary click when CLI is not installed opens settings (does not launch)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];

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

  describe("status dot badge", () => {
    function activePanel(state: string): Record<string, unknown> {
      // `detectedAgentId` is what `getRuntimeOrBootAgentId` reads (via
      // `deriveTerminalChrome`); plain `agentId` on the panel is not used by
      // the derivation, so the helper would return undefined and the panel
      // would never enter the active-session set.
      return {
        id: "panel-1",
        kind: "terminal",
        detectedAgentId: "claude",
        worktreeId: "wt-1",
        location: "grid",
        agentState: state,
      };
    }

    it("renders the badge span when an actionable state returns a non-null color", () => {
      mockSettings = settingsWith({ claude: {} });
      mockPanelsById = { "panel-1": activePanel("waiting") };
      mockPanelIds = ["panel-1"];
      mockActiveWorktreeId = "wt-1";
      mockDominantState = "waiting";
      mockDotColor = "bg-state-waiting";

      const { container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge).not.toBeNull();
    });

    it("does not render the badge span when the helper returns null (passive state)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockPanelsById = { "panel-1": activePanel("working") };
      mockPanelIds = ["panel-1"];
      mockActiveWorktreeId = "wt-1";
      mockDominantState = "working";
      mockDotColor = null;

      const { container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge).toBeNull();
    });

    it("does not render the badge span when there is no active session", () => {
      mockSettings = settingsWith({ claude: {} });
      mockDominantState = null;
      mockDotColor = "bg-state-waiting";

      const { container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge).toBeNull();
    });
  });

  describe("context menu", () => {
    it("exposes Manage Presets that deep-links to the presets section (no-presets branch)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];

      const { getByText } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      fireEvent.click(getByText("Manage Claude Presets..."));

      expect(dispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "agents", subtab: "claude", sectionId: "agents-presets" },
        { source: "context-menu" }
      );
    });

    it("exposes Manage Presets that deep-links to the presets section (with-presets branch)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getByText } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      fireEvent.click(getByText("Manage Claude Presets..."));

      expect(dispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "agents", subtab: "claude", sectionId: "agents-presets" },
        { source: "context-menu" }
      );
    });

    it("renders one flat row per worktree (no nested Grid/Dock submenus)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];
      mockWorktrees = [
        { id: "wt-1", name: "Main", isMainWorktree: true },
        { id: "wt-2", name: "feat/x", branch: "feat/x" },
      ];

      const { getAllByTestId, queryByText } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      expect(getAllByTestId(/^agent-context-worktree-(wt-1|wt-2)$/)).toHaveLength(2);
      // No nested Grid/Dock leaf items — only inline buttons.
      expect(queryByText("Grid")).toBeNull();
      expect(queryByText("Dock")).toBeNull();
    });

    it("clicking a worktree row launches in grid (default)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];
      mockWorktrees = [{ id: "wt-1", name: "Main", isMainWorktree: true }];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      fireEvent.click(getByTestId("agent-context-worktree-wt-1"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", worktreeId: "wt-1", location: "grid" },
        { source: "context-menu" }
      );
    });

    it("clicking the inline Dock icon launches in dock without firing grid", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];
      mockWorktrees = [{ id: "wt-1", name: "Main", isMainWorktree: true }];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      fireEvent.click(getByTestId("agent-context-worktree-dock-wt-1"));

      // The inline button must stop propagation so the row's onSelect
      // (which would launch grid) does not also fire.
      const dockCalls = dispatchMock.mock.calls.filter(
        (c) => c[0] === "agent.launch" && (c[1] as { location?: string }).location === "dock"
      );
      const gridCalls = dispatchMock.mock.calls.filter(
        (c) => c[0] === "agent.launch" && (c[1] as { location?: string }).location === "grid"
      );
      expect(dockCalls).toHaveLength(1);
      expect(gridCalls).toHaveLength(0);
      expect(dockCalls[0]).toEqual([
        "agent.launch",
        { agentId: "claude", worktreeId: "wt-1", location: "dock" },
        { source: "context-menu" },
      ]);
    });

    it("hides the Launch in Worktree submenu when no worktrees exist", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];
      mockWorktrees = [];

      const { queryByText } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(queryByText("Launch in Worktree")).toBeNull();
    });
  });
});
