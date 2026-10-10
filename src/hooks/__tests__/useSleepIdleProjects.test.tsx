// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Project } from "@shared/types/project";
import type {
  ProjectSleepResult,
  ProjectStatusEntry,
  ProjectStatusMap,
} from "@shared/types/ipc/project";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { notify } from "@/lib/notify";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectStore } from "@/store/projectStore";
import { selectIdleProjects, useSleepIdleProjects } from "../useSleepIdleProjects";

function project(id: string, status: Project["status"] = "background"): Project {
  return { id, name: `Project ${id}`, path: `/repos/${id}`, emoji: "🌲", lastOpened: 0, status };
}

function entry(overrides: Partial<ProjectStatusEntry> = {}): ProjectStatusEntry {
  return {
    activeAgentCount: 0,
    waitingAgentCount: 0,
    processCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    ...overrides,
  };
}

describe("selectIdleProjects", () => {
  it("offers background projects whose agents are only waiting, never the one on screen", () => {
    const projects = [
      project("current"),
      project("waiting"),
      project("working"),
      project("closed", "closed"),
      project("missing", "missing"),
      project("active-elsewhere", "active"),
      project("no-stats"),
      project("assistant-working"),
    ];
    const stats: ProjectStatusMap = {
      current: entry(),
      waiting: entry({ waitingAgentCount: 3, processCount: 4 }),
      working: entry({ activeAgentCount: 1 }),
      closed: entry(),
      missing: entry(),
      "active-elsewhere": entry(),
      "assistant-working": entry({ assistantState: "working" }),
    };

    expect(selectIdleProjects(projects, stats, "current")).toEqual([
      {
        id: "waiting",
        name: "Project waiting",
        path: "/repos/waiting",
        waitingAgentCount: 3,
        processCount: 4,
      },
    ]);
  });
});

describe("useSleepIdleProjects", () => {
  const SLEPT: ProjectSleepResult = {
    terminalsKilled: 0,
    rendererViewsEvicted: 0,
    workspaceEvicted: false,
  };
  const sleepProject = vi.fn<(id: string) => Promise<ProjectSleepResult>>();
  const initialSleep = useProjectStore.getState().sleepProject;

  beforeEach(() => {
    vi.mocked(notify).mockClear();
    sleepProject.mockReset();
    sleepProject.mockResolvedValue(SLEPT);
    useProjectStore.setState({
      projects: [project("a"), project("b"), project("c")],
      currentProject: null,
      sleepProject,
    });
    useProjectStatsStore.setState({ stats: { a: entry(), b: entry(), c: entry() } });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ projects: [], currentProject: null, sleepProject: initialSleep });
    useProjectStatsStore.setState({ stats: {} });
  });

  it("sleeps only what the preview showed, skipping anything that has since become busy", async () => {
    const { result } = renderHook(() => useSleepIdleProjects());
    act(() => result.current.openPreview());
    expect(result.current.preview?.map((p) => p.id)).toEqual(["a", "b", "c"]);

    // A project that turns idle later is not swapped in; one that started work is dropped.
    act(() => {
      useProjectStore.setState({
        projects: [project("a"), project("b"), project("c"), project("d")],
      });
      useProjectStatsStore.setState({
        stats: { a: entry(), b: entry({ activeAgentCount: 1 }), c: entry(), d: entry() },
      });
    });

    await act(async () => {
      await result.current.confirm();
    });
    expect(sleepProject.mock.calls.map(([id]) => id)).toEqual(["a", "c"]);
    expect(result.current.preview).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("carries on past a failure and reports the failures once, with a retry for them", async () => {
    sleepProject.mockImplementation(async (id) => {
      if (id === "b") throw new Error("host did not acknowledge");
      return SLEPT;
    });
    const { result } = renderHook(() => useSleepIdleProjects());
    act(() => result.current.openPreview());
    await act(async () => {
      await result.current.confirm();
    });

    expect(sleepProject.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(notify).mock.calls[0]![0];
    expect(payload.title).toBe("Couldn't sleep project");
    expect(String(payload.message)).toContain("Project b");
    expect(payload.context?.eventKind).toBe("uiFeedback");
    expect(payload.actions?.map((a) => a.label)).toEqual(["Try again"]);

    sleepProject.mockClear();
    sleepProject.mockResolvedValue(SLEPT);
    await payload.actions?.[0]?.onClick();
    expect(sleepProject.mock.calls.map(([id]) => id)).toEqual(["b"]);
  });

  it("opens nothing when no project is idle", () => {
    useProjectStatsStore.setState({ stats: {} });
    const { result } = renderHook(() => useSleepIdleProjects());
    expect(result.current.idleProjects).toEqual([]);
    act(() => result.current.openPreview());
    expect(result.current.preview).toBeNull();
  });
});
