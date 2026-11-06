// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import type { Schedule } from "@shared/types/scheduledRuns";
import { SCHEDULE_ASSISTANT_AGENT_ID } from "@shared/utils/scheduledRuns";

// No jest-dom in this repo — plain DOM reads only.

const clientMock = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: clientMock }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/components/Worktree/hooks/useFirstAgentOptions", () => ({
  useFirstAgentOptions: () => [{ id: "claude", name: "Claude", iconId: "claude" }],
}));
vi.mock("../useScheduleLaunchOptions", () => ({
  useScheduleLaunchOptions: () => ({ presets: [], preset: undefined, stopsAtPrompts: false }),
}));
const platformMock = vi.hoisted(() => ({
  isMac: vi.fn(() => true),
  isLinux: vi.fn(() => false),
  isWindows: vi.fn(() => false),
}));
vi.mock("@/lib/platform", async (importActual) => ({
  ...(await importActual<object>()),
  ...platformMock,
}));

import { ScheduleEditor, type EditorLeaveState } from "../ScheduleEditor";

const NOW = Date.UTC(2027, 0, 4, 8);

function existing(agentId: string, onDone: Schedule["policies"]["onDone"] = "keep"): Schedule {
  return createSchedule(
    {
      id: "s1",
      projectId: "p1",
      name: "Nightly",
      launch: { agentId, prompt: "Go." },
      timeZone: "Europe/London",
      policies: { onDone },
    },
    NOW - 1000
  );
}

function renderEditor(schedule: Schedule) {
  render(
    <ScheduleEditor
      schedule={schedule}
      defaultAgentId="claude"
      worktrees={[
        { id: null, label: "Main checkout" },
        { id: "/wt", label: "feature" },
      ]}
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

const doneChoices = () =>
  Array.from(
    screen.getByRole("radiogroup", { name: /reports done/ }).querySelectorAll('[role="radio"]'),
    (radio) => radio.textContent?.trim()
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ScheduleEditor: the Daintree Assistant (#16169)", () => {
  it("drops the preset, the worktree and the background choice the Assistant has no use for", () => {
    renderEditor(existing(SCHEDULE_ASSISTANT_AGENT_ID));

    expect(screen.queryByLabelText("Preset")).toBeNull();
    expect(screen.queryByLabelText("Worktree")).toBeNull();
    expect(doneChoices()).toEqual(["Keep", "Close"]);
    expect(screen.getByText(/new Assistant session with its own settings/)).toBeTruthy();
  });

  it("keeps every choice for an agent", () => {
    renderEditor(existing("claude", "background"));

    expect(screen.getByLabelText("Preset")).toBeTruthy();
    expect(screen.getByLabelText("Worktree")).toBeTruthy();
    expect(doneChoices()).toEqual(["Keep", "Background", "Close"]);
  });

  it("saves the Assistant with no preset or worktree", async () => {
    const schedule = existing(SCHEDULE_ASSISTANT_AGENT_ID);
    clientMock.update.mockResolvedValue({
      status: "saved",
      schedule,
      snapshot: { projectId: "p1", schedules: [], revision: 1 },
    });
    renderEditor(schedule);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Morning sweep" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));

    expect(clientMock.update).toHaveBeenCalledWith(
      "s1",
      schedule.updatedAt,
      expect.objectContaining({
        launch: {
          agentId: SCHEDULE_ASSISTANT_AGENT_ID,
          presetId: null,
          prompt: "Go.",
          worktreeId: null,
        },
      })
    );
  });

  it("switching an agent's schedule to the Assistant drops its preset, worktree and background", async () => {
    const schedule = {
      ...existing("claude", "background"),
      launch: { agentId: "claude", presetId: "fast", prompt: "Go.", worktreeId: "/wt" },
    };
    clientMock.update.mockResolvedValue({
      status: "saved",
      schedule,
      snapshot: { projectId: "p1", schedules: [], revision: 1 },
    });
    renderEditor(schedule);
    const save = () => screen.getByRole("button", { name: "Save changes" });
    expect(screen.queryByText("No changes to save")).not.toBeNull();

    Element.prototype.scrollIntoView ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    const trigger = screen.getByRole("combobox", { name: "Agent" });
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const assistant = await screen.findByRole("option", { name: "Daintree Assistant" });
    await act(async () => fireEvent.keyDown(assistant, { key: "Enter" }));

    expect(screen.queryByLabelText("Preset")).toBeNull();
    expect(doneChoices()).toEqual(["Keep", "Close"]);
    expect(screen.queryByText("No changes to save")).toBeNull();
    await act(async () => fireEvent.click(save()));

    expect(clientMock.update).toHaveBeenCalledWith(
      "s1",
      schedule.updatedAt,
      expect.objectContaining({
        launch: {
          agentId: SCHEDULE_ASSISTANT_AGENT_ID,
          presetId: null,
          prompt: "Go.",
          worktreeId: null,
        },
        policies: expect.objectContaining({ onDone: "keep" }),
      })
    );
  });
});
