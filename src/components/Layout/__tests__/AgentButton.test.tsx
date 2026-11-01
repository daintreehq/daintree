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
import { useContext } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";
import { MenuActionSourceContext } from "@/components/ui/menu-source";
import {
  OverlayFocusRestoreContext,
  type OverlayFocusRestore,
} from "@/components/ui/overlay-focus-restore";

const dispatchMock = vi.fn();
const updateWorktreePresetMock = vi.fn().mockResolvedValue(undefined);
const updateAgentMock = vi.fn().mockResolvedValue(undefined);
let dropdownCloseAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let dropdownPointerDownOutsideSpy: (() => void) | null = null;
// Track the chevron dropdown's controlled-open contract (issue #10720): the
// mock forwards the live `open` prop and `onOpenChange` so tests can open the
// menu, then assert a gutter click keeps it open while a label click closes it.
let dropdownOpenState: boolean | undefined;
let dropdownOnOpenChange: ((open: boolean) => void) | null = null;

let mockSettings: AgentSettings | null = null;
let mockActiveWorktreeId: string | null = null;

const WithMenuSource = ({ children }: { children: React.ReactNode }) => (
  <MenuActionSourceContext.Provider value="context-menu">
    {children}
  </MenuActionSourceContext.Provider>
);
let mockCcrPresetsByAgent: Record<string, Array<{ id: string; name: string }>> = {};
let mockProjectPresetsByAgent: Record<string, Array<{ id: string; name: string }>> = {};
let mockMergedPresetsFn: (
  agentId: string
) => Array<{ id: string; name: string; color?: string }> = () => [];
let mockExternalLinks: Array<{ label: string; url: string }> | undefined;

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

const setAgentPinnedMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ settings: mockSettings }),
    {
      getState: () => ({
        updateWorktreePreset: updateWorktreePresetMock,
        updateAgent: updateAgentMock,
      }),
    }
  ),
}));

// The pin is this machine's (#14702), so the unpin must land in the pins
// store, never in the host's agent settings.
vi.mock("@/store/agentToolbarPinsStore", () => ({
  useAgentToolbarPinsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ pins: { claude: true }, revision: 0, setAgentPinned: setAgentPinnedMock }),
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
  ) => selector({ presetsByAgent: mockProjectPresetsByAgent }),
}));

let mockPanelsById: Record<string, unknown> = {};
let mockPanelIds: string[] = [];
// Runs the fleet places in `needs-you`: unread Canopy asks, the only waits that earn amber.
let mockNeedsYou: ReadonlySet<string> = new Set();
vi.mock("@/hooks/useRunFleetBand", () => ({
  useFleetBandRunIds: () => mockNeedsYou,
}));
let mockPanelIdsByWorktreeId: Record<string, string[]> = {};
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      panelsById: mockPanelsById,
      panelIds: mockPanelIds,
      panelIdsByWorktreeId: mockPanelIdsByWorktreeId,
    }),
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

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map(mockWorktrees.map((wt) => [wt.id, wt])) }),
}));

vi.mock("@/hooks", () => ({
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
  useShortcutHintHover: () => ({
    onPointerEnter: () => {},
    onPointerLeave: () => {},
    onPointerDown: () => {},
    onFocus: () => {},
    onBlur: () => {},
  }),
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    icon: () => <span data-testid="agent-icon" />,
    externalLinks: mockExternalLinks,
  }),
  getMergedPresets: (agentId: string) => mockMergedPresetsFn(agentId),
}));

vi.mock("@/lib/colorUtils", () => ({
  getBrandColorHex: (id: string) => `#brand-${id}`,
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
  DropdownMenu: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    dropdownOpenState = open;
    dropdownOnOpenChange = onOpenChange ?? null;
    return <>{children}</>;
  },
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
  // Mirrors real Radix: a click fires both onSelect (the row preventDefaults
  // it to block auto-dismiss) and the native onClick (zone delegation). The
  // synthetic event's target is the actual clicked node, so a click on the
  // gutter span vs the label span routes correctly through the closest()
  // check. The footer "Manage Presets" item uses onSelect only — onClick is
  // undefined there and harmlessly skipped.
  DropdownMenuItem: ({
    children,
    onSelect,
    onClick,
    onKeyDown,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    onClick?: (e: React.MouseEvent) => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    className?: string;
  }) => (
    <div
      role="menuitem"
      data-testid="preset-item"
      className={className}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        onSelect?.(e as unknown as Event);
        onClick?.(e);
      }}
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
    onKeyDown,
    disabled,
    className,
    "data-testid": dataTestId,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    disabled?: boolean;
    className?: string;
    "data-testid"?: string;
  }) => (
    <div
      role="menuitem"
      data-testid={dataTestId ?? "context-menu-item"}
      data-disabled={disabled ? "true" : undefined}
      className={className}
      onKeyDown={onKeyDown}
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
  ContextMenuMeta: ({ children }: { children: React.ReactNode }) => (
    <span aria-hidden="true" data-testid="context-menu-meta">
      {children}
    </span>
  ),
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
  ContextMenuActionItem: function MockContextMenuActionItem({
    children,
    actionId,
    args,
    dispatchOptions,
    onSelect,
    disabled,
    className,
    "data-testid": dataTestId,
  }: {
    children: React.ReactNode;
    actionId?: string;
    args?: unknown;
    dispatchOptions?: Record<string, unknown>;
    onSelect?: (e: Event) => void;
    disabled?: boolean;
    className?: string;
    "data-testid"?: string;
  }) {
    // The real item dispatches with the enclosing menu's source, falling back
    // to "user" outside a provider.
    const menuSource = useContext(MenuActionSourceContext);
    return (
      <div
        role="menuitem"
        data-testid={dataTestId ?? "context-menu-item"}
        data-disabled={disabled ? "true" : undefined}
        className={className}
        onClick={(e) => {
          if (disabled) return;
          onSelect?.(e as unknown as Event);
          if (e.defaultPrevented) return;
          dispatchMock(actionId, args, {
            ...dispatchOptions,
            source: menuSource ?? "user",
          });
        }}
      >
        {children}
      </div>
    );
  },
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({ title, isOpen }: { title: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div data-testid="preset-restart-confirm">{title}</div> : null,
}));

vi.mock("lucide-react", () => ({
  Settings2: () => <span data-testid="settings-icon" />,
  ChevronDown: (props: Record<string, unknown>) => <span data-testid="chevron-icon" {...props} />,
  ExternalLink: () => <span data-testid="external-link-icon" />,
  PanelBottom: () => <span data-testid="panel-bottom-icon" />,
  Unplug: () => <span data-testid="unplug-icon" />,
  PinOff: () => <span data-testid="pin-off-icon" />,
  Bookmark: () => <span data-testid="bookmark-icon" />,
  FolderGit2: () => <span data-testid="folder-git-icon" />,
  PanelTop: () => <span data-testid="panel-top-icon" />,
  Plug: () => <span data-testid="plug-icon" />,
  // Check / Circle render the preset-row gutter affordance (issue #10720):
  // Check marks the active default, Circle is the hover hint on other rows.
  // Queryable spans let the gutter-indicator tests assert which row is armed.
  Check: () => <span data-testid="check-icon" />,
  Circle: () => <span data-testid="circle-icon" />,
  // CheckCircle2 is pulled in transitively by terminalStateConfig.tsx for
  // STATE_LABELS (#9823); a stub satisfies its import graph.
  CheckCircle2: () => null,
}));

import { AgentButton } from "../AgentButton";

function settingsWith(agents: Record<string, unknown>): AgentSettings {
  return { agents } as unknown as AgentSettings;
}

describe("AgentButton preset UX", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    updateWorktreePresetMock.mockClear();
    updateAgentMock.mockClear();
    mockSettings = null;
    mockActiveWorktreeId = null;
    mockCcrPresetsByAgent = {};
    mockMergedPresetsFn = () => [];
    mockCliDetails = {};
    mockPanelsById = {};
    mockPanelIds = [];
    mockPanelIdsByWorktreeId = {};
    mockWorktrees = [];
    mockExternalLinks = undefined;
    dropdownCloseAutoFocusSpy = null;
    dropdownPointerDownOutsideSpy = null;
    dropdownOpenState = undefined;
    dropdownOnOpenChange = null;
    mockProjectPresetsByAgent = {};
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
      expect(queryByText("CCR routes")).toBeNull();
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
      expect(texts).toContain("CCR routes");
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

    // Each preset row is now split into two click zones (issue #10720): the
    // left gutter sets the worktree default without launching, the label area
    // launches with that preset. These helpers click a named row's specific
    // zone — clicking the row element itself (e.target === the row) routes to
    // the label/launch path, since only the gutter span carries data-zone.
    function rowByText(getAllByTestId: (id: string) => HTMLElement[], text: string): HTMLElement {
      const items = getAllByTestId("preset-item") as HTMLElement[];
      return items.find((el) => el.textContent?.includes(text))!;
    }
    function clickGutter(row: HTMLElement) {
      const gutter = row.querySelector('[data-zone="gutter"]') as HTMLElement;
      fireEvent.click(gutter);
    }
    function clickLabel(row: HTMLElement) {
      const label = row.querySelector('[data-zone="label"]') as HTMLElement;
      fireEvent.click(label);
    }

    it("gutter zone persists the worktree default without launching", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickGutter(rowByText(getAllByTestId, "Alpha"));

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "user-alpha");
      // The gutter is a pure configurer — it must not launch.
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("says once which panes a default pick left on the old preset (#13746)", async () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: { worktreePresets: { "wt-A": "user-alpha" } } });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];
      const pane = (id: string, presetId: string, extra: Record<string, unknown> = {}) => ({
        id,
        kind: "terminal",
        title: `Claude [${presetId}]`,
        cwd: "/repo",
        location: "grid",
        launchAgentId: "claude",
        worktreeId: "wt-A",
        agentPresetId: presetId,
        agentState: "waiting",
        ...extra,
      });
      mockPanelsById = {
        p1: pane("p1", "user-alpha"),
        p2: pane("p2", "user-alpha", { isUsingFallback: true }),
        p3: pane("p3", "user-beta"),
      };
      mockPanelIds = ["p1", "p2", "p3"];
      mockPanelIdsByWorktreeId = { "wt-A": ["p1", "p2", "p3"] };

      const { getAllByTestId } = render(<AgentButton type="claude" availability="ready" />);
      await act(async () => {
        clickGutter(rowByText(getAllByTestId, "Beta"));
      });

      // The fallback pane has its own indicator; the one already on Beta is fine.
      expect(screen.getByRole("status").textContent).toBe("1 Claude pane still on Alpha");
      expect(screen.getByText("Restart it on Beta…")).toBeTruthy();
    });

    it("doesn't bring the offer back when the save lands after the picker closed (#13746)", async () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: { worktreePresets: { "wt-A": "user-alpha" } } });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];
      mockPanelsById = {
        p1: {
          id: "p1",
          kind: "terminal",
          title: "Claude [Alpha]",
          cwd: "/repo",
          location: "grid",
          launchAgentId: "claude",
          worktreeId: "wt-A",
          agentPresetId: "user-alpha",
          agentState: "waiting",
        },
      };
      mockPanelIds = ["p1"];
      mockPanelIdsByWorktreeId = { "wt-A": ["p1"] };
      let resolveSave: () => void = () => {};
      updateWorktreePresetMock.mockImplementationOnce(
        () => new Promise<void>((resolve) => (resolveSave = resolve))
      );

      const { getAllByTestId } = render(<AgentButton type="claude" availability="ready" />);
      clickGutter(rowByText(getAllByTestId, "Beta"));
      act(() => dropdownOnOpenChange?.(false));
      await act(async () => resolveSave());

      expect(screen.queryByRole("status")).toBeNull();
    });

    it("offers nothing when the pick leaves no pane behind (#13746)", async () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: { worktreePresets: { "wt-A": "user-alpha" } } });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(<AgentButton type="claude" availability="ready" />);
      await act(async () => {
        clickGutter(rowByText(getAllByTestId, "Beta"));
      });

      expect(screen.queryByRole("status")).toBeNull();
    });

    it("label zone launches with the row's explicit preset without changing the default", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickLabel(rowByText(getAllByTestId, "Alpha"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-alpha" },
        { source: "user" }
      );
      // Launching from the label must not touch the persisted default.
      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
    });

    it("Agent default gutter saves the bare agent to this worktree only, without launching", () => {
      // Seed an agent-level presetId: an emptied worktree slot would fall
      // through to it (#6358), and clearing it instead would take it from every
      // other worktree inheriting it (#15054).
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: { presetId: "user-alpha", worktreePresets: { "wt-A": "user-alpha" } },
      });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickGutter(rowByText(getAllByTestId, "Agent default"));

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", null);
      expect(updateAgentMock).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("a bare-agent worktree reads Agent default while another worktree keeps the agent-level preset", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: { presetId: "user-alpha", worktreePresets: { "wt-A": null } },
      });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByTestId, rerender, container } = render(
        <AgentButton type="claude" availability="ready" />
      );
      expect(rowByText(getAllByTestId, "Agent default").textContent).toContain("Current default");
      expect(rowByText(getAllByTestId, "Alpha").textContent).not.toContain("Current default");
      expect(container.textContent).not.toContain("Start Claude · Alpha");

      mockActiveWorktreeId = "wt-B";
      rerender(<AgentButton type="claude" availability="ready" />);
      expect(rowByText(getAllByTestId, "Alpha").textContent).toContain("Current default");
      expect(container.textContent).toContain("Start Claude · Alpha");
    });

    it("Agent default label launches with a null preset (no row preset)", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickLabel(rowByText(getAllByTestId, "Agent default"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: null },
        { source: "user" }
      );
      expect(updateAgentMock).not.toHaveBeenCalled();
      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
    });

    it("gutter zone no-ops persistence when no active worktree is set", () => {
      mockActiveWorktreeId = null;
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickGutter(rowByText(getAllByTestId, "Alpha"));

      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("gutter zone persists idempotently for the already-default row", () => {
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
      clickGutter(rowByText(getAllByTestId, "Alpha"));

      // Re-setting the current default is a harmless idempotent write, not a
      // special-cased no-op — keeps the handler simple.
      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "user-alpha");
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("CCR group gutter persists without launching (separate render path)", () => {
      // The chevron renders CCR, project-shared, and custom presets through
      // independent group blocks. Cover the CCR gutter explicitly so a
      // regression in one group's wiring is caught.
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "ccr-sonnet", name: "CCR: Sonnet 4.5" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickGutter(rowByText(getAllByTestId, "Sonnet 4.5"));

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "ccr-sonnet");
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("CCR group label launches with the stripped-name preset id", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "ccr-sonnet", name: "CCR: Sonnet 4.5" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickLabel(rowByText(getAllByTestId, "Sonnet 4.5"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "ccr-sonnet" },
        { source: "user" }
      );
      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
    });

    it("gutter click keeps the dropdown open", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      // Open the controlled menu, then click the gutter: it must stay open so
      // the user can arm a default without the menu collapsing under them.
      act(() => dropdownOnOpenChange!(true));
      expect(dropdownOpenState).toBe(true);
      clickGutter(rowByText(getAllByTestId, "Alpha"));
      expect(dropdownOpenState).toBe(true);
    });

    it("label click closes the dropdown", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      act(() => dropdownOnOpenChange!(true));
      expect(dropdownOpenState).toBe(true);
      clickLabel(rowByText(getAllByTestId, "Alpha"));
      // Launching closes the menu via the controlled setOpen(false) path.
      expect(dropdownOpenState).toBe(false);
    });

    it("Project shared group gutter persists and label launches (separate render path)", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockProjectPresetsByAgent = { claude: [{ id: "proj-x", name: "Project X" }] };
      mockMergedPresetsFn = () => [{ id: "proj-x", name: "Project X" }];

      const { getAllByTestId, rerender } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickGutter(rowByText(getAllByTestId, "Project X"));
      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "proj-x");
      expect(dispatchMock).not.toHaveBeenCalled();

      rerender(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickLabel(rowByText(getAllByTestId, "Project X"));
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "proj-x" },
        { source: "user" }
      );
    });

    it("Agent default gutter writes neither scope with no active worktree", () => {
      // Same as a named pick: with no worktree there is no slot to save to, and
      // the agent-level preset belongs to Settings.
      mockActiveWorktreeId = null;
      mockSettings = settingsWith({ claude: { presetId: "user-alpha" } });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      clickGutter(rowByText(getAllByTestId, "Agent default"));

      expect(updateAgentMock).not.toHaveBeenCalled();
      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    // Keyboard twin of the gutter, mirroring the plugin tray's P-to-pin: D on a
    // row sets the default without launching; Enter/Space keep launching.
    function pressD(row: HTMLElement, init: Partial<KeyboardEventInit> = {}) {
      return fireEvent.keyDown(row, { key: "d", ...init });
    }

    it("D on a preset row persists the worktree default without launching or closing", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [
        { id: "user-alpha", name: "Alpha" },
        { id: "user-beta", name: "Beta" },
      ];

      const { getAllByTestId } = render(<AgentButton type="claude" availability="ready" />);
      act(() => dropdownOnOpenChange!(true));
      // fireEvent returns false when the handler preventDefaults, which is what
      // keeps Radix's typeahead from also acting on the key.
      expect(pressD(rowByText(getAllByTestId, "Beta"), { key: "D" })).toBe(false);

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", "user-beta");
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(dropdownOpenState).toBe(true);
    });

    it("D on Agent default saves the bare agent to this worktree, same as its gutter", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: { presetId: "user-alpha", worktreePresets: { "wt-A": "user-alpha" } },
      });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByTestId } = render(<AgentButton type="claude" availability="ready" />);
      pressD(rowByText(getAllByTestId, "Agent default"));

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", null);
      expect(updateAgentMock).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("leaves other keys and modified D presses to their own handlers", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getAllByTestId } = render(<AgentButton type="claude" availability="ready" />);
      const row = rowByText(getAllByTestId, "Alpha");
      for (const init of [
        { key: "Enter" },
        { key: " " },
        { key: "f" },
        { key: "d", metaKey: true },
        { key: "d", ctrlKey: true },
        { key: "d", altKey: true },
      ]) {
        expect(fireEvent.keyDown(row, init), JSON.stringify(init)).toBe(true);
      }
      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
      expect(updateAgentMock).not.toHaveBeenCalled();
    });

    it("announces the default on exactly the checked row and the D hint on every other", () => {
      const hintsFor = (settings: Record<string, unknown>) => {
        mockActiveWorktreeId = "wt-A";
        mockSettings = settingsWith({ claude: settings });
        mockMergedPresetsFn = () => [
          { id: "user-alpha", name: "Alpha" },
          { id: "user-beta", name: "Beta" },
        ];
        const { getAllByTestId, unmount } = render(
          <AgentButton type="claude" availability="ready" />
        );
        const rows = (getAllByTestId("preset-item") as HTMLElement[]).filter((r) =>
          r.querySelector('[data-zone="gutter"]')
        );
        const result = rows.map((r) => ({
          checked: !!r.querySelector('[data-zone="gutter"] [data-testid="check-icon"]'),
          hint: r.querySelector(":scope > .sr-only")?.textContent ?? null,
        }));
        unmount();
        return result;
      };

      for (const settings of [{}, { worktreePresets: { "wt-A": "user-beta" } }]) {
        const rows = hintsFor(settings);
        expect(rows).toHaveLength(3);
        const announcedDefault = rows.filter((r) => /current default/i.test(r.hint ?? ""));
        expect(announcedDefault).toHaveLength(1);
        expect(announcedDefault[0]!.checked).toBe(true);
        for (const r of rows.filter((r) => !r.checked)) expect(r.hint).toMatch(/press d/i);
      }
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
      expect(tooltipTexts(getAllByTestId)).toContain("Start Claude with a preset");
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

  describe("default indicator", () => {
    function rowByText(getAllByTestId: (id: string) => HTMLElement[], text: string): HTMLElement {
      const items = getAllByTestId("preset-item") as HTMLElement[];
      return items.find((el) => el.textContent?.includes(text))!;
    }

    it("marks the saved preset row with a check and others with the hover circle", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [
        { id: "user-blue", name: "Blue" },
        { id: "user-red", name: "Red" },
      ];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const blueRow = rowByText(getAllByTestId, "Blue");
      const redRow = rowByText(getAllByTestId, "Red");
      // The armed row shows the check; the rest fall back to the dim circle.
      expect(blueRow.querySelector('[data-testid="check-icon"]')).not.toBeNull();
      expect(blueRow.querySelector('[data-testid="circle-icon"]')).toBeNull();
      expect(redRow.querySelector('[data-testid="check-icon"]')).toBeNull();
      expect(redRow.querySelector('[data-testid="circle-icon"]')).not.toBeNull();
    });

    it("checks the Agent default row when no preset is saved", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const defaultRow = rowByText(getAllByTestId, "Agent default");
      const blueRow = rowByText(getAllByTestId, "Blue");
      expect(defaultRow.querySelector('[data-testid="check-icon"]')).not.toBeNull();
      expect(blueRow.querySelector('[data-testid="check-icon"]')).toBeNull();
    });

    // Exact label, allowing only the screen-reader suffix the default row carries.
    const contextItem = (items: HTMLElement[], label: string) =>
      items.find(
        (el) =>
          el.textContent === label || el.textContent === `${label}, current defaultCurrent default`
      )!;
    const visibleMarkOf = (item: HTMLElement) =>
      item.querySelector('[data-testid="context-menu-meta"]')?.textContent ?? null;
    const THREE_PRESETS = [
      { id: "user-blue", name: "Blue" },
      { id: "user-red", name: "Red" },
      { id: "user-green", name: "Green" },
    ];

    it("context-menu marks the worktree's saved preset as the current default", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: { presetId: "user-red", worktreePresets: { "wt-A": "user-blue" } },
      });
      mockMergedPresetsFn = () => THREE_PRESETS;

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const items = getAllByTestId("context-menu-item") as HTMLElement[];

      // The worktree slot wins over the agent-level preset, as it does on launch.
      expect(visibleMarkOf(contextItem(items, "Blue"))).toBe("Current default");
      expect(contextItem(items, "Blue").textContent).toContain(", current default");
      for (const label of ["Red", "Green", "Agent default"]) {
        expect(visibleMarkOf(contextItem(items, label))).toBeNull();
        expect(contextItem(items, label).textContent).toBe(label);
      }
    });

    it.each([
      ["nothing named is saved", {}],
      [
        "this worktree saved the bare agent over an agent-level preset",
        { presetId: "user-blue", worktreePresets: { "wt-A": null } },
      ],
    ])("context-menu marks Agent default when %s", (_name, claude) => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude });
      mockMergedPresetsFn = () => THREE_PRESETS;

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const items = getAllByTestId("context-menu-item") as HTMLElement[];

      expect(visibleMarkOf(contextItem(items, "Agent default"))).toBe("Current default");
      for (const label of ["Blue", "Red", "Green"]) {
        expect(visibleMarkOf(contextItem(items, label))).toBeNull();
      }
    });

    it.each([
      ["Blue", "user-blue"],
      ["Green", "user-green"],
    ])(
      "context-menu %s launches once and leaves the worktree default alone (source falls back to 'user' without a menu-source provider)",
      (label, presetId) => {
        mockActiveWorktreeId = "wt-A";
        mockSettings = settingsWith({
          claude: { presetId: "user-blue", worktreePresets: { "wt-A": "user-red" } },
        });
        mockMergedPresetsFn = () => THREE_PRESETS;

        const { getAllByTestId } = render(
          <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
        );
        fireEvent.click(contextItem(getAllByTestId("context-menu-item") as HTMLElement[], label));

        // A preset carries the account and permission mode, so a one-off launch
        // must not quietly become what the main button starts next (#15051).
        expect(updateWorktreePresetMock).not.toHaveBeenCalled();
        expect(updateAgentMock).not.toHaveBeenCalled();
        expect(dispatchMock).toHaveBeenCalledTimes(1);
        expect(dispatchMock).toHaveBeenCalledWith(
          "agent.launch",
          { agentId: "claude", presetId },
          { source: "user" }
        );
      }
    );

    it("context-menu preset launch dispatches with the menu's source", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => THREE_PRESETS;

      const { getAllByTestId } = render(
        <WithMenuSource>
          <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
        </WithMenuSource>
      );
      fireEvent.click(contextItem(getAllByTestId("context-menu-item") as HTMLElement[], "Red"));

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: "user-red" },
        { source: "context-menu" }
      );
    });

    it("context-menu Agent default launches the bare agent once and leaves the worktree default alone", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: { presetId: "user-blue", worktreePresets: { "wt-A": "user-blue" } },
      });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      fireEvent.click(
        contextItem(getAllByTestId("context-menu-item") as HTMLElement[], "Agent default")
      );

      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
      expect(updateAgentMock).not.toHaveBeenCalled();
      // Explicit null, not undefined: undefined would relaunch the saved preset.
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: null },
        { source: "user" }
      );
    });
  });

  describe("not-ready state", () => {
    // Every unlaunchable state now launches: the last probe can be stale, and
    // `useAgentLauncher` re-probes and owns the choice between a PTY and the
    // recovery gate. Routing to settings here skipped that gate entirely
    // (#11760), so the redirect must be gone from all three states.
    it.each(["missing", "installed", "blocked"])(
      "primary click dispatches the launch and never the settings redirect when %s",
      (availability) => {
        mockSettings = settingsWith({ claude: {} });
        mockMergedPresetsFn = () => [];

        const { getByRole } = render(
          <AgentButton
            type="claude"
            availability={availability as unknown as CliAvailability[string]}
          />
        );
        fireEvent.click(getByRole("button"));

        expect(dispatchMock).toHaveBeenCalledWith(
          "agent.launch",
          { agentId: "claude" },
          { source: "user" }
        );
        expect(dispatchMock).not.toHaveBeenCalledWith(
          "app.settings.openTab",
          expect.anything(),
          expect.anything()
        );
      }
    );

    // The gate panel takes Enter as readily as a terminal does, so the blur
    // that stops a trust-prompt Enter re-firing the button (#10541) has to
    // survive on the path that used to skip it.
    it("drops focus on an unlaunchable launch click", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];

      const { getByRole } = render(
        <AgentButton type="claude" availability={"missing" as unknown as CliAvailability[string]} />
      );
      const button = getByRole("button");
      button.focus();
      expect(document.activeElement).toBe(button);

      fireEvent.click(button);

      expect(document.activeElement).not.toBe(button);
    });
  });

  describe("status dot badge", () => {
    beforeEach(() => {
      // Every waiting session here is an unread Canopy ask; working ones drop
      // out of the set by their own observation.
      mockNeedsYou = new Set(["panel-1", "panel-2"]);
    });

    afterEach(() => {
      mockNeedsYou = new Set();
    });

    it("draws no amber pip for a prompt that asks nothing", () => {
      mockNeedsYou = new Set();
      mockSettings = settingsWith({ claude: {} });
      mockPanelsById = { "panel-1": activePanel("waiting") };
      mockPanelIds = ["panel-1"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge?.getAttribute("data-visible")).not.toBe("true");
    });

    it("draws the amber pip for an ask Canopy read on a finished turn", () => {
      mockSettings = settingsWith({ claude: {} });
      mockPanelsById = { "panel-1": activePanel("completed") };
      mockPanelIds = ["panel-1"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge?.getAttribute("data-visible")).toBe("true");
      expect(badge!.className).toMatch(/bg-state-waiting/);
    });

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
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge?.getAttribute("data-visible")).toBe("true");
      expect(badge!.className).toMatch(/bg-state-waiting/);
    });

    it("keeps the waiting pip when a sibling session of the same agent is working", () => {
      // A busy session must not hide one that is waiting on the user — the
      // overflow badge counts per panel for the same reason.
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];
      mockPanelsById = {
        "panel-1": activePanel("working"),
        "panel-2": { ...activePanel("waiting"), id: "panel-2" },
      };
      mockPanelIds = ["panel-1", "panel-2"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1", "panel-2"] };
      mockActiveWorktreeId = "wt-1";

      const { container, getAllByRole, getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge?.getAttribute("data-visible")).toBe("true");
      expect(badge!.className).toMatch(/bg-state-waiting/);
      const chevronIcon = getByTestId("chevron-icon");
      const primary = getAllByRole("button").find((b) => !b.contains(chevronIcon));
      expect(primary?.getAttribute("aria-label")).toBe("Start Claude — waiting");
    });

    it.each([
      ["loading", undefined],
      ["unavailable", "missing"],
    ])("still names a visible pip's state while the CLI is %s", (_label, availability) => {
      mockSettings = settingsWith({ claude: {} });
      mockPanelsById = { "panel-1": activePanel("waiting") };
      mockPanelIds = ["panel-1"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { container, getAllByRole, getAllByTestId } = render(
        <AgentButton
          type="claude"
          availability={availability as unknown as CliAvailability[string]}
        />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge?.getAttribute("data-visible")).toBe("true");
      const primary = getAllByRole("button")[0];
      expect(primary?.getAttribute("aria-label")).toMatch(/— waiting$/);
      const tooltipTexts = getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
      expect(tooltipTexts.some((t) => t.endsWith("— waiting"))).toBe(true);
    });

    it("hides the badge span when the helper returns null (passive state)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockPanelsById = { "panel-1": activePanel("working") };
      mockPanelIds = ["panel-1"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge?.getAttribute("data-visible")).toBe("false");
    });

    it("hides the badge span when there is no active session", () => {
      mockSettings = settingsWith({ claude: {} });

      const { container } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge?.getAttribute("data-visible")).toBe("false");
    });

    it("propagates the 'waiting' state word to the launch tooltip and aria-label (issue #9823)", () => {
      // WCAG 1.4.1: the corner dot is aria-hidden, so screen readers would
      // learn nothing about the actionable state without verbal copy. The
      // suffix follows the established `— <state>` em-dash convention
      // (#8173) and reuses STATE_LABELS for the wording.
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];
      mockPanelsById = { "panel-1": activePanel("waiting") };
      mockPanelIds = ["panel-1"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { container, getAllByRole, getAllByTestId, getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const tooltipTexts = getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
      const launchTooltip = tooltipTexts.find((t) => t.startsWith("Start "));
      expect(launchTooltip).toContain("— waiting");

      const chevronIcon = getByTestId("chevron-icon");
      const primary = getAllByRole("button").find((b) => !b.contains(chevronIcon));
      expect(primary?.getAttribute("aria-label")).toBe("Start Claude — waiting");

      // Combined dot+suffix invariant — the suffix is only meaningful when
      // the dot is also painting. A regression that decouples the two (e.g.
      // dot removed, suffix kept) would mislead screen readers into thinking
      // a state is actionable when it isn't visible to the user.
      const badge = container.querySelector('.relative span[aria-hidden="true"]');
      expect(badge).not.toBeNull();
    });

    it("propagates the 'directing' state word to the launch tooltip and aria-label (issue #9823)", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];
      mockPanelsById = { "panel-1": activePanel("directing") };
      mockPanelIds = ["panel-1"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { getAllByRole, getAllByTestId, getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const tooltipTexts = getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
      const launchTooltip = tooltipTexts.find((t) => t.startsWith("Start "));
      expect(launchTooltip).toContain("— directing");

      const chevronIcon = getByTestId("chevron-icon");
      const primary = getAllByRole("button").find((b) => !b.contains(chevronIcon));
      expect(primary?.getAttribute("aria-label")).toBe("Start Claude — directing");
    });

    it("orders state suffix before sign-in suffix when both apply (issue #9823 + #8173)", () => {
      // The sign-in-not-detected and state suffixes are independent cues
      // that can co-occur (a launchable agent with a session in `waiting`
      // and a passive auth probe that came back empty). The issue contract
      // locks the order: state first, sign-in caveat second. The two
      // em-dashes are the densest form the project uses, but the order is
      // a regression target — a swap would read as the sign-in being a
      // sub-cause of the state instead of a parallel caveat.
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];
      mockPanelsById = { "panel-1": activePanel("waiting") };
      mockPanelIds = ["panel-1"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { getAllByTestId } = render(
        <AgentButton
          type="claude"
          availability={"unauthenticated" as unknown as CliAvailability[string]}
        />
      );

      const tooltipTexts = getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
      const launchTooltip = tooltipTexts.find((t) => t.startsWith("Start "));
      expect(launchTooltip).toBe("Start Claude · Blue — waiting — sign-in not detected");
    });

    it("omits the state suffix in passive states (no dot → no verbal state)", () => {
      // working is a passive state — agentStateDotColor returns null so the
      // dot doesn't render. The verbal-state suffix must mirror that gate,
      // otherwise we'd add words to a control that has no visible state.
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];
      mockPanelsById = { "panel-1": activePanel("working") };
      mockPanelIds = ["panel-1"];
      mockPanelIdsByWorktreeId = { "wt-1": ["panel-1"] };
      mockActiveWorktreeId = "wt-1";

      const { getAllByRole, getAllByTestId, getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const tooltipTexts = getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
      const launchTooltip = tooltipTexts.find((t) => t.startsWith("Start "));
      expect(launchTooltip).toBeDefined();
      expect(launchTooltip).not.toContain("— working");
      expect(launchTooltip).not.toContain("— directing");
      expect(launchTooltip).not.toContain("— waiting");

      const chevronIcon = getByTestId("chevron-icon");
      const primary = getAllByRole("button").find((b) => !b.contains(chevronIcon));
      expect(primary?.getAttribute("aria-label")).toBe("Start Claude");
    });

    it("omits the state suffix when there is no active session", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByRole, getAllByTestId, getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const tooltipTexts = getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
      const launchTooltip = tooltipTexts.find((t) => t.startsWith("Start "));
      expect(launchTooltip).toBe("Start Claude · Blue");

      const chevronIcon = getByTestId("chevron-icon");
      const primary = getAllByRole("button").find((b) => !b.contains(chevronIcon));
      expect(primary?.getAttribute("aria-label")).toBe("Start Claude");
    });
  });

  describe("disclosure chevron", () => {
    // The trigger's data-state belongs to the wrapping TooltipTrigger, so the
    // turn has to key off aria-expanded on the chevron's own button, and it has
    // to carry the marker the global reduced-motion rule targets.
    it("turns only on its own trigger's aria-expanded and is reachable by reduced motion", () => {
      mockMergedPresetsFn = () => [{ id: "only", name: "Only" }];
      const { getByTestId } = render(<AgentButton type="claude" availability="ready" />);
      const chevron = getByTestId("chevron-icon");
      expect(chevron.hasAttribute("data-animated-chevron")).toBe(true);
      expect(chevron.getAttribute("aria-hidden")).toBe("true");

      const tokens = (chevron.getAttribute("class") ?? "").split(/\s+/);
      const turns = tokens.filter((t) => /(^|:)rotate-/.test(t));
      expect(turns.length).toBeGreaterThan(0);
      const trigger = chevron.closest("button")!;
      for (const turn of turns) {
        const group = /^group-aria-expanded\/([\w-]+):rotate-/.exec(turn);
        expect(group, turn).not.toBeNull();
        expect(trigger.classList.contains(`group/${group![1]}`), turn).toBe(true);
      }
    });
  });

  describe("split-button structure", () => {
    // The split draws as one control at rest; its partition and shared wash
    // only appear on a split the chevron can actually open (toolbar/controls.css gates
    // them on data-split-live). A gated chevron blocks clicks (#8131), so a
    // split drawn as two halves there would advertise a control that isn't.
    function splitWrapper(chevronIcon: HTMLElement): HTMLElement {
      const wrapper = chevronIcon.closest<HTMLElement>(".toolbar-agent-split");
      expect(wrapper).not.toBeNull();
      return wrapper!;
    }

    it("wraps both halves in one split container, primary first", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByRole, getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const chevronIcon = getByTestId("chevron-icon");
      const wrapper = splitWrapper(chevronIcon);
      const halves = getAllByRole("button").filter((b) => wrapper.contains(b));
      expect(halves).toHaveLength(2);
      expect(halves[0]!.contains(chevronIcon)).toBe(false);
      expect(halves[1]!.contains(chevronIcon)).toBe(true);
    });

    it.each([
      ["ready", "true"],
      ["missing", "false"],
      ["installed", "false"],
    ])("marks the split live only when the chevron can open (%s)", (state, live) => {
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={state as unknown as CliAvailability[string]} />
      );
      expect(splitWrapper(getByTestId("chevron-icon")).getAttribute("data-split-live")).toBe(live);
    });

    it("is not live while availability is still loading", () => {
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getByTestId } = render(<AgentButton type="claude" availability={undefined} />);
      expect(splitWrapper(getByTestId("chevron-icon")).getAttribute("data-split-live")).toBe(
        "false"
      );
    });

    it("renders no split container on the plain button branch", () => {
      mockMergedPresetsFn = () => [];
      mockSettings = settingsWith({ claude: {} });

      const { getByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(getByRole("button").closest(".toolbar-agent-split")).toBeNull();
    });
  });

  describe("primary half describes the preset it launches", () => {
    function primaryOf(
      getAllByRole: (role: string) => HTMLElement[],
      getByTestId: (id: string) => HTMLElement
    ): HTMLElement {
      const chevronIcon = getByTestId("chevron-icon");
      return getAllByRole("button").find((b) => !b.contains(chevronIcon))!;
    }

    it("carries the saved preset in its description, leaving the name stable", () => {
      mockSettings = settingsWith({ claude: { presetId: "ccr-sonnet" } });
      mockMergedPresetsFn = () => [{ id: "ccr-sonnet", name: "CCR: Sonnet 4.5" }];

      const { getAllByRole, getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      const primary = primaryOf(getAllByRole, getByTestId);
      expect(primary.getAttribute("aria-label")).toBe("Start Claude");
      const description = primary.getAttribute("aria-description");
      expect(description).toContain("Sonnet 4.5");
      expect(description).not.toContain("CCR:");
    });

    it("has no description when nothing is saved or the saved preset is gone", () => {
      mockSettings = settingsWith({ claude: { presetId: "ghost" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByRole, getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(primaryOf(getAllByRole, getByTestId).hasAttribute("aria-description")).toBe(false);
    });

    it("drops the description when the agent can't launch", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getAllByRole, getByTestId } = render(
        <AgentButton type="claude" availability={"missing" as unknown as CliAvailability[string]} />
      );
      expect(primaryOf(getAllByRole, getByTestId).hasAttribute("aria-description")).toBe(false);
    });
  });

  describe("manage presets dropdown footer", () => {
    it("dropdown footer dispatches deep-link to the preset editor with source 'user'", () => {
      // The chevron dropdown carries a footer "Manage presets…" item that
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
      const manage = items.find((el) => el.textContent === "Manage presets…")!;
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
      fireEvent.click(getByText("Manage Claude presets…"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "agents", subtab: "claude", sectionId: "agents-presets" },
        { source: "user" }
      );
    });

    it("exposes Manage Presets that deep-links to the presets section (with-presets branch)", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { getByText } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      fireEvent.click(getByText("Manage Claude presets…"));

      expect(dispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "agents", subtab: "claude", sectionId: "agents-presets" },
        { source: "user" }
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
        <WithMenuSource>
          <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
        </WithMenuSource>
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
        <WithMenuSource>
          <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
        </WithMenuSource>
      );
      fireEvent.click(getByTestId("agent-context-worktree-dock-wt-1"));

      // The Dock click reaches the row's onSelect, which launches where the
      // click said: once, in the dock, with no grid launch alongside it.
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

    describe("keyboard route to a worktree's dock", () => {
      const launches = () => dispatchMock.mock.calls.filter((c) => c[0] === "agent.launch");
      const launchIn = (worktreeId: string, location: "grid" | "dock") => [
        "agent.launch",
        { agentId: "claude", worktreeId, location },
        { source: "context-menu" },
      ];

      const renderRows = (wrap: (children: React.ReactNode) => React.ReactNode = (c) => c) => {
        mockSettings = settingsWith({ claude: {} });
        mockMergedPresetsFn = () => [];
        mockWorktrees = [
          { id: "wt-1", name: "Main", isMainWorktree: true },
          { id: "wt-2", name: "feat/x", branch: "feat/x" },
        ];
        return render(
          <WithMenuSource>
            {wrap(<AgentButton type="claude" availability="ready" />)}
          </WithMenuSource>
        );
      };

      it("D on a worktree row launches that worktree's dock without a grid launch", () => {
        const { getByTestId } = renderRows();

        // fireEvent returns false when the handler preventDefaults, which keeps
        // Radix's typeahead from also acting on the key.
        expect(fireEvent.keyDown(getByTestId("agent-context-worktree-wt-2"), { key: "D" })).toBe(
          false
        );

        expect(launches()).toEqual([launchIn("wt-2", "dock")]);
      });

      it("the dock destination resets after the selection it launched", () => {
        const { getByTestId } = renderRows();
        const row = getByTestId("agent-context-worktree-wt-2");

        fireEvent.keyDown(row, { key: "d" });
        fireEvent.click(row);

        expect(launches()).toEqual([launchIn("wt-2", "dock"), launchIn("wt-2", "grid")]);
      });

      it("D resets the menu's pointer-gesture state before it selects", () => {
        // stopPropagation keeps the key from the content's own keydown handler,
        // which is what normally disarms a stale pointer gesture.
        const onContentKeyDown = vi.fn();
        const focusRestore = {
          setRestoreTarget: () => {},
          resetForOpen: () => {},
          deferToRadix: () => {},
          onContentPointerDown: () => {},
          onContentPointerDownOutside: () => {},
          onContentInteractOutside: () => {},
          onContentKeyDown,
          onContentClick: () => {},
          onContentCloseAutoFocus: () => {},
        } satisfies OverlayFocusRestore;
        const { getByTestId } = renderRows((children) => (
          <OverlayFocusRestoreContext.Provider value={focusRestore}>
            {children}
          </OverlayFocusRestoreContext.Provider>
        ));

        fireEvent.keyDown(getByTestId("agent-context-worktree-wt-2"), { key: "d" });

        expect(onContentKeyDown).toHaveBeenCalledTimes(1);
        expect(launches()).toEqual([launchIn("wt-2", "dock")]);
        expect(onContentKeyDown.mock.invocationCallOrder[0]).toBeLessThan(
          dispatchMock.mock.invocationCallOrder[0]!
        );
      });

      it("keeps D from reaching ancestor key handlers and lets every other key through", () => {
        const onAncestorKeyDown = vi.fn();
        const { getByTestId } = renderRows((children) => (
          <div onKeyDown={(e) => onAncestorKeyDown(e.key)}>{children}</div>
        ));
        const row = getByTestId("agent-context-worktree-wt-1");

        fireEvent.keyDown(row, { key: "d" });
        expect(onAncestorKeyDown).not.toHaveBeenCalled();
        dispatchMock.mockClear();

        for (const init of [
          { key: "Enter" },
          { key: " " },
          { key: "f" },
          { key: "d", metaKey: true },
          { key: "d", ctrlKey: true },
          { key: "d", altKey: true },
        ]) {
          expect(fireEvent.keyDown(row, init), JSON.stringify(init)).toBe(true);
        }
        expect(onAncestorKeyDown.mock.calls.map((c) => c[0])).toEqual([
          "Enter",
          " ",
          "f",
          "d",
          "d",
          "d",
        ]);
        expect(dispatchMock).not.toHaveBeenCalled();
      });

      it("names the D route to assistive tech while the icon and key cap stay hidden", () => {
        const { getByTestId } = renderRows();
        for (const id of ["wt-1", "wt-2"]) {
          const row = getByTestId(`agent-context-worktree-${id}`);
          const instruction = row.querySelector(".sr-only");
          expect(instruction?.textContent).toBe(", press D to launch in dock");
          expect(instruction?.closest('[aria-hidden="true"]')).toBeNull();

          expect(getByTestId(`agent-context-worktree-dock-${id}`).getAttribute("aria-hidden")).toBe(
            "true"
          );
          // The visible key cap is decoration for sighted keyboard users; the
          // instruction above already speaks it, so announcing it twice is noise.
          const keyCap = Array.from(row.children).find(
            (el) => el.getAttribute("aria-hidden") === "true" && el.querySelector("kbd")
          );
          expect(keyCap).toBeDefined();
        }
      });
    });

    it("hides the Launch in worktree submenu when no worktrees exist", () => {
      mockSettings = settingsWith({ claude: {} });
      mockMergedPresetsFn = () => [];
      mockWorktrees = [];

      const { queryByText } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );
      expect(queryByText("Launch in worktree")).toBeNull();
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

  describe("aria-disabled gating (issue #8107)", () => {
    it("primary button uses aria-disabled (not native disabled) while loading and the click is guarded", () => {
      // availability === undefined ⇒ isLoading. Native `disabled` would
      // strip pointer events and the Tooltip explaining the wait would
      // never show, so we expose aria-disabled and guard the handler.
      mockMergedPresetsFn = () => [];

      const { getByRole } = render(
        <WithMenuSource>
          <AgentButton type="claude" availability={undefined} />
        </WithMenuSource>
      );

      const button = getByRole("button");
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(false);

      fireEvent.click(button);
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("primary button is not aria-disabled when the agent is ready", () => {
      mockMergedPresetsFn = () => [];

      const { getByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      expect(getByRole("button").getAttribute("aria-disabled")).toBeNull();
    });

    it("chevron button is aria-disabled and blocks the menu open via preventDefault when not launchable", () => {
      mockMergedPresetsFn = () => [{ id: "only", name: "Only" }];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={"missing" as unknown as CliAvailability[string]} />
      );

      const chevron = getByTestId("chevron-icon").closest("button");
      expect(chevron).toBeTruthy();
      expect(chevron!.getAttribute("aria-disabled")).toBe("true");
      expect(chevron!.hasAttribute("disabled")).toBe(false);

      // fireEvent returns false when a handler called preventDefault, which
      // is what stops Radix's pointerdown-driven open from firing.
      expect(fireEvent.pointerDown(chevron!)).toBe(false);
    });

    it("chevron button stays interactive (no preventDefault) when launchable", () => {
      mockMergedPresetsFn = () => [{ id: "only", name: "Only" }];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      const chevron = getByTestId("chevron-icon").closest("button");
      expect(chevron).toBeTruthy();
      expect(chevron!.getAttribute("aria-disabled")).toBeNull();
      expect(fireEvent.pointerDown(chevron!)).toBe(true);
    });

    it("split-button primary is aria-disabled while loading and the click is guarded", () => {
      // The with-presets branch is a separate JSX tree from the plain
      // button; assert it carries the same aria-disabled + click guard.
      mockMergedPresetsFn = () => [{ id: "p", name: "P" }];

      const { getByTestId, getAllByRole } = render(
        <AgentButton type="claude" availability={undefined} />
      );

      const buttons = getAllByRole("button");
      for (const button of buttons) {
        expect(button.getAttribute("aria-disabled")).toBe("true");
        expect(button.hasAttribute("disabled")).toBe(false);
      }

      const chevronIcon = getByTestId("chevron-icon");
      const primary = buttons.find((b) => !b.contains(chevronIcon));
      expect(primary).toBeTruthy();
      fireEvent.click(primary!);
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("chevron copy names the precondition (no blocked 'Click to …' promise) when not launchable", () => {
      // The chevron blocks clicks when not launchable, so its
      // tooltip/aria-label must not imperatively promise an action.
      for (const state of ["missing", "installed"]) {
        mockMergedPresetsFn = () => [{ id: "only", name: "Only" }];
        const { getByTestId, unmount } = render(
          <AgentButton type="claude" availability={state as unknown as CliAvailability[string]} />
        );
        const chevron = getByTestId("chevron-icon").closest("button");
        expect(chevron!.getAttribute("aria-label")).toBeTruthy();
        expect(chevron!.getAttribute("aria-label")).not.toMatch(/click to/i);
        unmount();
      }
    });

    it("chevron blocks keyboard menu-open keys via preventDefault when not launchable", () => {
      mockMergedPresetsFn = () => [{ id: "only", name: "Only" }];

      const { getByTestId } = render(
        <AgentButton type="claude" availability={"missing" as unknown as CliAvailability[string]} />
      );

      const chevron = getByTestId("chevron-icon").closest("button");
      for (const key of ["Enter", " ", "ArrowDown"]) {
        expect(fireEvent.keyDown(chevron!, { key })).toBe(false);
      }
    });
  });

  describe("tooltip and aria copy (issue #8173)", () => {
    function tooltipTexts(getAllByTestId: (id: string) => HTMLElement[]): string[] {
      return getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
    }

    it("loading tooltip uses the Unicode ellipsis and the aria-label omits it", () => {
      mockMergedPresetsFn = () => [];

      const { getByRole, getAllByTestId } = render(
        <AgentButton type="claude" availability={undefined} />
      );

      // Tooltip carries U+2026, no redundant "availability", no ASCII "...".
      expect(tooltipTexts(getAllByTestId)).toContain("Checking Claude CLI…");
      // Aria-label is the plain accessible name — punctuation glyphs like the
      // ellipsis are meaningless to screen readers and must not leak in.
      expect(getByRole("button").getAttribute("aria-label")).toBe("Checking Claude CLI");
    });

    it("loading copy holds in the split-button (with-presets) branch", () => {
      mockMergedPresetsFn = () => [{ id: "p", name: "P" }];

      const { getByTestId, getAllByRole, getAllByTestId } = render(
        <AgentButton type="claude" availability={undefined} />
      );

      expect(tooltipTexts(getAllByTestId)).toContain("Checking Claude CLI…");
      const chevronIcon = getByTestId("chevron-icon");
      const primary = getAllByRole("button").find((b) => !b.contains(chevronIcon));
      expect(primary!.getAttribute("aria-label")).toBe("Checking Claude CLI");
    });

    // The click routes to the recovery panel, so the accessible name has to
    // describe that outcome — and word it the way the dock rows already do,
    // or the same agent announces two different things in two surfaces.
    it("non-launchable copy names the recovery panel, matching the dock hint", () => {
      const cases: Array<[string, string]> = [
        ["missing", "Claude needs setup. Select to see recovery options"],
        ["installed", "Claude needs setup. Select to see recovery options"],
        ["blocked", "Claude is blocked by endpoint security. Select to see recovery options"],
      ];
      for (const [state, expected] of cases) {
        mockMergedPresetsFn = () => [];
        const { getByRole, getAllByTestId, unmount } = render(
          <AgentButton type="claude" availability={state as unknown as CliAvailability[string]} />
        );
        expect(tooltipTexts(getAllByTestId)).toContain(expected);
        expect(getByRole("button").getAttribute("aria-label")).toBe(expected);
        unmount();
      }
    });

    it("ready aria-label drops the redundant 'Agent' suffix", () => {
      mockMergedPresetsFn = () => [];

      const { getByRole } = render(
        <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
      );

      expect(getByRole("button").getAttribute("aria-label")).toBe("Start Claude");
    });

    it("unauthenticated state keeps the aria-label clean while the tooltip carries the sign-in cue", () => {
      mockSettings = settingsWith({ claude: { presetId: "user-blue" } });
      mockMergedPresetsFn = () => [{ id: "user-blue", name: "Blue" }];

      const { getByTestId, getAllByRole, getAllByTestId } = render(
        <AgentButton
          type="claude"
          availability={"unauthenticated" as unknown as CliAvailability[string]}
        />
      );

      const launchTooltip = tooltipTexts(getAllByTestId).find((t) => t.startsWith("Start "));
      expect(launchTooltip).toContain("sign-in not detected");

      const chevronIcon = getByTestId("chevron-icon");
      const primary = getAllByRole("button").find((b) => !b.contains(chevronIcon));
      // The sign-in suffix is a tooltip-only cue; it must not bleed into the
      // accessible name.
      expect(primary!.getAttribute("aria-label")).toBe("Start Claude");
    });
  });
});

describe("AgentButton right-click unpin — issue #9825", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    updateWorktreePresetMock.mockClear();
    updateAgentMock.mockClear();
    setAgentPinnedMock.mockClear();
    mockSettings = settingsWith({ claude: {} });
    mockActiveWorktreeId = null;
    mockCcrPresetsByAgent = {};
    mockMergedPresetsFn = () => [];
    mockCliDetails = {};
    mockPanelsById = {};
    mockPanelIds = [];
    mockPanelIdsByWorktreeId = {};
    mockWorktrees = [];
    mockExternalLinks = undefined;
  });

  it("routes the no-presets branch's unpin to setAgentPinned (not pinnedButtons)", () => {
    render(
      <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
    );
    // The new wrapper routes the unpin via onUnpin override for agent IDs.
    // The "Unpin from toolbar" item lives in the right-click content; find
    // it and click it.
    const items = screen.getAllByTestId("context-menu-item");
    const unpin = items.find((el) => el.textContent?.includes("Unpin from toolbar"));
    expect(unpin, "no Unpin-from-toolbar menu item rendered").toBeTruthy();
    fireEvent.click(unpin!);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
  });

  it("routes the has-presets branch's unpin to setAgentPinned", () => {
    mockMergedPresetsFn = (id: string) => [
      { id: `${id}-blue`, name: "Blue" },
      { id: `${id}-green`, name: "Green" },
    ];
    render(
      <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
    );
    const items = screen.getAllByTestId("context-menu-item");
    const unpin = items.find((el) => el.textContent?.includes("Unpin from toolbar"));
    expect(unpin).toBeTruthy();
    fireEvent.click(unpin!);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
  });

  it("exposes the Customize toolbar… entry on the right-click content for both branches", () => {
    const { rerender } = render(
      <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
    );
    const itemsNoPresets = screen.getAllByTestId("context-menu-item");
    const customizeNoPresets = itemsNoPresets.find((el) =>
      el.textContent?.includes("Customize toolbar")
    );
    expect(customizeNoPresets, "Customize entry missing in no-presets branch").toBeTruthy();

    mockMergedPresetsFn = (id: string) => [{ id: `${id}-blue`, name: "Blue" }];
    rerender(
      <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
    );
    const itemsHasPresets = screen.getAllByTestId("context-menu-item");
    const customizeHasPresets = itemsHasPresets.find((el) =>
      el.textContent?.includes("Customize toolbar")
    );
    expect(customizeHasPresets, "Customize entry missing in has-presets branch").toBeTruthy();
  });
});

describe("AgentButton external links — issue #10350", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    mockSettings = null;
    mockActiveWorktreeId = null;
    mockCcrPresetsByAgent = {};
    mockMergedPresetsFn = () => [];
    mockCliDetails = {};
    mockPanelsById = {};
    mockPanelIds = [];
    mockPanelIdsByWorktreeId = {};
    mockWorktrees = [];
    mockExternalLinks = [{ label: "View usage", url: "https://example.com/usage" }];
  });

  function findLinkItem() {
    const items = screen.getAllByTestId("context-menu-item");
    return items.find((el) => el.textContent?.includes("View usage"));
  }

  it("renders the link in the no-presets context menu and dispatches system.openExternal", () => {
    render(
      <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
    );
    const link = findLinkItem();
    expect(link, "external link missing in no-presets branch").toBeTruthy();
    fireEvent.click(link!);
    expect(dispatchMock).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://example.com/usage" },
      expect.objectContaining({ source: "user" })
    );
  });

  it("renders the link in the has-presets context menu too", () => {
    mockMergedPresetsFn = (id: string) => [{ id: `${id}-blue`, name: "Blue" }];
    render(
      <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
    );
    const link = findLinkItem();
    expect(link, "external link missing in has-presets branch").toBeTruthy();
    fireEvent.click(link!);
    expect(dispatchMock).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://example.com/usage" },
      expect.objectContaining({ source: "user" })
    );
  });

  it("renders no link item or icon when the agent declares no externalLinks", () => {
    mockExternalLinks = undefined;
    render(
      <AgentButton type="claude" availability={"ready" as unknown as CliAvailability[string]} />
    );
    expect(findLinkItem()).toBeUndefined();
    expect(screen.queryByTestId("external-link-icon")).toBeNull();
  });
});

// Every mocked glyph above renders a `*-icon` test id, so "leads with an icon"
// is readable without knowing which icon a row carries — the rule, not the pick.
function rowsMissingLeadingIcon(content: HTMLElement): string[] {
  return Array.from(content.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .filter((row) => !row.firstElementChild?.getAttribute("data-testid")?.endsWith("-icon"))
    .map((row) => row.textContent ?? "");
}

describe("AgentButton context menu — every actionable row leads with an icon", () => {
  beforeEach(() => {
    mockSettings = settingsWith({ claude: {} });
    mockActiveWorktreeId = null;
    mockCcrPresetsByAgent = {};
    mockProjectPresetsByAgent = {};
    mockCliDetails = {};
    mockPanelsById = {};
    mockPanelIds = [];
    mockPanelIdsByWorktreeId = {};
    mockWorktrees = [
      { id: "wt-1", name: "Main", isMainWorktree: true },
      { id: "wt-2", name: "feat/x", branch: "feat/x" },
    ];
    mockExternalLinks = [{ label: "View usage", url: "https://example.com/usage" }];
  });

  it("without presets", () => {
    mockMergedPresetsFn = () => [];
    render(<AgentButton type="claude" availability="ready" />);
    const content = screen.getByTestId("context-menu-content");
    expect(content.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(5);
    expect(rowsMissingLeadingIcon(content)).toEqual([]);
  });

  it("with presets", () => {
    mockMergedPresetsFn = () => [{ id: "p1", name: "Fast" }];
    render(<AgentButton type="claude" availability="ready" />);
    const content = screen.getByTestId("context-menu-content");
    expect(content.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(5);
    expect(rowsMissingLeadingIcon(content)).toEqual([]);
  });
});
