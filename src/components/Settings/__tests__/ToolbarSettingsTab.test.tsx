// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { AgentSettings } from "@shared/types";

const setLeftButtonsMock = vi.fn();
const setRightButtonsMock = vi.fn();
const moveButtonMock = vi.fn();
const toggleButtonVisibilityMock = vi.fn();
const setPluginButtonPromotedMock = vi.fn();
const setPanelButtonOnToolbarMock = vi.fn();
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
  setAlwaysShowDevServerMock.mockClear();
  setDefaultSelectionMock.mockClear();
  resetMock.mockClear();
  setAgentPinnedMock.mockClear();
}

vi.mock("@/store", () => ({
  useToolbarPreferencesStore: (selector: (s: ToolbarState) => unknown) =>
    selector(mockToolbarState),
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (
    selector: (s: {
      settings: AgentSettings | null;
      setAgentPinned: typeof setAgentPinnedMock;
    }) => unknown
  ) => selector({ settings: mockAgentSettings, setAgentPinned: setAgentPinnedMock }),
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: { availability: undefined }) => unknown) =>
    selector({ availability: undefined }),
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
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
    className,
  }: {
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    "aria-label"?: string;
    className?: string;
  }) => (
    <button
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
import { ToolbarSettingsTab } from "../ToolbarSettingsTab";

function agentSettings(overrides: Record<string, { pinned?: boolean }>): AgentSettings {
  return { agents: overrides } as unknown as AgentSettings;
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

    expect(getByLabelText("Toggle Claude agent visibility").getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(getByLabelText("Toggle Gemini agent visibility").getAttribute("aria-checked")).toBe(
      "false"
    );
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
    expect(getByLabelText("Toggle Claude agent visibility").getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("routes agent switch toggle to setAgentPinned (not toggleButtonVisibility)", () => {
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Claude agent visibility"));

    expect(setAgentPinnedMock).toHaveBeenCalledTimes(1);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("routes agent switch toggle upward (unpinned → pinned) via setAgentPinned", () => {
    mockAgentSettings = agentSettings({
      gemini: { pinned: false },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Gemini agent visibility"));

    expect(setAgentPinnedMock).toHaveBeenCalledWith("gemini", true);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("keeps plain built-in toggles on toggleButtonVisibility", () => {
    // The launcher, not `terminal`: since #11680 terminal is a launcher panel
    // button and routes through `setPanelButtonOnToolbar` with the other three,
    // so a left-side built-in that stays on the generic path is the honest
    // subject here.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Launcher visibility"));

    expect(toggleButtonVisibilityMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("launcher", "left");
    expect(setAgentPinnedMock).not.toHaveBeenCalled();
  });

  it("routes the terminal toggle through the launcher panel setter", () => {
    // The #11680 unification: every Panels row writes the same way, so terminal
    // stopped being a plain built-in the moment it gained a launcher row.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Terminal visibility"));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("terminal", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("dispatches `'right'` as the side argument for right-side non-agent toggles", () => {
    // Locks the side argument so future side-aware store changes can't
    // silently swallow the right-side branch — both columns are nominally
    // identical today but each is independently wired.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Copy context visibility"));

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

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    const toggle = getByLabelText("Toggle Browse files visibility");

    expect(toggle.getAttribute("aria-checked")).toBe("false");
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
    fireEvent.click(getByLabelText("Toggle Browser visibility"));

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
    fireEvent.click(getByLabelText("Toggle Browse files visibility"));

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
    // gemini (unpinned, not visible), terminal (not hidden, visible) => 3 / 4.
    expect(getByText("3/4")).toBeTruthy();
  });

  it("treats null agentSettings as all-unpinned without crashing", () => {
    mockAgentSettings = null;

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    expect(getByLabelText("Toggle Claude agent visibility").getAttribute("aria-checked")).toBe(
      "false"
    );
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
    fireEvent.click(getByLabelText("Toggle Codex agent visibility"));

    expect(setAgentPinnedMock).toHaveBeenCalledWith("codex", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
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

    const { container } = render(<ToolbarSettingsTab />);
    // Only the side-column switches — the panel section below renders its own
    // "Show … in toolbar" switches regardless of array membership.
    const order = Array.from(container.querySelectorAll('[role="switch"]'))
      .map((el) => el.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("Toggle "));

    expect(order).toEqual([
      "Toggle Launcher visibility",
      "Toggle Claude agent visibility",
      "Toggle Gemini agent visibility",
      "Toggle Terminal visibility",
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

    const { container } = render(<ToolbarSettingsTab />);

    // Drop the panel into the middle of the agent block. The preview must show
    // it after the agents, not where the pointer is — otherwise the gap opens
    // somewhere the button will never land.
    fire("onDragStart", { active: { id: "terminal" } });
    fire("onDragOver", {
      active: { id: "terminal", rect: { current: { translated: { right: 0 } } } },
      over: { id: "gemini", rect: { left: 0, width: 100 } },
    });

    const order = Array.from(container.querySelectorAll('[role="switch"]'))
      .map((el) => el.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("Toggle "))
      // The DragOverlay renders its own card for the button under the cursor,
      // always last and only while a drag is in flight. The right column is
      // empty at this point, so what remains is the left column.
      .slice(0, -1);

    expect(order).toEqual([
      "Toggle Launcher visibility",
      "Toggle Claude agent visibility",
      "Toggle Gemini agent visibility",
      "Toggle Terminal visibility",
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
      active: { id: "codex", rect: { current: { translated: { right: 0 } } } },
      over: { id: "terminal", rect: { left: 0, width: 100 } },
    });
    fire("onDragEnd", { active: { id: "codex" }, over: { id: "terminal" } });

    // Index 2 in the *stored* array — right after its group peer `claude` —
    // which grouping renders as claude → codex → terminal. The projected
    // index (1) would have landed it before claude.
    expect(moveButtonMock).toHaveBeenCalledWith("codex", "right", "left", 2);
  });

  it("commits a cross-side move after the hovered item (right edge past midpoint)", () => {
    render(<ToolbarSettingsTab />);

    // Drag "claude" onto "settings" (right side, last at index 1) with its
    // right edge well past the midpoint → it should land *after* settings,
    // i.e. at index 2 (the end of the right list).
    fire("onDragStart", { active: { id: "claude" } });
    fire("onDragOver", {
      active: { id: "claude", rect: { current: { translated: { right: 1000 } } } },
      over: { id: "settings", rect: { left: 0, width: 100 } },
    });
    fire("onDragEnd", { active: { id: "claude" }, over: { id: "settings" } });

    expect(moveButtonMock).toHaveBeenCalledTimes(1);
    expect(moveButtonMock).toHaveBeenCalledWith("claude", "left", "right", 2);
    expect(setLeftButtonsMock).not.toHaveBeenCalled();
    expect(setRightButtonsMock).not.toHaveBeenCalled();
  });

  it("commits a cross-side move before the hovered item (right edge before midpoint)", () => {
    render(<ToolbarSettingsTab />);

    // Drag "claude" onto "copy-tree" (right side, first at index 0) with its
    // right edge before the midpoint → it should land *before* copy-tree,
    // i.e. at index 0.
    fire("onDragStart", { active: { id: "claude" } });
    fire("onDragOver", {
      active: { id: "claude", rect: { current: { translated: { right: 0 } } } },
      over: { id: "copy-tree", rect: { left: 0, width: 100 } },
    });
    fire("onDragEnd", { active: { id: "claude" }, over: { id: "copy-tree" } });

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
      active: { id: "terminal", rect: { current: { translated: { right: 1000 } } } },
      over: { id: "copy-tree", rect: { left: 0, width: 100 } },
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
      active: { id: "terminal", rect: { current: { translated: { right: 1000 } } } },
      over: { id: "right", rect: { left: 0, width: 100 } },
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

describe("ToolbarSettingsTab — drag-source vs hidden opacity deconfliction", () => {
  // The drag-source ghost (DRAG_GHOST_OPACITY) and the hidden-in-toolbar
  // preview (0.5) are semantically distinct states that previously shared a
  // magic 0.5. These tests lock the deconfliction so the two values can't
  // silently collapse back together.
  beforeEach(() => {
    clearStoreMocks();
    vi.mocked(useSortable).mockImplementation(defaultSortable);
    mockToolbarState = makeToolbarState();
    mockAgentSettings = null;
  });

  // The opacity-bearing node is the sortable wrapper (`setNodeRef` div): it is
  // the switch's grandparent — switch → card root → sortable wrapper.
  function rowFor(label: string, container: HTMLElement): HTMLElement {
    const toggle = container.querySelector(
      `button[role="switch"][aria-label="Toggle ${label} visibility"]`
    ) as HTMLElement;
    return toggle.parentElement!.parentElement as HTMLElement;
  }

  it("applies DRAG_GHOST_OPACITY to a dragged row (not the legacy 0.5)", () => {
    vi.mocked(useSortable).mockImplementation(() => ({
      ...defaultSortable(),
      isDragging: true,
    }));

    const { getByLabelText, container } = render(<ToolbarSettingsTab />);
    getByLabelText("Toggle Terminal visibility");
    const row = rowFor("Terminal", container);
    expect(row.style.opacity).toBe(String(DRAG_GHOST_OPACITY));
    expect(row.style.opacity).not.toBe("0.5");
  });

  it("prefers DRAG_GHOST_OPACITY over the hidden preview when dragging a hidden row", () => {
    // Unreachable in production today (useSortable is called with
    // `disabled: !isVisible`, so a hidden row can't drag), but this locks
    // the ternary's `isDragging`-first ordering against a future refactor
    // that drops the disabled guard.
    mockAgentSettings = agentSettings({ gemini: { pinned: false } });
    vi.mocked(useSortable).mockImplementation(() => ({
      ...defaultSortable(),
      isDragging: true,
    }));

    const { container } = render(<ToolbarSettingsTab />);
    const row = rowFor("Gemini agent", container);
    expect(row.style.opacity).toBe(String(DRAG_GHOST_OPACITY));
  });

  it("keeps the hidden-in-toolbar preview at 0.5 (distinct from the drag ghost)", () => {
    // gemini unpinned → not visible → hidden-preview opacity.
    mockAgentSettings = agentSettings({ gemini: { pinned: false } });

    const { container } = render(<ToolbarSettingsTab />);
    const row = rowFor("Gemini agent", container);
    expect(row.style.opacity).toBe("0.5");
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
    expect(first.getByLabelText("Show Hello ping in toolbar").getAttribute("aria-checked")).toBe(
      "false"
    );
    first.unmount();

    mockToolbarState = makeToolbarState({
      ...mockToolbarState.layout,
      pinnedButtons: { "acme.ping": true },
    });
    const second = render(<ToolbarSettingsTab />);
    expect(second.getByLabelText("Show Hello ping in toolbar").getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("routes the plugin switch to setPluginButtonPromoted, never toggleButtonVisibility", () => {
    // The generic hide toggle can only write `false`, which under tray-default
    // semantics would leave the button un-promoted no matter how often it is
    // clicked.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Show Hello ping in toolbar"));

    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.ping", true);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("demotes an already-promoted contribution", () => {
    mockToolbarState = makeToolbarState({
      ...mockToolbarState.layout,
      pinnedButtons: { "acme.ping": true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Show Hello ping in toolbar"));

    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.ping", false);
  });

  it("leaves built-in toggles on toggleButtonVisibility", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Launcher visibility"));

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
    // The reason this section exists: the panel tray's "Customize toolbar…"
    // footer routes here, so the page has to list the buttons the tray holds
    // even when no side array carries them.
    const { getByLabelText, queryByLabelText } = render(<ToolbarSettingsTab />);

    expect(queryByLabelText("Toggle Browser visibility")).toBeNull();
    expect(queryByLabelText("Toggle Dev preview visibility")).toBeNull();
    expect(getByLabelText("Show Browser in toolbar")).toBeTruthy();
    expect(getByLabelText("Show Dev preview in toolbar")).toBeTruthy();
  });

  it("reads an unpositioned panel button as off, not as an absent-means-visible default", () => {
    // `isToolbarButtonVisible` answers "no pin entry" with `true`, which would
    // show both switches on while neither button is anywhere on the toolbar —
    // and cost the user two clicks to promote one.
    const { getByLabelText } = render(<ToolbarSettingsTab />);

    expect(getByLabelText("Show Browser in toolbar").getAttribute("aria-checked")).toBe("false");
    expect(getByLabelText("Show Browse files in toolbar").getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("promotes an unpositioned panel button in a single click", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Show Dev preview in toolbar"));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledTimes(1);
    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("dev-server", true);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("demotes a positioned panel button through the same action", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Show Browse files in toolbar"));

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
    expect(getByLabelText("Show Browser in toolbar").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(getByLabelText("Show Browser in toolbar"));
    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("browser", false);
  });

  it("counts pinned panel buttons in the section description", () => {
    mockToolbarState = makeToolbarState({
      leftButtons: ["terminal", "file-browser", "browser", "launcher"],
      rightButtons: ["settings"],
      pinnedButtons: {},
    });

    const { getByTestId } = render(<ToolbarSettingsTab />);
    // terminal + file-browser + browser positioned, dev-server absent.
    expect(getByTestId("section-Panel buttons").getAttribute("data-description")).toContain(
      "3 of 4 pinned"
    );
  });
});
