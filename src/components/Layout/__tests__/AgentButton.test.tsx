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
let dropdownCloseAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let dropdownPointerDownOutsideSpy: (() => void) | null = null;

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
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
    onPointerDownOutside,
  }: {
    children: React.ReactNode;
    onCloseAutoFocus?: (e: { preventDefault: () => void }) => void;
    onPointerDownOutside?: () => void;
  }) => {
    dropdownCloseAutoFocusSpy = onCloseAutoFocus ?? null;
    dropdownPointerDownOutsideSpy = onPointerDownOutside ?? null;
    return <div data-testid="preset-dropdown">{children}</div>;
  },
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
  DropdownMenuRadioGroup: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <div data-testid="preset-radio-group" data-value={value ?? ""}>
      {children}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    onSelect,
    value,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    value: string;
    className?: string;
  }) => (
    <div
      role="menuitemradio"
      data-testid="preset-item"
      data-value={value}
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
  ContextMenuRadioGroup: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <div data-testid="context-radio-group" data-value={value ?? ""}>
      {children}
    </div>
  ),
  ContextMenuRadioItem: ({
    children,
    onSelect,
    value,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    value: string;
  }) => (
    <div
      role="menuitemradio"
      data-testid="context-radio-item"
      data-value={value}
      onClick={(e) => onSelect?.(e as unknown as Event)}
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
    dropdownCloseAutoFocusSpy = null;
    dropdownPointerDownOutsideSpy = null;
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

    it("primary click never forwards an explicit presetId — launcher resolves it", () => {
      // The toolbar must NOT forward the resolved savedPresetId. Doing so
      // bypasses useAgentLauncher's stale-fallback path: when a saved id
      // points to a deleted preset, an explicit presetId launches
      // preset-free instead of falling back to the agent-level default.
      // Omitting presetId lets the launcher run resolveEffectivePresetId +
      // fallback in one place. Saved-preset display still works because the
      // launcher reads the same setting internally.
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [
        { id: "user-blue", name: "Blue" },
        { id: "user-red", name: "Red" },
      ];

      const { getAllByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude" },
        { source: "user" }
      );
    });

    it("primary click omits presetId even when agent has only 1 preset", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-alpha" } });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude" },
        { source: "user" }
      );
    });

    it("primary click with stale worktree-scoped preset still dispatches without presetId so launcher fallback runs", () => {
      // Regression guard: when the worktree slot points to a deleted preset
      // and the agent-level default is still valid, the toolbar must not
      // forward the stale id — it would block useAgentLauncher's fallback
      // and the click would launch preset-free instead of the global
      // default. The toolbar passes nothing; the launcher does the rest.
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: {
          presetId: "user-global",
          worktreePresets: { "wt-A": "deleted-id" },
        },
      });
      mockMergedPresetsFn = () => [{ id: "user-global", name: "Global" }];

      const { getAllByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude" },
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
    it("primary click dispatches without presetId when a worktree override is present (launcher resolves)", () => {
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

      const { getAllByRole, container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      // Dispatch carries no presetId — that's the launcher's job. The
      // tooltip still surfaces the worktree-scoped preset name so the
      // user sees what the click will run.
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude" },
        { source: "user" }
      );
      expect(container.textContent).toContain("Start Claude · Scoped");
    });

    it("primary click dispatches without presetId when active worktree has no override (tooltip shows global)", () => {
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

      const { getAllByRole, container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const [primaryBtn] = getAllByRole("button") as HTMLElement[];
      fireEvent.click(primaryBtn!);

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude" },
        { source: "user" }
      );
      expect(container.textContent).toContain("Start Claude · Global");
    });

    it("dropdown preset selection persists the pick without launching the agent", () => {
      mockActiveWorktreeId = "wt-A";
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

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "user-alpha");
      // Chevron dropdown is a pure configurer — selecting a preset must not
      // launch. The primary button is the only launch surface.
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("dropdown Agent default clears the worktree override without launching", () => {
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
      const defaultItem = items.find((el) => el.textContent?.includes("Agent default"))!;
      fireEvent.click(defaultItem);

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", undefined);
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("no-ops both persist and launch when no active worktree is set", () => {
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
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("dropdown CCR preset selection persists without launching (separate code path)", () => {
      // The chevron renders CCR, project-shared, and custom presets in three
      // independent onSelect closures. Cover the CCR path explicitly so a
      // regression that reintroduces launch in only one group is caught.
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "ccr-sonnet", name: "CCR: Sonnet 4.5" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const items = getAllByTestId("preset-item") as HTMLElement[];
      const ccrItem = items.find((el) => el.textContent?.includes("Sonnet 4.5"))!;
      fireEvent.click(ccrItem);

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "ccr-sonnet");
      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });

  describe("tooltip surfaces active preset", () => {
    function tooltipTexts(getAllByTestId: (id: string) => HTMLElement[]): string[] {
      return getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
    }

    it("appends the saved preset name to the launch tooltip", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [
        { id: "user-blue", name: "Blue" },
        { id: "user-red", name: "Red" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(tooltipTexts(getAllByTestId)).toContain("Start Claude · Blue");
    });

    it("strips the CCR routing prefix from the saved preset name", () => {
      mockSettings = settingsWith({ claude: { presetId: "ccr-sonnet" } });
      mockMergedPresetsFn = () => [{ id: "ccr-sonnet", name: "CCR: Sonnet 4.5" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(tooltipTexts(getAllByTestId)).toContain("Start Claude · Sonnet 4.5");
    });

    it("omits the preset segment when no preset is saved", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const texts = tooltipTexts(getAllByTestId);
      expect(texts).toContain("Start Claude");
      // No `·` segment leaks in via the launch tooltip when nothing is armed.
      const launchTooltip = texts.find((t) => t.startsWith("Start "));
      expect(launchTooltip).toBeDefined();
      expect(launchTooltip).not.toContain("·");
    });

    it("omits the preset segment when the saved id no longer matches a preset", () => {
      // Stale id (preset deleted) — fall back to plain tooltip rather than
      // surfacing a phantom name.
      mockSettings = settingsWith({ claude: { presetId: "ghost" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const texts = tooltipTexts(getAllByTestId);
      expect(texts).toContain("Start Claude");
      const launchTooltip = texts.find((t) => t.startsWith("Start "));
      expect(launchTooltip).not.toContain("·");
    });

    it("renders a chevron-specific tooltip distinct from the launch tooltip", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(tooltipTexts(getAllByTestId)).toContain("Set Claude preset");
    });

    it("preserves the preset segment when the sign-in probe is unconfirmed", () => {
      // Agent is `unauthenticated` — binary found but no credential detected.
      // The user still has an armed preset that will fire on click — the
      // tooltip should surface it rather than silently dropping the segment.
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByTestId } = render(
        <AgentButton
          type="claude"
          availability={"unauthenticated" as unknown as CliAvailability[string]}
        />
      );
      const texts = tooltipTexts(getAllByTestId);
      const launchTooltip = texts.find((t) => t.startsWith("Start "));
      expect(launchTooltip).toContain("· Blue");
      expect(launchTooltip).toContain("sign-in not detected");
    });
  });

  describe("radio indicator", () => {
    it("dropdown radio group reflects the saved preset id", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [
        { id: "user-blue", name: "Blue" },
        { id: "user-red", name: "Red" },
      ];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(getByTestId("preset-radio-group").getAttribute("data-value")).toBe("user-blue");
    });

    it("dropdown radio group falls back to empty string when no preset is saved", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      // The Agent default radio item is rendered with value="" so the group
      // resolves to that item when nothing is saved.
      expect(getByTestId("preset-radio-group").getAttribute("data-value")).toBe("");
    });

    it("context-menu radio group reflects the saved preset id", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [
        { id: "user-blue", name: "Blue" },
        { id: "user-red", name: "Red" },
      ];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(getByTestId("context-radio-group").getAttribute("data-value")).toBe("user-blue");
    });

    it("context-menu preset selection dispatches with source 'context-menu'", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [
        { id: "user-blue", name: "Blue" },
        { id: "user-red", name: "Red" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const items = getAllByTestId("context-radio-item") as HTMLElement[];
      const blueItem = items.find((el) => el.textContent?.includes("Blue"))!;
      fireEvent.click(blueItem);

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "user-blue");
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-blue" },
        { source: "context-menu" }
      );
    });

    it("context-menu Agent default clears the override and still launches with null preset", () => {
      // The context-menu sub is intentionally a launcher (unlike the chevron).
      // Verify the Agent default row mirrors that contract: clear the
      // worktree-scoped override AND dispatch a null-preset launch.
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: { worktreePresets: { "wt-A": "user-blue" } },
      });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const items = getAllByTestId("context-radio-item") as HTMLElement[];
      const defaultItem = items.find((el) => el.textContent?.includes("Agent default"))!;
      fireEvent.click(defaultItem);

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", undefined);
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: null },
        { source: "context-menu" }
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

  describe("manage presets dropdown footer", () => {
    it("dropdown footer dispatches deep-link to the preset editor with source 'user'", () => {
      // The chevron dropdown carries a footer "Manage Presets..." item that
      // mirrors the right-click menu's agent-named entry but uses the
      // shorter label since the agent identity is implicit (the user just
      // clicked this agent's chevron). Source is "user" because it's a
      // direct primary-UI dispatch, not a context-menu surface.
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const items = getAllByTestId("preset-item") as HTMLElement[];
      const manage = items.find((el) => el.textContent === "Manage Presets...")!;
      fireEvent.click(manage);

      expect(dispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "agents", subtab: "claude", sectionId: "agents-presets" },
        { source: "user" }
      );
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

  describe("chevron focus ring after dropdown dismissal (issue #6119)", () => {
    function renderSplitButton() {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];
      return render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
    }

    it("does not call preventDefault on keyboard close (preserves a11y focus return)", () => {
      // No preceding onPointerDownOutside means the close source is keyboard
      // (Escape/Enter); WAI-ARIA requires focus to return to the trigger.
      renderSplitButton();
      expect(dropdownCloseAutoFocusSpy).toBeTruthy();

      const preventDefault = vi.fn();
      dropdownCloseAutoFocusSpy!({ preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("calls preventDefault on pointer close so the chevron does not keep its focus ring", () => {
      // Pointer-driven dismissal must suppress focus restoration to the chevron;
      // otherwise Radix re-focuses it and :focus-visible repaints the accent
      // ring even though the user clicked elsewhere.
      renderSplitButton();
      expect(dropdownCloseAutoFocusSpy).toBeTruthy();
      expect(dropdownPointerDownOutsideSpy).toBeTruthy();

      dropdownPointerDownOutsideSpy!();
      const preventDefault = vi.fn();
      dropdownCloseAutoFocusSpy!({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("resets the pointer flag so a later keyboard close still returns focus", () => {
      renderSplitButton();
      expect(dropdownCloseAutoFocusSpy).toBeTruthy();
      expect(dropdownPointerDownOutsideSpy).toBeTruthy();

      dropdownPointerDownOutsideSpy!();
      dropdownCloseAutoFocusSpy!({ preventDefault: vi.fn() });

      const preventDefault = vi.fn();
      dropdownCloseAutoFocusSpy!({ preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });
});
