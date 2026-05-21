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
    pinnedButtons: Record<string, boolean>;
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
  layout: { leftButtons: [], rightButtons: [], pinnedButtons: {} },
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

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: { availability: undefined }) => unknown) =>
    selector({ availability: undefined }),
}));

vi.mock("@shared/config/agentIds", () => {
  const BUILT_IN_AGENT_IDS = ["claude", "gemini", "codex"] as const;
  return {
    BUILT_IN_AGENT_IDS,
    isBuiltInAgentId: (value: unknown): value is (typeof BUILT_IN_AGENT_IDS)[number] =>
      typeof value === "string" && BUILT_IN_AGENT_IDS.includes(value as never),
  };
});

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
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
  verticalListSortingStrategy: vi.fn(),
}));

// Test-time helper for restoring the default useSortable return between
// cases (the mock factory above is hoisted, so it can't reference this).
// The component only reads transform/transition/isDragging/listeners/
// attributes/setNodeRef; the cast keeps the partial shape without
// reconstructing dnd-kit's full ~20-field return type.
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

import { useSortable } from "@dnd-kit/sortable";
import { DRAG_GHOST_OPACITY } from "@/lib/animationUtils";
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
        rightButtons: ["copy-tree", "settings"],
        pinnedButtons: {},
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

  it("ignores pinnedButtons for agent IDs (agentSettingsStore wins)", () => {
    // Stale entry from pre-migration persisted state — the UI must still
    // derive the agent's visibility from `agentSettingsStore`, not from
    // `pinnedButtons`.
    mockToolbarState.layout.pinnedButtons = { claude: false };
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

  it("dispatches `'right'` as the side argument for right-side non-agent toggles", () => {
    // Locks the side argument so future side-aware store changes can't
    // silently swallow the right-side branch — both handlers (left, right)
    // are nominally identical today but each is independently wired.
    const { getByLabelText } = render(<ToolbarSettingsTab />);
    fireEvent.click(getByLabelText("Toggle Copy Context visibility"));

    expect(toggleButtonVisibilityMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("copy-tree", "right");
  });

  it("reflects pinned agents in the section visible-count summary", () => {
    mockAgentSettings = agentSettings({
      claude: { pinned: true },
      gemini: { pinned: false },
    });

    const { getByTestId } = render(<ToolbarSettingsTab />);
    // Left side: agent-tray (visible), claude (pinned, visible),
    // gemini (unpinned, not visible), terminal (not hidden, visible) => 3 / 4.
    const leftSection = getByTestId("section-Left side buttons");
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
      pinnedButtons: {},
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

describe("ToolbarSettingsTab — drag-source vs hidden opacity deconfliction", () => {
  // The drag-source ghost (DRAG_GHOST_OPACITY) and the hidden-in-toolbar
  // preview (0.5) are semantically distinct states that previously shared a
  // magic 0.5. These tests lock the deconfliction so the two values can't
  // silently collapse back together.
  beforeEach(() => {
    setAgentPinnedMock.mockClear();
    vi.mocked(useSortable).mockImplementation(defaultSortable);
    mockToolbarState = {
      layout: {
        leftButtons: ["agent-tray", "claude", "gemini", "terminal"],
        rightButtons: ["copy-tree", "settings"],
        pinnedButtons: {},
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

  function rowFor(label: string, container: HTMLElement): HTMLElement {
    const checkbox = container.querySelector(
      `input[aria-label="Toggle ${label} visibility"]`
    ) as HTMLInputElement;
    return checkbox.parentElement as HTMLElement;
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
    const row = rowFor("Gemini Agent", container);
    expect(row.style.opacity).toBe(String(DRAG_GHOST_OPACITY));
  });

  it("keeps the hidden-in-toolbar preview at 0.5 (distinct from the drag ghost)", () => {
    // gemini unpinned → not visible → hidden-preview opacity.
    mockAgentSettings = agentSettings({ gemini: { pinned: false } });

    const { container } = render(<ToolbarSettingsTab />);
    const row = rowFor("Gemini Agent", container);
    expect(row.style.opacity).toBe("0.5");
  });

  it("renders a visible, non-dragged row at full opacity", () => {
    mockAgentSettings = agentSettings({ claude: { pinned: true } });

    const { container } = render(<ToolbarSettingsTab />);
    const row = rowFor("Claude Agent", container);
    expect(row.style.opacity).toBe("1");
  });
});
