import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemMemoryWorkloads } from "@shared/types/ipc/system";

const notifyMock = vi.hoisted(() => vi.fn<(payload: { message: string }) => string>());
const dismissMock = vi.hoisted(() => vi.fn<(id: string) => void>());

const noticeShownMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/clients/systemClient", () => ({
  systemClient: { noteMemoryNoticeShown: noticeShownMock },
}));
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

function episode(fields: { reading: string; workloads: SystemMemoryWorkloads | null }) {
  return { episodeId: "episode-1", launchNoticeShown: false, ...fields };
}

const lastMessage = () => notifyMock.mock.calls.at(-1)?.[0]?.message;

describe("systemMemoryLaunchNotice", () => {
  beforeEach(() => {
    resetSystemMemoryLaunchNoticeForTesting();
    notifyMock.mockReset();
    let n = 0;
    notifyMock.mockImplementation(() => `notice-${++n}`);
    dismissMock.mockReset();
    noticeShownMock.mockClear();
  });

  it("stays quiet with no memory episode open, however many agents launch", () => {
    for (let i = 0; i < 12; i++) noteVisibleAgentLaunch();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises one grid-bar notice per episode, not one per launch", () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    noteVisibleAgentLaunch();
    noteVisibleAgentLaunch();
    noteVisibleAgentLaunch();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({ type: "warning", placement: "grid-bar" });
    expect(lastMessage()).toBe(
      "Swap is 91% full. When that was measured, 9 agents were running on this host, which has 36 GB of memory."
    );
  });

  it("tries again on the next launch when the notice was suppressed", () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    notifyMock.mockReturnValueOnce("");
    noteVisibleAgentLaunch();
    noteVisibleAgentLaunch();
    noteVisibleAgentLaunch();

    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't come back after a worsening publish in the same episode", () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    noteVisibleAgentLaunch();
    setSystemMemoryEpisode(episode({ reading: "Swap is 97% full.", workloads: workloads() }));
    noteVisibleAgentLaunch();

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("takes the bar down on recovery and raises it again in the next episode", () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    noteVisibleAgentLaunch();
    setSystemMemoryEpisode(null);
    expect(dismissMock).toHaveBeenCalledWith("notice-1");

    noteVisibleAgentLaunch();
    expect(notifyMock).toHaveBeenCalledTimes(1);

    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads({ agentsRunning: 1 }) }));
    noteVisibleAgentLaunch();
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(lastMessage()).toContain("1 agent was running");
  });

  it("tells Main once the bar is shown, so no other project view raises its own (#18274)", () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    notifyMock.mockReturnValueOnce("");
    noteVisibleAgentLaunch();
    expect(noticeShownMock).not.toHaveBeenCalled();

    noteVisibleAgentLaunch();
    expect(noticeShownMock).toHaveBeenCalledTimes(1);
    expect(noticeShownMock).toHaveBeenCalledWith({ episodeId: "episode-1", surface: "launch-bar" });
  });

  it("raises no bar in a view once another view showed it this episode (#18274)", () => {
    setSystemMemoryEpisode({
      ...episode({ reading: READING, workloads: workloads() }),
      launchNoticeShown: true,
    });
    noteVisibleAgentLaunch();
    expect(notifyMock).not.toHaveBeenCalled();

    // A new episode re-arms it.
    setSystemMemoryEpisode(null);
    setSystemMemoryEpisode({
      ...episode({ reading: READING, workloads: workloads() }),
      episodeId: "episode-2",
    });
    noteVisibleAgentLaunch();
    expect(notifyMock).toHaveBeenCalledTimes(1);
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
