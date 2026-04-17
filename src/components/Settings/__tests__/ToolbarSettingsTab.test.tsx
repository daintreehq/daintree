// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentSettings } from "@shared/types";

const setLeftButtonsMock = vi.fn();
const setRightButtonsMock = vi.fn();
const toggleButtonVisibilityMock = vi.fn();
const setAlwaysShowDevServerMock = vi.fn();
const setDefaultSelectionMock = vi.fn();
const resetMock = vi.fn();
const setAgentPinnedMock = vi.fn().mockResolvedValue(undefined);

interface ToolbarState {
  layout: {
    leftButtons: string[];
    rightButtons: string[];
    hiddenButtons: string[];
  };
  launcher: {
    alwaysShowDevServer: boolean;
    defaultSelection?: string;
  };
  setLeftButtons: typeof setLeftButtonsMock;
  setRightButtons: typeof setRightButtonsMock;
  toggleButtonVisibility: typeof toggleButtonVisibilityMock;
  setAlwaysShowDevServer: typeof setAlwaysShowDevServerMock;
  setDefaultSelection: typeof setDefaultSelectionMock;
  reset: typeof resetMock;
}

let mockToolbarState: ToolbarState = {
  layout: { leftButtons: [], rightButtons: [], hiddenButtons: [] },
  launcher: { alwaysShowDevServer: false, defaultSelection: undefined },
  setLeftButtons: setLeftButtonsMock,
  setRightButtons: setRightButtonsMock,
  toggleButtonVisibility: toggleButtonVisibilityMock,
  setAlwaysShowDevServer: setAlwaysShowDevServerMock,
  setDefaultSelection: setDefaultSelectionMock,
  reset: resetMock,
};

let mockAgentSettings: AgentSettings | null = null;

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

vi.mock("@shared/config/agentIds", () => ({
  BUILT_IN_AGENT_IDS: ["claude", "gemini", "codex"] as const,
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    icon: () => null,
  }),
}));

vi.mock("@/hooks/usePluginToolbarButtons", () => ({
  usePluginToolbarButtons: () => ({ buttonIds: [], configs: new Map() }),
}));

// @dnd-kit renders a sortable context plus listeners for each row. For unit
// tests we only care about the rendered rows and the checkbox toggle paths —
// stub the context and sortable hook so drag behavior doesn't need a real DOM.
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: vi.fn(),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/components/icons", () => ({
  CopyTreeIcon: () => null,
  McpServerIcon: () => null,
}));

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    GripVertical: Icon,
    SquareTerminal: Icon,
    Globe: Icon,
    Monitor: Icon,
    AlertTriangle: Icon,
    Settings: Icon,
    AlertCircle: Icon,
    Bell: Icon,
    Mic: Icon,
    LayoutGrid: Icon,
    Rocket: Icon,
    RotateCcw: Icon,
    StickyNote: Icon,
    Puzzle: Icon,
  };
});

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

import { ToolbarSettingsTab } from "../ToolbarSettingsTab";

function agentSettings(overrides: Record<string, { pinned?: boolean }>): AgentSettings {
  return { agents: overrides } as unknown as AgentSettings;
}

describe("ToolbarSettingsTab — agent visibility routing", () => {
  beforeEach(() => {
    setLeftButtonsMock.mockClear();
    setRightButtonsMock.mockClear();
    toggleButtonVisibilityMock.mockClear();
    setAlwaysShowDevServerMock.mockClear();
    setDefaultSelectionMock.mockClear();
    resetMock.mockClear();
    setAgentPinnedMock.mockClear();

    mockToolbarState = {
      layout: {
        // Mix of agent IDs and non-agent IDs so we can test both branches.
        leftButtons: ["agent-tray", "claude", "gemini", "terminal"],
        rightButtons: ["notes", "settings"],
        hiddenButtons: [],
      },
      launcher: { alwaysShowDevServer: false, defaultSelection: undefined },
      setLeftButtons: setLeftButtonsMock,
      setRightButtons: setRightButtonsMock,
      toggleButtonVisibility: toggleButtonVisibilityMock,
      setAlwaysShowDevServer: setAlwaysShowDevServerMock,
      setDefaultSelection: setDefaultSelectionMock,
      reset: resetMock,
    };
    mockAgentSettings = null;
  });

  it("shows agent rows as checked when pinned in agentSettingsStore", () => {
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      gemini: { pinned: false },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);

    const claudeCheckbox = getByLabelText("Toggle Claude Agent visibility") as HTMLInputElement;
    const geminiCheckbox = getByLabelText("Toggle Gemini Agent visibility") as HTMLInputElement;
    expect(claudeCheckbox.checked).toBe(true);
    expect(geminiCheckbox.checked).toBe(false);
  });

  it("ignores hiddenButtons for agent IDs (agentSettingsStore wins)", () => {
    // Stale entry from pre-migration persisted state — the UI must still
    // derive the agent's visibility from `agentSettingsStore`, not from
    // `hiddenButtons`.
    mockToolbarState.layout.hiddenButtons = ["claude"];
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    const claudeCheckbox = getByLabelText("Toggle Claude Agent visibility") as HTMLInputElement;
    expect(claudeCheckbox.checked).toBe(true);
  });

  it("routes agent checkbox toggle to setAgentPinned (not toggleButtonVisibility)", () => {
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Claude Agent visibility"));

    expect(setAgentPinnedMock).toHaveBeenCalledTimes(1);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("routes agent checkbox toggle upward (unpinned → pinned) via setAgentPinned", () => {
    mockAgentSettings = agentSettings({
      gemini: { pinned: false },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Gemini Agent visibility"));

    expect(setAgentPinnedMock).toHaveBeenCalledWith("gemini", true);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });

  it("keeps non-agent checkbox toggle on toggleButtonVisibility", () => {
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Terminal visibility"));

    expect(toggleButtonVisibilityMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("terminal", "left");
    expect(setAgentPinnedMock).not.toHaveBeenCalled();
  });

  it("reflects pinned agents in the section visible-count summary", () => {
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      gemini: { pinned: false },
    });

    const { getByTestId } = render(<ToolbarSettingsTab />);
    // Left side: agent-tray (visible), claude (pinned, visible),
    // gemini (unpinned, not visible), terminal (not hidden, visible) => 3 / 4.
    const leftSection = getByTestId("section-Left Side Buttons");
    expect(leftSection.getAttribute("data-description")).toContain("3 of 4 visible");
  });

  it("treats null agentSettings as all-unpinned without crashing", () => {
    mockAgentSettings = null;

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    const claudeCheckbox = getByLabelText("Toggle Claude Agent visibility") as HTMLInputElement;
    expect(claudeCheckbox.checked).toBe(false);
  });

  it("handles a right-side agent correctly (routes through setAgentPinned)", () => {
    // Relocate codex to the right side — an unlikely but possible layout.
    mockToolbarState.layout = {
      leftButtons: ["agent-tray", "terminal"],
      rightButtons: ["codex", "settings"],
      hiddenButtons: [],
    };
    mockAgentSettings = agentSettings({
      codex: { pinned: true },
    });

    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Codex Agent visibility"));

    expect(setAgentPinnedMock).toHaveBeenCalledWith("codex", false);
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalled();
  });
});
