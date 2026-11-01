// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";

const { client, records, worktrees } = vi.hoisted(() => ({
  client: { list: vi.fn(), onChanged: vi.fn() },
  records: { sessions: [] as AgentSessionRecord[] },
  // One map for every render, as the store hands back: a fresh one each time
  // would rebuild the items anyway and hide a missing names dependency.
  worktrees: new Map<string, unknown>([["wt1", { name: "feature-a", path: "/repo/wt-a" }]]),
}));

vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: client }));
vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => false }));
vi.mock("@/hooks/useAgentSessionRecords", () => ({
  useAgentSessionRecords: () => ({
    sessions: records.sessions,
    isLoading: false,
    failed: false,
    reload: vi.fn(),
  }),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: <T,>(selector: (state: { worktrees: Map<string, unknown> }) => T) =>
    selector({ worktrees }),
}));

import { useResumeSessionsPalette } from "../useResumeSessionsPalette";
import { usePaletteStore } from "@/store/paletteStore";
import { useProjectStore } from "@/store/projectStore";
import { _resetScheduleNamesForTests } from "@/store/scheduleNamesStore";

function rec(over: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    sessionId: "s1",
    agentId: "claude",
    worktreeId: "wt1",
    title: null,
    projectId: "p1",
    savedAt: 1_700_000_000_000,
    ...over,
  };
}

const scheduledRun = { scheduleId: "sched-1", runId: "run-1" };

let push: ((snapshot: SchedulesSnapshot) => void) | undefined;

function openPalette(open: boolean) {
  act(() => {
    usePaletteStore.setState({ activePaletteId: open ? "resume-sessions" : null });
  });
}

beforeEach(() => {
  _resetScheduleNamesForTests();
  push = undefined;
  client.list.mockReset();
  client.onChanged.mockReset();
  client.onChanged.mockImplementation((callback: (snapshot: SchedulesSnapshot) => void) => {
    push = callback;
    return () => {};
  });
  client.list.mockResolvedValue({
    projectId: "p1",
    revision: 1,
    schedules: [{ id: "sched-1", name: "Nightly triage" }],
  } as unknown as SchedulesSnapshot);
  records.sessions = [];
  usePaletteStore.setState({ activePaletteId: null });
  useProjectStore.setState({
    currentProject: { id: "p1", name: "App", path: "/repo", emoji: "", lastOpened: 0 },
  } as never);
});

describe("useResumeSessionsPalette schedule names", () => {
  it("reads no schedules while the palette is closed", async () => {
    records.sessions = [rec({ sessionId: "run", scheduledRun })];
    renderHook(() => useResumeSessionsPalette());
    await act(async () => {});
    expect(client.list).not.toHaveBeenCalled();
    expect(client.onChanged).not.toHaveBeenCalled();
  });

  it("reads no schedules when none of this project's sessions came from one", async () => {
    records.sessions = [
      rec({ sessionId: "hand" }),
      // Another project's run must not start this view's read.
      rec({ sessionId: "elsewhere", projectId: "p2", scheduledRun }),
    ];
    renderHook(() => useResumeSessionsPalette());
    openPalette(true);
    await act(async () => {});
    expect(client.list).not.toHaveBeenCalled();
    expect(client.onChanged).not.toHaveBeenCalled();
  });

  it("names a scheduled run's schedule once open, and finds the session by it", async () => {
    records.sessions = [rec({ sessionId: "run", scheduledRun }), rec({ sessionId: "hand" })];
    const { result } = renderHook(() => useResumeSessionsPalette());
    openPalette(true);
    await act(async () => {});

    const run = result.current.visibleResults.find((item) => item.session.sessionId === "run");
    expect(run?.schedule?.label).toBe("Nightly triage");

    act(() => result.current.setQuery("nightly"));
    expect(result.current.results.map((item) => item.session.sessionId)).toEqual(["run"]);

    act(() =>
      push?.({
        projectId: "p1",
        revision: 2,
        schedules: [],
      } as unknown as SchedulesSnapshot)
    );
    const deleted = result.current.results.find((item) => item.session.sessionId === "run");
    expect(deleted).toBeUndefined();
    act(() => result.current.setQuery(""));
    const afterDelete = result.current.visibleResults.find(
      (item) => item.session.sessionId === "run"
    );
    expect(afterDelete?.schedule?.name).toBeNull();
    expect(afterDelete?.schedule?.label).not.toBe("Nightly triage");
  });

  it("follows a rename while a search is showing", async () => {
    const sessions = [rec({ sessionId: "run", scheduledRun }), rec({ sessionId: "hand" })];
    records.sessions = sessions;
    const { result } = renderHook(() => useResumeSessionsPalette());
    openPalette(true);
    await act(async () => {});
    act(() => result.current.setQuery("nightly"));
    expect(result.current.results.map((item) => item.session.sessionId)).toEqual(["run"]);

    act(() =>
      push?.({
        projectId: "p1",
        revision: 2,
        schedules: [{ id: "sched-1", name: "Weekly review" }],
      } as unknown as SchedulesSnapshot)
    );
    expect(result.current.results).toEqual([]);
    act(() => result.current.setQuery("weekly"));
    expect(result.current.results.map((item) => item.session.sessionId)).toEqual(["run"]);
    expect(result.current.results[0]?.schedule?.label).toBe("Weekly review");
  });

  it("lets go of the names once the palette closes", async () => {
    const off = vi.fn();
    client.onChanged.mockImplementation(() => off);
    records.sessions = [rec({ sessionId: "run", scheduledRun })];
    renderHook(() => useResumeSessionsPalette());
    openPalette(true);
    await act(async () => {});
    expect(client.list).toHaveBeenCalledTimes(1);

    openPalette(false);
    expect(off).toHaveBeenCalledTimes(1);
  });
});
