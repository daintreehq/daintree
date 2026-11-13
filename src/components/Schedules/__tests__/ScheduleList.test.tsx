// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import type { Schedule } from "@shared/types/scheduledRuns";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { UI_SKELETON_FLOOR_MS, UI_SKELETON_GATE_MS } from "@/lib/animationUtils";
import type { ProjectSchedulesState } from "../useProjectSchedules";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { ScheduleList } from "../ScheduleList";

const NOW = Date.UTC(2027, 0, 4, 8);

function schedule(id: string, name: string): Schedule {
  return createSchedule(
    {
      id,
      projectId: "p1",
      name,
      launch: { agentId: "claude", prompt: "Look at the dependencies." },
      cron: "0 2 * * *",
      timeZone: "Europe/London",
    },
    NOW - 1000
  );
}

function ready(schedules: Schedule[]): ProjectSchedulesState {
  const snapshot: SchedulesSnapshot = {
    projectId: "p1",
    revision: 1,
    switches: { schedulesOn: true, startWhenClosed: false, schedulesOnSince: 1 },
    schedules,
  };
  return { status: "ready", snapshot };
}

const LOADING: ProjectSchedulesState = { status: "loading", snapshot: null };

function List({ state }: { state: ProjectSchedulesState }) {
  return (
    <ScheduleList
      state={state}
      now={NOW}
      worktreeLabels={new Map()}
      pendingEnabled={new Set()}
      enabledError={null}
      pendingRunNow={new Set()}
      runNowError={null}
      runNowRetrying={false}
      onRetryRunNow={() => {}}
      lastRuns={{ status: "ready", byScheduleId: new Map(), version: 1 }}
      addButtonRef={() => {}}
      onRetryLastRuns={() => {}}
      onCreate={() => {}}
      onCreateFromStarter={() => {}}
      onSetEnabled={() => {}}
      onRunNow={() => {}}
      onOpenHistory={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onRetry={() => {}}
    />
  );
}

const skeleton = () => screen.queryByRole("status", { name: "Loading schedules" });
/** The list's own groups: no switches are passed, so any group is the list's. */
const groups = () => document.querySelectorAll(".settings-card").length;
const addButtons = () => screen.queryAllByRole("button", { name: "Add schedule" }).length;
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  delete document.body.dataset.performanceMode;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ScheduleList — waiting on the first read (#16907)", () => {
  it("shows no group at all for a read that lands inside the skeleton's gate", () => {
    const { rerender } = render(<List state={LOADING} />);
    expect(groups()).toBe(0);
    advance(UI_SKELETON_GATE_MS - 1);
    expect(groups()).toBe(0);
    expect(skeleton()).toBeNull();

    rerender(<List state={ready([schedule("s1", "Nightly audit")])} />);
    expect(screen.getByText("Nightly audit")).toBeTruthy();
    advance(UI_SKELETON_GATE_MS + UI_SKELETON_FLOOR_MS);
    expect(skeleton()).toBeNull();
    expect(screen.getByText("Nightly audit")).toBeTruthy();
  });

  it.each([
    ["schedules", [schedule("s1", "Nightly audit")]],
    ["no schedules", []],
  ])("holds a skeleton that has shown for its floor before %s replace it", (_, schedules) => {
    const { rerender } = render(<List state={LOADING} />);
    advance(UI_SKELETON_GATE_MS);
    expect(skeleton()).not.toBeNull();
    expect(groups()).toBe(1);

    advance(1);
    rerender(<List state={ready(schedules)} />);
    advance(UI_SKELETON_FLOOR_MS - 2);
    expect(skeleton()).not.toBeNull();
    expect(addButtons()).toBe(0);
    expect(screen.queryByText("Nightly audit")).toBeNull();

    advance(1);
    expect(skeleton()).toBeNull();
    expect(addButtons()).toBe(1);
    expect(screen.queryByText("Nightly audit") !== null).toBe(schedules.length > 0);
  });
});
