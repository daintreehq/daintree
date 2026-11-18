// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import type { Schedule } from "@shared/types/scheduledRuns";
import type { AgentSettings } from "@shared/types/agentSettings";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";

// No jest-dom in this repo — plain DOM reads only.

vi.mock("@/clients/schedulesClient", () => ({
  schedulesClient: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/components/Worktree/hooks/useFirstAgentOptions", () => ({
  useFirstAgentOptions: () => [{ id: "claude", name: "Claude", iconId: "claude" }],
}));
vi.mock("@/store/agentSettingsStore", async () => {
  const { create } = await import("zustand");
  return {
    useAgentSettingsStore: create<{ settings: AgentSettings | null }>(() => ({ settings: null })),
  };
});
vi.mock("@/store/projectStore", async () => {
  const { create } = await import("zustand");
  return {
    useProjectStore: create<{ currentProject: { id: string; path: string } | null }>(() => ({
      currentProject: null,
    })),
  };
});
vi.mock("@/store/scratchStore", async () => {
  const { create } = await import("zustand");
  return {
    useScratchStore: create<{ currentScratch: { id: string } | null }>(() => ({
      currentScratch: null,
    })),
  };
});

const { useAgentSettingsStore } = await import("@/store/agentSettingsStore");
const { useProjectStore } = await import("@/store/projectStore");
const { ScheduleEditor } = await import("../ScheduleEditor");
type EditorLeaveState = import("../ScheduleEditor").EditorLeaveState;

const NOW = Date.UTC(2027, 0, 4, 8);
const MISSING_ERROR = "This preset no longer exists for this agent";

function withPreset(presetId: string): Schedule {
  return createSchedule(
    {
      id: "s1",
      projectId: "b",
      name: "Nightly",
      launch: { agentId: "claude", prompt: "Go.", presetId },
      timeZone: "Europe/London",
    },
    NOW - 1000
  );
}

function renderEditor(schedule: Schedule) {
  render(
    <ScheduleEditor
      schedule={schedule}
      defaultAgentId="claude"
      worktrees={[{ id: null, label: "Main checkout" }]}
      worktreeIds={new Set()}
      now={NOW}
      osJobContext={null}
      leaveStateRef={createRef<EditorLeaveState | null>()}
      onSaved={vi.fn()}
      onDeleted={vi.fn()}
      onCancel={vi.fn()}
      onOpenAgentSettings={vi.fn()}
      projectSwitches={null}
    />
  );
}

const presetTrigger = () => screen.getByRole("combobox", { name: "Preset" });

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  useAgentSettingsStore.setState({ settings: { agents: {} } as unknown as AgentSettings } as never);
  useProjectStore.setState({ currentProject: { id: "b", path: "/b" } } as never);
  useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: true });
  useProjectPresetsStore.setState({ presetsByAgent: {}, hydratedProjectId: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ScheduleEditor: the saved preset (#17210)", () => {
  it("doesn't call a preset missing before this project's presets have loaded", () => {
    renderEditor(withPreset("team"));

    expect(presetTrigger().textContent).toContain("Loading preset…");
    expect(screen.queryByText(MISSING_ERROR)).toBeNull();
    expect(screen.queryByText("This run will stop at permission prompts")).toBeNull();

    act(() => useProjectPresetsStore.getState().setPresetsByAgent("b", {}));

    expect(presetTrigger().textContent).toContain("Missing preset");
    expect(screen.getByText(MISSING_ERROR)).toBeTruthy();
  });

  it("doesn't take another project's preset for this one's", () => {
    useProjectPresetsStore
      .getState()
      .setPresetsByAgent("a", { claude: [{ id: "team", name: "Team from A" }] });
    renderEditor(withPreset("team"));

    expect(presetTrigger().textContent).not.toContain("Team from A");
    expect(screen.queryByText(MISSING_ERROR)).toBeNull();

    act(() =>
      useProjectPresetsStore
        .getState()
        .setPresetsByAgent("b", { claude: [{ id: "team", name: "Team from B" }] })
    );

    expect(presetTrigger().textContent).toContain("Team from B");
    expect(screen.queryByText(MISSING_ERROR)).toBeNull();
  });

  it("waits for agent settings before calling a custom preset missing", () => {
    useProjectPresetsStore.getState().setPresetsByAgent("b", {});
    useAgentSettingsStore.setState({ settings: null } as never);
    renderEditor(withPreset("user-mine"));

    expect(screen.queryByText(MISSING_ERROR)).toBeNull();

    act(() =>
      useAgentSettingsStore.setState({
        settings: {
          agents: { claude: { customPresets: [{ id: "user-mine", name: "Mine" }] } },
        } as unknown as AgentSettings,
      } as never)
    );

    expect(presetTrigger().textContent).toContain("Mine");
    expect(screen.queryByText(MISSING_ERROR)).toBeNull();
  });

  it("waits for the CCR routes before calling a CCR preset missing", () => {
    useProjectPresetsStore.getState().setPresetsByAgent("b", {});
    useCcrPresetsStore.setState({ ccrPresetsByAgent: {}, isInitialized: false });
    renderEditor(withPreset("ccr-route"));

    expect(screen.queryByText(MISSING_ERROR)).toBeNull();

    act(() => useCcrPresetsStore.getState().markInitialized());

    expect(screen.getByText(MISSING_ERROR)).toBeTruthy();
  });
});
