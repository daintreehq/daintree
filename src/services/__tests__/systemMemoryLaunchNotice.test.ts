import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemMemoryWorkloads } from "@shared/types/ipc/system";

const notifyMock = vi.hoisted(() => vi.fn<(payload: { message: string }) => string>());
const dismissMock = vi.hoisted(() => vi.fn<(id: string) => void>());

// Main's once-per-episode claims (#18274): the first claim of a surface wins.
const granted = vi.hoisted(() => new Set<string>());
const claimMock = vi.hoisted(() =>
  vi.fn(async ({ episodeId, surface }: { episodeId: string; surface: string }) => {
    const key = `${episodeId}:${surface}`;
    if (granted.has(key)) return false;
    granted.add(key);
    return true;
  })
);
const releaseMock = vi.hoisted(() =>
  vi.fn(async ({ episodeId, surface }: { episodeId: string; surface: string }) => {
    granted.delete(`${episodeId}:${surface}`);
  })
);

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/clients/systemClient", () => ({
  systemClient: { claimMemoryNotice: claimMock, releaseMemoryNotice: releaseMock },
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
  return { episodeId: "episode-1", ...fields };
}

/** A visible launch, then Main's answer to the claim it makes. */
async function launch(): Promise<void> {
  noteVisibleAgentLaunch();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const lastMessage = () => notifyMock.mock.calls.at(-1)?.[0]?.message;

describe("systemMemoryLaunchNotice", () => {
  beforeEach(() => {
    resetSystemMemoryLaunchNoticeForTesting();
    notifyMock.mockReset();
    let n = 0;
    notifyMock.mockImplementation(() => `notice-${++n}`);
    dismissMock.mockReset();
    granted.clear();
    claimMock.mockClear();
    releaseMock.mockClear();
  });

  it("stays quiet with no memory episode open, however many agents launch", async () => {
    for (let i = 0; i < 12; i++) await launch();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises one grid-bar notice per episode, not one per launch", async () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    await launch();
    await launch();
    await launch();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({ type: "warning", placement: "grid-bar" });
    expect(lastMessage()).toBe(
      "Swap is 91% full. When that was measured, 9 agents were running on this host, which has 36 GB of memory."
    );
  });

  it("tries again on the next launch when the notice was suppressed", async () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    notifyMock.mockReturnValueOnce("");
    await launch();
    await launch();
    await launch();

    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't come back after a worsening publish in the same episode", async () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    await launch();
    setSystemMemoryEpisode(episode({ reading: "Swap is 97% full.", workloads: workloads() }));
    await launch();

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("takes the bar down on recovery and raises it again in the next episode", async () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    await launch();
    setSystemMemoryEpisode(null);
    expect(dismissMock).toHaveBeenCalledWith("notice-1");

    await launch();
    expect(notifyMock).toHaveBeenCalledTimes(1);

    setSystemMemoryEpisode({
      ...episode({ reading: READING, workloads: workloads({ agentsRunning: 1 }) }),
      episodeId: "episode-2",
    });
    await launch();
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(lastMessage()).toContain("1 agent was running");
  });

  it("claims the bar from Main before raising it, so only one project view raises it (#18274)", async () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    // Launches landing while the claim is out make no second claim.
    noteVisibleAgentLaunch();
    noteVisibleAgentLaunch();
    await launch();

    expect(claimMock.mock.calls).toEqual([[{ episodeId: "episode-1", surface: "launch-bar" }]]);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("raises no bar once another view holds it this episode, and raises one in the next (#18274)", async () => {
    granted.add("episode-1:launch-bar");
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    await launch();
    await launch();
    expect(notifyMock).not.toHaveBeenCalled();
    // Refused once, it stops asking for the rest of the episode.
    expect(claimMock).toHaveBeenCalledTimes(1);

    setSystemMemoryEpisode(null);
    setSystemMemoryEpisode({
      ...episode({ reading: READING, workloads: workloads() }),
      episodeId: "episode-2",
    });
    await launch();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("hands the bar back when it was swallowed, so another view's launch may raise it", async () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    notifyMock.mockReturnValueOnce("");
    await launch();

    expect(releaseMock).toHaveBeenCalledWith({ episodeId: "episode-1", surface: "launch-bar" });
  });

  it("re-arms the bar for a new episode this view heard without the recovery between", async () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    // A claim still out when the next episode arrives.
    noteVisibleAgentLaunch();
    setSystemMemoryEpisode({
      ...episode({ reading: READING, workloads: workloads() }),
      episodeId: "episode-2",
    });
    await launch();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(claimMock).toHaveBeenLastCalledWith({ episodeId: "episode-2", surface: "launch-bar" });
  });

  it("raises nothing for a claim Main answers after the episode recovered", async () => {
    setSystemMemoryEpisode(episode({ reading: READING, workloads: workloads() }));
    noteVisibleAgentLaunch();
    setSystemMemoryEpisode(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledWith({ episodeId: "episode-1", surface: "launch-bar" });
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
