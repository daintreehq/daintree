import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemMemoryWorkloads } from "@shared/types/ipc/system";

const notifyMock = vi.hoisted(() => vi.fn<(payload: { message: string }) => string>());
const dismissMock = vi.hoisted(() => vi.fn<(id: string) => void>());

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: { getState: () => ({ dismissNotification: dismissMock }) },
}));

const {
  describeLaunchDuringMemoryEpisode,
  noteVisibleAgentLaunch,
  resetSystemMemoryLaunchNoticeForTesting,
  setSystemMemoryEpisode,
} = await import("../systemMemoryLaunchNotice");

const READING = "Swap is 91% full.";

function workloads(overrides: Partial<SystemMemoryWorkloads> = {}): SystemMemoryWorkloads {
  return { appMemoryMb: 1500, projects: [], agentsRunning: 9, memoryTotalMb: 36864, ...overrides };
}

const lastMessage = () => notifyMock.mock.calls.at(-1)?.[0]?.message;

describe("systemMemoryLaunchNotice", () => {
  beforeEach(() => {
    resetSystemMemoryLaunchNoticeForTesting();
    notifyMock.mockReset();
    let n = 0;
    notifyMock.mockImplementation(() => `notice-${++n}`);
    dismissMock.mockReset();
  });

  it("stays quiet with no memory episode open, however many agents launch", () => {
    for (let i = 0; i < 12; i++) noteVisibleAgentLaunch();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises one grid-bar notice per episode, not one per launch", () => {
    setSystemMemoryEpisode({ reading: READING, workloads: workloads() });
    noteVisibleAgentLaunch();
    noteVisibleAgentLaunch();
    noteVisibleAgentLaunch();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({ type: "warning", placement: "grid-bar" });
    expect(lastMessage()).toBe(
      "Swap is 91% full. When that was measured, 9 agents were running on this host, which has 36 GB of memory."
    );
  });

  it("doesn't come back after a worsening publish in the same episode", () => {
    setSystemMemoryEpisode({ reading: READING, workloads: workloads() });
    noteVisibleAgentLaunch();
    setSystemMemoryEpisode({ reading: "Swap is 97% full.", workloads: workloads() });
    noteVisibleAgentLaunch();

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("takes the bar down on recovery and raises it again in the next episode", () => {
    setSystemMemoryEpisode({ reading: READING, workloads: workloads() });
    noteVisibleAgentLaunch();
    setSystemMemoryEpisode(null);
    expect(dismissMock).toHaveBeenCalledWith("notice-1");

    noteVisibleAgentLaunch();
    expect(notifyMock).toHaveBeenCalledTimes(1);

    setSystemMemoryEpisode({ reading: READING, workloads: workloads({ agentsRunning: 1 }) });
    noteVisibleAgentLaunch();
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(lastMessage()).toContain("1 agent was running");
  });

  it("states only the figures it has", () => {
    expect(
      describeLaunchDuringMemoryEpisode({
        reading: READING,
        workloads: workloads({ agentsRunning: null }),
      })
    ).toBe("Swap is 91% full. This host has 36 GB of memory.");
    expect(
      describeLaunchDuringMemoryEpisode({
        reading: READING,
        workloads: workloads({ memoryTotalMb: null }),
      })
    ).toBe("Swap is 91% full. When that was measured, 9 agents were running on this host.");
    expect(describeLaunchDuringMemoryEpisode({ reading: READING, workloads: null })).toBe(READING);
    expect(
      describeLaunchDuringMemoryEpisode({
        reading: READING,
        workloads: workloads({ memoryTotalMb: 8 * 1024 - 400 }),
      })
    ).toContain("7.6 GB of memory");
  });
});
