// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, within } from "@testing-library/react";
import type { AgentSettings } from "@shared/types";

const setLeftButtonsMock = vi.fn<(ids: string[]) => void>();
const setRightButtonsMock = vi.fn();
const moveButtonMock = vi.fn();
const toggleButtonVisibilityMock = vi.fn();
const setPluginButtonPromotedMock = vi.fn();
const setPanelButtonOnToolbarMock = vi.fn();
const setLauncherItemOnToolbarMock = vi.fn();
const setAlwaysShowDevServerMock = vi.fn();
const setDefaultSelectionMock = vi.fn();
const resetMock = vi.fn();
const setAgentPinnedMock = vi.fn().mockResolvedValue(undefined);

interface ToolbarState {
  layout: {
    leftButtons: string[];
    rightButtons: string[];
    pinnedButtons: Record<string, boolean>;
  };
  launcher: {
    alwaysShowDevServer: boolean;
    defaultSelection?: string;
  };
  setLeftButtons: typeof setLeftButtonsMock;
  setRightButtons: typeof setRightButtonsMock;
  moveButton: typeof moveButtonMock;
  toggleButtonVisibility: typeof toggleButtonVisibilityMock;
  setPluginButtonPromoted: typeof setPluginButtonPromotedMock;
  setPanelButtonOnToolbar: typeof setPanelButtonOnToolbarMock;
  setLauncherItemOnToolbar: typeof setLauncherItemOnToolbarMock;
  setAlwaysShowDevServer: typeof setAlwaysShowDevServerMock;
  setDefaultSelection: typeof setDefaultSelectionMock;
  reset: typeof resetMock;
}

function makeToolbarState(
  layout: ToolbarState["layout"] = {
    // Mix of agent IDs and non-agent IDs so we can test both branches.
    leftButtons: ["launcher", "claude", "gemini", "terminal"],
    rightButtons: ["copy-tree", "settings"],
    pinnedButtons: {},
  }
): ToolbarState {
  return {
    layout,
    launcher: { alwaysShowDevServer: false, defaultSelection: undefined },
    setLeftButtons: setLeftButtonsMock,
    setRightButtons: setRightButtonsMock,
    moveButton: moveButtonMock,
    toggleButtonVisibility: toggleButtonVisibilityMock,
    setPluginButtonPromoted: setPluginButtonPromotedMock,
    setPanelButtonOnToolbar: setPanelButtonOnToolbarMock,
    setLauncherItemOnToolbar: setLauncherItemOnToolbarMock,
    setAlwaysShowDevServer: setAlwaysShowDevServerMock,
    setDefaultSelection: setDefaultSelectionMock,
    reset: resetMock,
  };
}

let mockToolbarState: ToolbarState = makeToolbarState();
let mockAgentSettings: AgentSettings | null = null;

function clearStoreMocks() {
  setLeftButtonsMock.mockClear();
  setRightButtonsMock.mockClear();
  moveButtonMock.mockClear();
  toggleButtonVisibilityMock.mockClear();
  setPluginButtonPromotedMock.mockClear();
  setPanelButtonOnToolbarMock.mockClear();
  setLauncherItemOnToolbarMock.mockClear();
  setAlwaysShowDevServerMock.mockClear();
  setDefaultSelectionMock.mockClear();
  resetMock.mockClear();
  setAgentPinnedMock.mockClear();
}

// `getState` too: the drop handlers read the stored arrays at commit time, not
// the render-time snapshot.
vi.mock("@/store", () => ({
  useToolbarPreferencesStore: Object.assign(
    (selector: (s: ToolbarState) => unknown) => selector(mockToolbarState),
    { getState: () => mockToolbarState }
  ),
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (
    selector: (s: {
      settings: AgentSettings | null;
      setAgentPinned: typeof setAgentPinnedMock;
    }) => unknown
  ) => selector({ settings: mockAgentSettings, setAgentPinned: setAgentPinnedMock }),
}));

const mockRecipes = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string }> }));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: (selector: (s: { recipes: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ recipes: mockRecipes.list }),
}));

// No availability data by default, so every agent not on the toolbar is listed
// without the uninstalled-agent disclosure; the disclosure tests set it.
const mockAvailability = vi.hoisted(() => ({
  value: undefined as Record<string, string> | undefined,
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (
    selector: (s: { availability: Record<string, string> | undefined }) => unknown
  ) => selector({ availability: mockAvailability.value }),
}));

vi.mock("@shared/config/agentIds", () => {
  const BUILT_IN_AGENT_IDS = ["claude", "gemini", "codex"] as const;
  const ASSISTANT_ONLY_AGENT_IDS = [] as const;
  const LAUNCHABLE_AGENT_IDS = BUILT_IN_AGENT_IDS;
  return {
    BUILT_IN_AGENT_IDS,
    ASSISTANT_ONLY_AGENT_IDS,
    LAUNCHABLE_AGENT_IDS,
    isBuiltInAgentId: (value: unknown): value is (typeof BUILT_IN_AGENT_IDS)[number] =>
      typeof value === "string" && BUILT_IN_AGENT_IDS.includes(value as never),
    isAssistantOnlyAgentId: () => false,
  };
});

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    icon: () => null,
  }),
}));

const pluginButtons = vi.hoisted(() => ({
  configs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/hooks/usePluginToolbarButtons", () => ({
  usePluginToolbarButtons: () => ({
    buttonIds: Array.from(pluginButtons.configs.keys()),
    configs: pluginButtons.configs,
  }),
}));

// Capture the single DndContext's props so tests can drive the drag handlers
// directly — the mock renders children but never wires real pointer events.
const dnd = vi.hoisted(() => ({
  props: null as Record<string, (event: unknown) => void> | null,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { children: React.ReactNode } & Record<string, unknown>) => {
    dnd.props = props as unknown as Record<string, (event: unknown) => void>;
    return <>{props.children}</>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCorners: vi.fn(),
  pointerWithin: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
  rectSortingStrategy: vi.fn(),
  arrayMove: <T,>(arr: T[], from: number, to: number): T[] => {
    const next = arr.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as T);
    return next;
  },
}));

// Test-time helper for restoring the default useSortable return between
// cases (the mock factory above is hoisted, so it can't reference this).
const defaultSortable = (): ReturnType<typeof useSortable> =>
  ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }) as unknown as ReturnType<typeof useSortable>;

// The real menu pulls in the keybinding service; a flat stand-in keeps the
// move items reachable as plain menuitems.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({
    children,
    description,
    title,
  }: {
    children: React.ReactNode;
    description?: string;
    title?: string;
  }) => (
    <section data-testid={`section-${title}`} data-description={description}>
      {children}
    </section>
  ),
}));

vi.mock("../SettingsSwitchCard", () => ({
  SettingsSwitchCard: () => null,
}));

// Render the switch as a plain role="switch" button so tests stay decoupled
// from Radix's pointer-event internals while preserving the aria contract.
vi.mock("../SettingsSwitch", () => ({
  SettingsSwitch: ({
    id,
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
    className,
  }: {
    id?: string;
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    "aria-label"?: string;
    className?: string;
  }) => (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-state={checked ? "checked" : "unchecked"}
      className={className}
      onClick={() => onCheckedChange(!checked)}
    >
      {ariaLabel}
    </button>
  ),
}));

import { useSortable } from "@dnd-kit/sortable";
import { DRAG_GHOST_OPACITY } from "@/lib/animationUtils";
import { TOOLBAR_BUTTON_METADATA } from "@/components/Layout/toolbarButtonMetadata";
import { LAUNCHER_PANEL_BUTTON_IDS } from "@shared/types/toolbar";
import { ToolbarSettingsTab } from "../ToolbarSettingsTab";

function agentSettings(overrides: Record<string, { pinned?: boolean }>): AgentSettings {
  return { agents: overrides } as unknown as AgentSettings;
}

function switchName(label: string): string {
  return `Show ${label} on the toolbar`;
}

function switchNamesIn(root: ParentNode | null): string[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll('[role="switch"]')).map(
    (el) => el.getAttribute("aria-label") ?? ""
  );
}

function leftColumn(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("#toolbar-left-buttons")!;
}

function rightColumn(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("#toolbar-right-buttons")!;
}

// The SettingsSection mock tags each section by title; the pool is absent
// entirely when every button is on the toolbar.
function poolSection(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="section-Not on the toolbar"]');
}

function poolGroup(container: HTMLElement, name: string): HTMLElement | null {
  const pool = poolSection(container);
  if (!pool) return null;
  return within(pool).queryByRole("group", { name });
}

describe("ToolbarSettingsTab — agent visibility routing", () => {
  beforeEach(() => {
    clearStoreMocks();
    vi.mocked(useSortable).mockImplementation(defaultSortable);
    mockToolbarState = makeToolbarState();
    mockAgentSettings = null;
  });

  it("shows agent rows as checked when pinned in agentSettingsStore", () => {
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      gemini: { pinned: false },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);

    expect(getByLabelText(switchName("Claude agent")).getAttribute("aria-checked")).toBe("true");
    expect(getByLabelText(switchName("Gemini agent")).getAttribute("aria-checked")).toBe("false");
  });

  it("ignores pinnedButtons for agent IDs (agentSettingsStore wins)", () => {
    // Stale entry from pre-migration persisted state — the UI must still
    // derive the agent's visibility from `agentSettingsStore`, not from
    // `pinnedButtons`.
    mockToolbarState.layout.pinnedButtons = { claude: false };
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    expect(getByLabelText(switchName("Claude agent")).getAttribute("aria-checked")).toBe("true");
  });

  it("routes agent switch toggle to setAgentPinned (not toggleButtonVisibility)", () => {
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Claude agent")));

    expect(setAgentPinnedMock).toHaveBeenCalledTimes(1);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("routes agent switch toggle upward (unpinned → pinned) via setAgentPinned", () => {
    mockAgentSettings = agentSettings({
      gemini: { pinned: false },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Gemini agent")));

    expect(setAgentPinnedMock).toHaveBeenCalledWith("gemini", true);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("keeps plain built-in toggles on toggleButtonVisibility", () => {
    // The launcher, not `terminal`: since #11680 terminal is a launcher panel
    // button and routes through `setPanelButtonOnToolbar` with the other three,
    // so a left-side built-in that stays on the generic path is the honest
    // subject here.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Launcher")));

    expect(toggleButtonVisibilityMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("launcher", "left");
    expect(setAgentPinnedMock).not.toHaveBeenCalled();
  });

  it("routes the terminal toggle through the launcher panel setter", () => {
    // The #11680 unification: every Panels row writes the same way, so terminal
    // stopped being a plain built-in the moment it gained a launcher row.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Terminal")));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("terminal", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("dispatches `'right'` as the side argument for right-side non-agent toggles", () => {
    // Locks the side argument so future side-aware store changes can't
    // silently swallow the right-side branch — both columns are nominally
    // identical today but each is independently wired.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Copy context")));

    expect(toggleButtonVisibilityMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("copy-tree", "right");
  });

  it("shows a hidden file browser with its switch off (#11495)", () => {
    // `file-browser` ships visible since #11667, but a user can still hide it —
    // and Settings has to render that state honestly. A fixture of its own
    // rather than the shared default, so the visible-count and drag-array
    // expectations elsewhere in this file stay put.
    mockToolbarState = makeToolbarState({
      leftButtons: ["terminal", "browser", "file-browser", "dev-server"],
      rightButtons: ["settings"],
      pinnedButtons: { "file-browser": false },
    });

    const { getByLabelText, container } = render(<ToolbarSettingsTab />);
    const toggle = getByLabelText(switchName("Browse files"));

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // Off the toolbar, so it is listed with the other panels rather than in its column.
    expect(switchNamesIn(poolGroup(container, "Panels"))).toContain(switchName("Browse files"));
    expect(switchNamesIn(leftColumn(container))).not.toContain(switchName("Browse files"));
  });

  it("routes a panel-button opt-in to setPanelButtonOnToolbar, never the generic toggle (#11667)", () => {
    // The generic toggle shows a button by DELETING its pin key, which leaves
    // nothing recording that the user asked for it. `browser` and `dev-server`
    // are not defaults, so a stale sibling view's write — which replaces the
    // position arrays wholesale — would then silently un-promote them with
    // nothing left to rebuild the position from.
    mockToolbarState = makeToolbarState({
      leftButtons: ["terminal", "browser", "file-browser", "launcher"],
      rightButtons: ["settings"],
      pinnedButtons: { browser: false },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Browser")));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("browser", true);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
    expect(setAgentPinnedMock).not.toHaveBeenCalled();
  });

  it("routes a panel-button hide through the same action", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["terminal", "file-browser", "launcher"],
      rightButtons: ["settings"],
      pinnedButtons: {},
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Browse files")));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("file-browser", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("reflects pinned agents in the side visible-count summary", () => {
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      gemini: { pinned: false },
    });

    const { getByText } = render(<ToolbarSettingsTab />);
    // Left side: launcher (visible), claude (pinned, visible),
    // gemini (unpinned, not visible), terminal (not hidden, visible) => 3.
    expect(getByText("Left side · 3 buttons")).toBeTruthy();
  });

  it("treats null agentSettings as all-unpinned without crashing", () => {
    mockAgentSettings = null;

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    expect(getByLabelText(switchName("Claude agent")).getAttribute("aria-checked")).toBe("false");
  });

  it("handles a right-side agent correctly (routes through setAgentPinned)", () => {
    // Relocate codex to the right side — an unlikely but possible layout.
    mockToolbarState.layout = {
      leftButtons: ["launcher", "terminal"],
      rightButtons: ["codex", "settings"],
      pinnedButtons: {},
    };
    mockAgentSettings = agentSettings({
      codex: { pinned: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Codex agent")));

    expect(setAgentPinnedMock).toHaveBeenCalledWith("codex", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });
});

describe("ToolbarSettingsTab — one row per button", () => {
  beforeEach(() => {
    clearStoreMocks();
    vi.mocked(useSortable).mockImplementation(defaultSortable);
    mockAgentSettings = null;
  });

  afterEach(() => {
    mockToolbarState = makeToolbarState();
  });

  it("gives every button exactly one switch at rest, off ones outside their column", () => {
    // A grandfathered profile: every agent still holds a slot in the left array,
    // but none is on the toolbar — two unpinned explicitly, codex unpinned and
    // not installed.
    mockToolbarState = makeToolbarState({
      leftButtons: ["launcher", "claude", "gemini", "codex", "terminal"],
      rightButtons: ["copy-tree", "settings"],
      pinnedButtons: {},
    });
    mockAgentSettings = agentSettings({
      claude: { pinned: false },
      gemini: { pinned: false },
    });

    const { container } = render(<ToolbarSettingsTab />);
    const ids = new Set<string>([
      ...mockToolbarState.layout.leftButtons,
      ...mockToolbarState.layout.rightButtons,
      ...LAUNCHER_PANEL_BUTTON_IDS,
    ]);
    const names = switchNamesIn(container);

    const metadata = new Map(Object.entries(TOOLBAR_BUTTON_METADATA));
    for (const id of ids) {
      const label = metadata.get(id)!.label;
      expect({ id, count: names.filter((n) => n === switchName(label)).length }).toEqual({
        id,
        count: 1,
      });
    }

    const columns = [
      ...switchNamesIn(leftColumn(container)),
      ...switchNamesIn(rightColumn(container)),
    ];
    for (const agent of ["Claude agent", "Gemini agent", "Codex agent"]) {
      expect(columns).not.toContain(switchName(agent));
      expect(switchNamesIn(poolGroup(container, "Agents"))).toContain(switchName(agent));
    }
  });

  it("keeps the pressed switch mounted in place when it is flipped either way", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["launcher", "claude", "terminal"],
      rightButtons: ["settings"],
      pinnedButtons: {},
    });
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      codex: { pinned: false },
    });

    const { container, getByLabelText, rerender } = render(<ToolbarSettingsTab />);

    // Column row switched off: stays in its column, off, and not also in the pool.
    const claudeSwitch = getByLabelText(switchName("Claude agent"));
    expect(leftColumn(container).contains(claudeSwitch)).toBe(true);
    fireEvent.click(claudeSwitch);
    mockAgentSettings = agentSettings({
      claude: { pinned: false },
      codex: { pinned: false },
    });
    rerender(<ToolbarSettingsTab />);

    expect(claudeSwitch.isConnected).toBe(true);
    expect(leftColumn(container).contains(claudeSwitch)).toBe(true);
    expect(claudeSwitch.getAttribute("aria-checked")).toBe("false");
    expect(switchNamesIn(poolSection(container))).not.toContain(switchName("Claude agent"));

    // Pool row switched on: stays in the pool, on.
    const codexSwitch = getByLabelText(switchName("Codex agent"));
    expect(poolSection(container)!.contains(codexSwitch)).toBe(true);
    fireEvent.click(codexSwitch);
    expect(setAgentPinnedMock).toHaveBeenLastCalledWith("codex", true);
    // What the store does on a pin: record it and give the agent a slot.
    mockAgentSettings = agentSettings({
      claude: { pinned: false },
      codex: { pinned: true },
    });
    mockToolbarState = makeToolbarState({
      ...mockToolbarState.layout,
      leftButtons: [...mockToolbarState.layout.leftButtons, "codex"],
    });
    rerender(<ToolbarSettingsTab />);

    expect(codexSwitch.isConnected).toBe(true);
    expect(poolSection(container)!.contains(codexSwitch)).toBe(true);
    expect(codexSwitch.getAttribute("aria-checked")).toBe("true");
    // Still one switch for it while the user is working there.
    expect(switchNamesIn(container).filter((n) => n === switchName("Codex agent"))).toHaveLength(1);

    // Once the pointer leaves the section, it moves up to where it landed.
    act(() => {
      fireEvent.pointerLeave(poolSection(container)!.parentElement!);
    });
    expect(switchNamesIn(leftColumn(container))).toContain(switchName("Codex agent"));
    expect(switchNamesIn(container).filter((n) => n === switchName("Codex agent"))).toHaveLength(1);
  });
});

describe("ToolbarSettingsTab — drag reordering and cross-side moves", () => {
  beforeEach(() => {
    clearStoreMocks();
    vi.mocked(useSortable).mockImplementation(defaultSortable);
    mockToolbarState = makeToolbarState();
    mockAgentSettings = null;
  });

  function fire(name: string, event: unknown) {
    // Assert the handler exists before invoking it: optional chaining would
    // silently no-op if the component stopped wiring it, quietly turning every
    // negative assertion below into a test that proves nothing.
    const handler = dnd.props?.[name];
    expect(typeof handler).toBe("function");
    act(() => {
      handler!(event);
    });
  }

  it("commits a same-side reorder via setLeftButtons (not moveButton)", () => {
    render(<ToolbarSettingsTab />);

    // Drag "claude" onto "gemini" — both agents, so the reorder is legal.
    fire("onDragEnd", { active: { id: "claude" }, over: { id: "gemini" } });

    expect(setLeftButtonsMock).toHaveBeenCalledTimes(1);
    expect(setLeftButtonsMock).toHaveBeenCalledWith(["launcher", "gemini", "claude", "terminal"]);
    expect(moveButtonMock).not.toHaveBeenCalled();
  });

  // #11681
  it("shows the left column in canonical group order for a legacy interleaved array", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["terminal", "claude", "launcher", "gemini"],
      rightButtons: [],
      pinnedButtons: {},
    });
    mockAgentSettings = agentSettings({ claude: { pinned: true }, gemini: { pinned: true } });

    const { container } = render(<ToolbarSettingsTab />);

    expect(switchNamesIn(leftColumn(container))).toEqual([
      switchName("Launcher"),
      switchName("Claude agent"),
      switchName("Gemini agent"),
      switchName("Terminal"),
    ]);
  });

  it("snaps a cross-group drag back into its own group, writing nothing", () => {
    render(<ToolbarSettingsTab />);

    // Drag the launcher past the agents onto "terminal". Grouping puts it back
    // at the head, so the effective order is unchanged and no write is needed.
    fire("onDragEnd", { active: { id: "launcher" }, over: { id: "terminal" } });

    expect(setLeftButtonsMock).not.toHaveBeenCalled();
    expect(setRightButtonsMock).not.toHaveBeenCalled();
    expect(moveButtonMock).not.toHaveBeenCalled();
  });

  it("regroups the left column live during a cross-side drag", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["launcher", "claude", "gemini"],
      rightButtons: ["terminal"],
      pinnedButtons: {},
    });
    mockAgentSettings = agentSettings({ claude: { pinned: true }, gemini: { pinned: true } });

    const { container } = render(<ToolbarSettingsTab />);

    // Drop the panel into the middle of the agent block. The preview must show
    // it after the agents, not where the pointer is — otherwise the gap opens
    // somewhere the button will never land.
    fire("onDragStart", { active: { id: "terminal" } });
    fire("onDragOver", {
      active: { id: "terminal", rect: { current: { translated: { top: 0, height: 20 } } } },
      over: { id: "gemini", rect: { top: 0, height: 100 } },
    });

    // Scoped to the column: the DragOverlay renders its own card for the
    // button under the cursor outside both columns.
    expect(switchNamesIn(leftColumn(container))).toEqual([
      switchName("Launcher"),
      switchName("Claude agent"),
      switchName("Gemini agent"),
      switchName("Terminal"),
    ]);
  });

  it("translates a right-to-left drop into an index that survives grouping", () => {
    mockToolbarState = makeToolbarState({
      // Stored interleaved: the panel sits ahead of the agent.
      leftButtons: ["terminal", "claude"],
      rightButtons: ["codex"],
      pinnedButtons: {},
    });

    render(<ToolbarSettingsTab />);

    // The column shows ["claude", "terminal"]; drop codex onto terminal's
    // leading half, i.e. between claude and terminal in the grouped view.
    fire("onDragStart", { active: { id: "codex" } });
    fire("onDragOver", {
      active: { id: "codex", rect: { current: { translated: { top: 0, height: 20 } } } },
      over: { id: "terminal", rect: { top: 0, height: 100 } },
    });
    fire("onDragEnd", { active: { id: "codex" }, over: { id: "terminal" } });

    // Index 2 in the *stored* array — right after its group peer `claude` —
    // which grouping renders as claude → codex → terminal. The projected
    // index (1) would have landed it before claude.
    expect(moveButtonMock).toHaveBeenCalledWith("codex", "right", "left", 2);
  });

  // The right side is grouped too, so the hovered row is a group peer of the
  // dragged one: dropping among another group's rows snaps into its own group
  // regardless of the pointer.
  function agentOnRight() {
    mockToolbarState = makeToolbarState({
      leftButtons: ["launcher", "claude", "terminal"],
      rightButtons: ["codex", "settings"],
      pinnedButtons: {},
    });
    mockAgentSettings = agentSettings({ claude: { pinned: true }, codex: { pinned: true } });
  }

  it("commits a cross-side move after the hovered item (centre below its midpoint)", () => {
    agentOnRight();
    render(<ToolbarSettingsTab />);

    // Drag "claude" onto "codex" (right side, index 0) with its centre well
    // below the midpoint → it should land *after* codex, at index 1.
    fire("onDragStart", { active: { id: "claude" } });
    fire("onDragOver", {
      active: { id: "claude", rect: { current: { translated: { top: 1000, height: 20 } } } },
      over: { id: "codex", rect: { top: 0, height: 100 } },
    });
    fire("onDragEnd", { active: { id: "claude" }, over: { id: "codex" } });

    expect(moveButtonMock).toHaveBeenCalledTimes(1);
    expect(moveButtonMock).toHaveBeenCalledWith("claude", "left", "right", 1);
    expect(setLeftButtonsMock).not.toHaveBeenCalled();
    expect(setRightButtonsMock).not.toHaveBeenCalled();
  });

  it("commits a cross-side move before the hovered item (centre above its midpoint)", () => {
    agentOnRight();
    render(<ToolbarSettingsTab />);

    // Same target, centre above the midpoint → it should land *before* codex,
    // i.e. at index 0.
    fire("onDragStart", { active: { id: "claude" } });
    fire("onDragOver", {
      active: { id: "claude", rect: { current: { translated: { top: 0, height: 20 } } } },
      over: { id: "codex", rect: { top: 0, height: 100 } },
    });
    fire("onDragEnd", { active: { id: "claude" }, over: { id: "codex" } });

    expect(moveButtonMock).toHaveBeenCalledTimes(1);
    expect(moveButtonMock).toHaveBeenCalledWith("claude", "left", "right", 0);
  });

  it("moves the only button off a side, leaving it empty", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["terminal"],
      rightButtons: ["copy-tree"],
      pinnedButtons: {},
    });

    render(<ToolbarSettingsTab />);

    fire("onDragStart", { active: { id: "terminal" } });
    fire("onDragOver", {
      active: { id: "terminal", rect: { current: { translated: { top: 1000, height: 20 } } } },
      over: { id: "copy-tree", rect: { top: 0, height: 100 } },
    });
    fire("onDragEnd", { active: { id: "terminal" }, over: { id: "copy-tree" } });

    expect(moveButtonMock).toHaveBeenCalledTimes(1);
    expect(moveButtonMock).toHaveBeenCalledWith("terminal", "left", "right", 1);
    expect(setLeftButtonsMock).not.toHaveBeenCalled();
    expect(setRightButtonsMock).not.toHaveBeenCalled();
  });

  it("does not commit a cross-side drop that never ran onDragOver (no speculative state)", () => {
    // Without an onDragOver pass the dragged button was never relocated into
    // the target list, so its target index is unresolved — the guard must
    // skip the commit rather than splice at -1.
    render(<ToolbarSettingsTab />);

    fire("onDragEnd", { active: { id: "claude" }, over: { id: "settings" } });

    expect(moveButtonMock).not.toHaveBeenCalled();
    expect(setLeftButtonsMock).not.toHaveBeenCalled();
    expect(setRightButtonsMock).not.toHaveBeenCalled();
  });

  it("supports dropping onto an empty side without crashing", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["launcher", "terminal"],
      rightButtons: [],
      pinnedButtons: {},
    });

    render(<ToolbarSettingsTab />);

    fire("onDragStart", { active: { id: "terminal" } });
    fire("onDragOver", {
      active: { id: "terminal", rect: { current: { translated: { top: 1000, height: 20 } } } },
      over: { id: "right", rect: { top: 0, height: 100 } },
    });
    fire("onDragEnd", { active: { id: "terminal" }, over: { id: "right" } });

    expect(moveButtonMock).toHaveBeenCalledWith("terminal", "left", "right", 0);
  });

  it("does not mutate the store when a drag is cancelled", () => {
    render(<ToolbarSettingsTab />);

    fire("onDragStart", { active: { id: "launcher" } });
    fire("onDragCancel", {});

    expect(setLeftButtonsMock).not.toHaveBeenCalled();
    expect(setRightButtonsMock).not.toHaveBeenCalled();
    expect(moveButtonMock).not.toHaveBeenCalled();
  });

  it("ignores a drop with no target (over === null)", () => {
    render(<ToolbarSettingsTab />);

    fire("onDragEnd", { active: { id: "claude" }, over: null });

    expect(setLeftButtonsMock).not.toHaveBeenCalled();
    expect(setRightButtonsMock).not.toHaveBeenCalled();
    expect(moveButtonMock).not.toHaveBeenCalled();
  });
});

describe("ToolbarSettingsTab — drag-source vs off-row opacity", () => {
  // Only the drag-source ghost (DRAG_GHOST_OPACITY) dims a row. A button that
  // is merely off used to be dimmed to 0.5 as well, which read as disabled;
  // these tests keep the ghost the sole opacity state.
  beforeEach(() => {
    clearStoreMocks();
    vi.mocked(useSortable).mockImplementation(defaultSortable);
    mockToolbarState = makeToolbarState();
    mockAgentSettings = null;
  });

  // The opacity-bearing node is the sortable wrapper (`setNodeRef` div): it is
  // the switch's grandparent — switch → card root → sortable wrapper.
  function rowFor(label: string, container: HTMLElement): HTMLElement {
    const toggle = leftColumn(container).querySelector(
      `button[role="switch"][aria-label="${switchName(label)}"]`
    ) as HTMLElement;
    // The sortable wrapper is the one node carrying dnd-kit's inline style.
    return toggle.closest("[style]") as HTMLElement;
  }

  // An off row only has a column row when it was switched off during this
  // visit: at rest it is listed under "Not on the toolbar" instead.
  function switchGeminiOffInColumn() {
    mockAgentSettings = agentSettings({ gemini: { pinned: true } });
    const view = render(<ToolbarSettingsTab />);
    fireEvent.click(view.getByLabelText(switchName("Gemini agent")));
    mockAgentSettings = agentSettings({ gemini: { pinned: false } });
    view.rerender(<ToolbarSettingsTab />);
    expect(view.getByLabelText(switchName("Gemini agent")).getAttribute("aria-checked")).toBe(
      "false"
    );
    return view;
  }

  it("applies DRAG_GHOST_OPACITY to a dragged row (not the legacy 0.5)", () => {
    vi.mocked(useSortable).mockImplementation(() => ({
      ...defaultSortable(),
      isDragging: true,
    }));

    const { getByLabelText, container } = render(<ToolbarSettingsTab />);
    getByLabelText(switchName("Terminal"));
    const row = rowFor("Terminal", container);
    expect(row.style.opacity).toBe(String(DRAG_GHOST_OPACITY));
    expect(row.style.opacity).not.toBe("0.5");
  });

  it("prefers DRAG_GHOST_OPACITY over the hidden preview when dragging a hidden row", () => {
    // Unreachable in production today (useSortable is called with
    // `disabled: !isVisible`, so a hidden row can't drag), but this locks
    // the ternary's `isDragging`-first ordering against a future refactor
    // that drops the disabled guard.
    vi.mocked(useSortable).mockImplementation(() => ({
      ...defaultSortable(),
      isDragging: true,
    }));

    const { container } = switchGeminiOffInColumn();
    const row = rowFor("Gemini agent", container);
    expect(row.style.opacity).toBe(String(DRAG_GHOST_OPACITY));
  });

  it("keeps a row that is merely off at full opacity (off is not disabled)", () => {
    // gemini unpinned → not on the toolbar. The switch says so; dimming the
    // whole row would make an available setting read as a disabled one.
    const { container } = switchGeminiOffInColumn();
    const row = rowFor("Gemini agent", container);
    expect(row.style.opacity).toBe("1");
  });

  it("renders a visible, non-dragged row at full opacity", () => {
    mockAgentSettings = agentSettings({ claude: { pinned: true } });

    const { container } = render(<ToolbarSettingsTab />);
    const row = rowFor("Claude agent", container);
    expect(row.style.opacity).toBe("1");
  });
});

describe("ToolbarSettingsTab — plugin button promotion (#11304)", () => {
  beforeEach(() => {
    clearStoreMocks();
    mockToolbarState = makeToolbarState();
    mockAgentSettings = null;
    pluginButtons.configs = new Map([
      [
        "acme.ping",
        {
          id: "acme.ping",
          label: "Hello ping",
          iconId: "sparkles",
          actionId: "acme.greet",
          priority: 3,
          pluginId: "acme",
        },
      ],
    ]);
  });

  afterEach(() => {
    pluginButtons.configs = new Map();
  });

  it("shows a contribution as un-promoted until pinnedButtons records an explicit true", () => {
    const first = render(<ToolbarSettingsTab />);
    expect(first.getByLabelText(switchName("Hello ping")).getAttribute("aria-checked")).toBe(
      "false"
    );
    first.unmount();

    mockToolbarState = makeToolbarState({
      ...mockToolbarState.layout,
      pinnedButtons: { "acme.ping": true },
    });
    const second = render(<ToolbarSettingsTab />);
    expect(second.getByLabelText(switchName("Hello ping")).getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("lists an un-promoted contribution under Plugin buttons", () => {
    const { container } = render(<ToolbarSettingsTab />);
    expect(switchNamesIn(poolGroup(container, "Plugin buttons"))).toEqual([
      switchName("Hello ping"),
    ]);
    expect(switchNamesIn(rightColumn(container))).not.toContain(switchName("Hello ping"));
  });

  it("lists a promoted contribution with no stored position in the right column", () => {
    // The toolbar appends such a button on the right, so the column has to show
    // it there for the user to see and move it.
    mockToolbarState = makeToolbarState({
      ...mockToolbarState.layout,
      pinnedButtons: { "acme.ping": true },
    });
    expect([
      ...mockToolbarState.layout.leftButtons,
      ...mockToolbarState.layout.rightButtons,
    ]).not.toContain("acme.ping");

    const { container } = render(<ToolbarSettingsTab />);
    expect(switchNamesIn(rightColumn(container))).toContain(switchName("Hello ping"));
    expect(switchNamesIn(poolSection(container))).not.toContain(switchName("Hello ping"));
  });

  it("gives a demoted contribution with no stored slot a row below, not no row", () => {
    mockToolbarState = makeToolbarState({
      ...mockToolbarState.layout,
      pinnedButtons: { "acme.ping": true },
    });
    const { container, getByLabelText, rerender } = render(<ToolbarSettingsTab />);
    expect(rightColumn(container).contains(getByLabelText(switchName("Hello ping")))).toBe(true);

    fireEvent.click(getByLabelText(switchName("Hello ping")));
    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.ping", false);
    mockToolbarState = makeToolbarState({ ...mockToolbarState.layout, pinnedButtons: {} });
    rerender(<ToolbarSettingsTab />);

    // Its column row had nowhere left to render; the switch to undo it must still exist.
    expect(switchNamesIn(container).filter((n) => n === switchName("Hello ping"))).toHaveLength(1);
    expect(switchNamesIn(poolSection(container))).toContain(switchName("Hello ping"));
  });

  it("routes the plugin switch to setPluginButtonPromoted, never toggleButtonVisibility", () => {
    // The generic hide toggle can only write `false`, which under tray-default
    // semantics would leave the button un-promoted no matter how often it is
    // clicked.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Hello ping")));

    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.ping", true);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("demotes an already-promoted contribution", () => {
    mockToolbarState = makeToolbarState({
      ...mockToolbarState.layout,
      pinnedButtons: { "acme.ping": true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Hello ping")));

    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.ping", false);
  });

  it("leaves built-in toggles on toggleButtonVisibility", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Launcher")));

    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("launcher", "left");
    expect(setPluginButtonPromotedMock).not.toHaveBeenCalled();
  });
});

describe("ToolbarSettingsTab — panel button pinning (#11667)", () => {
  // A fresh v13 profile: `browser` and `dev-server` left the defaults, so they
  // sit in neither side array and the two drag columns can't render them.
  function freshV13Profile() {
    return makeToolbarState({
      leftButtons: ["terminal", "file-browser", "launcher"],
      rightButtons: ["settings"],
      pinnedButtons: {},
    });
  }

  beforeEach(() => {
    clearStoreMocks();
    vi.mocked(useSortable).mockImplementation(defaultSortable);
    mockToolbarState = freshV13Profile();
    mockAgentSettings = null;
  });

  it("lists a panel button the side columns cannot reach", () => {
    // The panel tray's "Customize toolbar…" footer routes here, so the page has
    // to list the buttons the tray holds even when no side array carries them.
    const { container } = render(<ToolbarSettingsTab />);
    const columns = [
      ...switchNamesIn(leftColumn(container)),
      ...switchNamesIn(rightColumn(container)),
    ];
    const panels = switchNamesIn(poolGroup(container, "Panels"));

    expect(columns).not.toContain(switchName("Browser"));
    expect(columns).not.toContain(switchName("Dev preview"));
    expect(panels).toContain(switchName("Browser"));
    expect(panels).toContain(switchName("Dev preview"));
  });

  it("reads an unpositioned panel button as off, not as an absent-means-visible default", () => {
    // `isToolbarButtonVisible` answers "no pin entry" with `true`, which would
    // show both switches on while neither button is anywhere on the toolbar —
    // and cost the user two clicks to promote one.
    const { getByLabelText } = render(<ToolbarSettingsTab />);

    expect(getByLabelText(switchName("Browser")).getAttribute("aria-checked")).toBe("false");
    expect(getByLabelText(switchName("Browse files")).getAttribute("aria-checked")).toBe("true");
  });

  it("promotes an unpositioned panel button in a single click", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Dev preview")));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledTimes(1);
    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("dev-server", true);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("demotes a positioned panel button through the same action", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Browse files")));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("file-browser", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("keeps an explicitly promoted button on while its position is missing", () => {
    // The cross-view window: a stale sibling's write replaced the arrays and
    // dropped the position, and `restorePromotedPanelButtons` has not rebuilt it
    // yet. The explicit `true` is what keeps the switch honest until it does.
    mockToolbarState = makeToolbarState({
      leftButtons: ["terminal", "file-browser", "launcher"],
      rightButtons: ["settings"],
      pinnedButtons: { browser: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    expect(getByLabelText(switchName("Browser")).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(getByLabelText(switchName("Browser")));
    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("browser", false);
  });

  it("lists only the unpinned panel buttons under Panels", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["terminal", "file-browser", "browser", "launcher"],
      rightButtons: ["settings"],
      pinnedButtons: {},
    });

    const { container, getByText } = render(<ToolbarSettingsTab />);
    // terminal + file-browser + browser positioned, dev-server absent.
    const panelIds = new Set<string>(LAUNCHER_PANEL_BUTTON_IDS);
    const positioned = mockToolbarState.layout.leftButtons.filter((id) => panelIds.has(id));
    const unpinned = LAUNCHER_PANEL_BUTTON_IDS.filter((id) => !positioned.includes(id));

    expect(switchNamesIn(poolGroup(container, "Panels"))).toEqual(
      unpinned.map((id) => switchName(TOOLBAR_BUTTON_METADATA[id]!.label))
    );
    // The pinned panels plus the launcher are counted on their side.
    const onLeft = positioned.length + 1;
    expect(getByText(`Left side · ${onLeft} buttons`)).toBeTruthy();
  });
});

describe("ToolbarSettingsTab — launcher pins (#12217)", () => {
  beforeEach(() => {
    clearStoreMocks();
    mockAgentSettings = null;
    mockRecipes.list = [];
    pluginButtons.configs = new Map();
  });

  afterEach(() => {
    mockToolbarState = makeToolbarState();
    mockRecipes.list = [];
    setLauncherItemOnToolbarMock.mockReset();
  });

  // Every id is positioned as well, as `setLauncherItemOnToolbar` does on a pin.
  function pinned(pinnedButtons: Record<string, boolean>) {
    mockToolbarState = makeToolbarState({
      leftButtons: ["launcher", ...Object.keys(pinnedButtons)],
      rightButtons: [],
      pinnedButtons,
    });
  }

  function launcherItemSwitches(container: HTMLElement): Element[] {
    return Array.from(container.querySelectorAll('[role="switch"]')).filter((el) =>
      el.id.includes("launcher:")
    );
  }

  it("lists a pinned recipe under the name the recipe actually has", () => {
    mockRecipes.list = [{ id: "r-1", name: "Ship it" }];
    pinned({ "launcher:recipe:r-1": true });

    const { getByLabelText, container } = render(<ToolbarSettingsTab />);
    const toggle = getByLabelText(switchName("Ship it"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(leftColumn(container).contains(toggle)).toBe(true);
  });

  it("lists a pinned plugin agent and a pinned panel kind alongside it", () => {
    // All three classes the issue names reach the columns, each grouped with
    // its own kind: the agent with the agents, the panel with the panels, the
    // recipe with the rest.
    mockRecipes.list = [{ id: "r-1", name: "Ship it" }];
    pinned({
      "launcher:recipe:r-1": true,
      "launcher:agent:my-plugin-agent": true,
      "launcher:panel:review": true,
    });

    const { container } = render(<ToolbarSettingsTab />);
    expect(launcherItemSwitches(container).map((el) => el.id)).toEqual([
      "toolbar-column-launcher:agent:my-plugin-agent",
      "toolbar-column-launcher:panel:review",
      "toolbar-column-launcher:recipe:r-1",
    ]);
    expect(launcherItemSwitches(container).every((el) => leftColumn(container).contains(el))).toBe(
      true
    );
  });

  it("unpins through the launcher-item setter, not the panel or plugin one", () => {
    mockRecipes.list = [{ id: "r-1", name: "Ship it" }];
    pinned({ "launcher:recipe:r-1": true });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText(switchName("Ship it")));

    expect(setLauncherItemOnToolbarMock).toHaveBeenCalledWith("launcher:recipe:r-1", false);
    expect(setPanelButtonOnToolbarMock).not.toHaveBeenCalled();
    expect(setPluginButtonPromotedMock).not.toHaveBeenCalled();
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("hands focus to a neighbour when unpinning removes the focused row", async () => {
    mockRecipes.list = [
      { id: "r-1", name: "Ship it" },
      { id: "r-2", name: "Tidy up" },
    ];
    mockToolbarState = makeToolbarState({
      leftButtons: ["launcher", "launcher:recipe:r-1", "launcher:recipe:r-2"],
      rightButtons: [],
      pinnedButtons: { "launcher:recipe:r-1": true, "launcher:recipe:r-2": true },
    });
    // What the store does on an unpin: drop the pin and the position.
    setLauncherItemOnToolbarMock.mockImplementation((id: string, onToolbar: boolean) => {
      if (onToolbar) return;
      const { layout } = mockToolbarState;
      const pinnedButtons = { ...layout.pinnedButtons };
      delete pinnedButtons[id];
      mockToolbarState = makeToolbarState({
        leftButtons: layout.leftButtons.filter((other) => other !== id),
        rightButtons: layout.rightButtons.filter((other) => other !== id),
        pinnedButtons,
      });
    });
    const { getByLabelText, queryByLabelText } = render(<ToolbarSettingsTab />);
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    // A row with a successor hands focus to the next row.
    fireEvent.click(getByLabelText(switchName("Ship it")));
    await act(nextFrame);
    expect(queryByLabelText(switchName("Ship it"))).toBeNull();
    expect(document.activeElement).toBe(getByLabelText(switchName("Tidy up")));

    // The last row falls back to the one before it.
    fireEvent.click(getByLabelText(switchName("Tidy up")));
    await act(nextFrame);
    expect(queryByLabelText(switchName("Tidy up"))).toBeNull();
    expect(document.activeElement).toBe(getByLabelText(switchName("Launcher")));
  });

  it("shows no row for a pin whose source is not here, and leaves the pin alone", () => {
    // A recipe belonging to another project, or one since deleted. The row is
    // absent because nothing can name or launch it — but "not live right now"
    // is not "gone", so the page must not write anything to clean it up.
    pinned({ "launcher:recipe:from-another-project": true });

    const { container } = render(<ToolbarSettingsTab />);
    expect(launcherItemSwitches(container)).toHaveLength(0);
    expect(setLauncherItemOnToolbarMock).not.toHaveBeenCalled();
    expect(setLeftButtonsMock).not.toHaveBeenCalled();
  });

  it("ignores an entry that is not an explicit promotion", () => {
    // Unpinning deletes the key, so a `false` should never occur — but if a
    // stale profile carries one it must not resurrect the row.
    mockRecipes.list = [{ id: "r-1", name: "Ship it" }];
    pinned({ "launcher:recipe:r-1": false });

    const { container, queryByLabelText } = render(<ToolbarSettingsTab />);
    expect(launcherItemSwitches(container)).toHaveLength(0);
    expect(queryByLabelText(switchName("Ship it"))).toBeNull();
  });

  it("keeps a dotted launcher id out of the plugin buttons", () => {
    // A plugin-contributed recipe's id is `publisher.name`. The dot test that
    // narrows a plugin button id would claim this one if registry membership
    // weren't checked first.
    mockRecipes.list = [{ id: "acme.deploy", name: "Deploy" }];
    pinned({ "launcher:recipe:acme.deploy": true });

    const { container, getByLabelText } = render(<ToolbarSettingsTab />);
    expect(poolGroup(container, "Plugin buttons")).toBeNull();
    expect(leftColumn(container).contains(getByLabelText(switchName("Deploy")))).toBe(true);

    fireEvent.click(getByLabelText(switchName("Deploy")));
    expect(setLauncherItemOnToolbarMock).toHaveBeenCalledWith("launcher:recipe:acme.deploy", false);
    expect(setPluginButtonPromotedMock).not.toHaveBeenCalled();
  });
});

describe("ToolbarSettingsTab — move menu and agent inventory", () => {
  beforeEach(() => {
    clearStoreMocks();
    vi.mocked(useSortable).mockImplementation(defaultSortable);
    mockToolbarState = makeToolbarState();
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      gemini: { pinned: true },
      codex: { pinned: false },
    });
  });

  afterEach(() => {
    mockAvailability.value = undefined;
  });

  function menuFor(label: string, getByLabelText: (text: string) => HTMLElement) {
    return within(getByLabelText(`Move ${label}`).parentElement!);
  }

  it("moves across sides through the menu, landing at the end of the other side", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(
      menuFor("Gemini agent", getByLabelText).getByRole("menuitem", { name: "Move to right side" })
    );

    expect(moveButtonMock).toHaveBeenCalledWith(
      "gemini",
      "left",
      "right",
      mockToolbarState.layout.rightButtons.length
    );
  });

  it("offers no step up out of a button's own group", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    const up = menuFor("Claude agent", getByLabelText).getByRole("menuitem", {
      name: "Move up",
    }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);

    fireEvent.click(
      menuFor("Claude agent", getByLabelText).getByRole("menuitem", { name: "Move down" })
    );
    const written = setLeftButtonsMock.mock.calls[0]![0];
    expect(written.indexOf("gemini")).toBeLessThan(written.indexOf("claude"));
  });

  it("steps past a hidden neighbour to the next button on the toolbar", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["launcher", "claude", "gemini", "codex", "terminal"],
      rightButtons: ["settings"],
      pinnedButtons: {},
    });
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      gemini: { pinned: false },
      codex: { pinned: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(
      menuFor("Claude agent", getByLabelText).getByRole("menuitem", { name: "Move down" })
    );

    expect(setLeftButtonsMock).toHaveBeenCalledTimes(1);
    const written = setLeftButtonsMock.mock.calls[0]![0];
    // Lands after the next visible agent, not merely after the hidden one.
    expect(written.indexOf("claude")).toBe(written.indexOf("codex") + 1);
    // The hidden id keeps its slot in the array.
    expect([...written].sort()).toEqual([...mockToolbarState.layout.leftButtons].sort());
  });

  it("keeps an agent switched off in its column in view, switched off", () => {
    const { getByLabelText, container, rerender } = render(<ToolbarSettingsTab />);

    fireEvent.click(getByLabelText(switchName("Gemini agent")));
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      gemini: { pinned: false },
      codex: { pinned: false },
    });
    rerender(<ToolbarSettingsTab />);

    const gemini = getByLabelText(switchName("Gemini agent"));
    expect(gemini.getAttribute("aria-checked")).toBe("false");
    expect(leftColumn(container).contains(gemini)).toBe(true);
    // Off rows keep no move menu — there is no position to change.
    expect(container.querySelector('[aria-label="Move Gemini agent"]')).toBeNull();
  });

  it("hides agents that aren't installed behind a disclosure", () => {
    mockAgentSettings = agentSettings({ claude: { pinned: false } });
    mockAvailability.value = { claude: "ready", gemini: "missing" };

    const { container, queryByLabelText, getByLabelText } = render(<ToolbarSettingsTab />);
    const disclosure = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")
    ).find((el) => el.textContent?.includes("that aren't installed"))!;

    // An installed agent is listed straight away; a missing one is not.
    expect(getByLabelText(switchName("Claude agent"))).toBeTruthy();
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(queryByLabelText(switchName("Gemini agent"))).toBeNull();

    fireEvent.click(disclosure);

    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const gemini = getByLabelText(switchName("Gemini agent"));
    expect(poolGroup(container, "Agents")!.contains(gemini)).toBe(true);
  });
});
