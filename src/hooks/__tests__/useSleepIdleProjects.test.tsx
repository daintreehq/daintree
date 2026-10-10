// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Project } from "@shared/types/project";
import type {
  ProjectSleepResult,
  ProjectStatusEntry,
  ProjectStatusMap,
} from "@shared/types/ipc/project";
import type { ProjectPresenceSnapshot } from "@shared/types";
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { notify } from "@/lib/notify";
import { projectPresenceClient } from "@/clients/projectPresenceClient";
import { terminalClient } from "@/clients/terminalClient";
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

function terminal(
  projectId: string,
  agentState: BackendTerminalInfo["agentState"],
  overrides: Partial<BackendTerminalInfo> = {}
): BackendTerminalInfo {
  return { id: `t-${projectId}`, projectId, cwd: "/", spawnedAt: 0, agentState, ...overrides };
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
      project("assistant-directing"),
    ];
    const stats: ProjectStatusMap = {
      current: entry(),
      waiting: entry({ waitingAgentCount: 3, processCount: 4 }),
      working: entry({ activeAgentCount: 1 }),
      closed: entry(),
      missing: entry(),
      "active-elsewhere": entry(),
      "assistant-working": entry({ assistantState: "working" }),
      "assistant-directing": entry({ assistantState: "directing" }),
    };

    expect(selectIdleProjects(projects, stats, "current")).toEqual([
      {
        id: "waiting",
        name: "Project waiting",
        path: "/repos/waiting",
        waitingAgentCount: 3,
        terminalCount: 4,
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
  let presence: ProjectPresenceSnapshot;
  let terminals: BackendTerminalInfo[];

  beforeEach(() => {
    vi.mocked(notify).mockClear();
    sleepProject.mockReset();
    sleepProject.mockResolvedValue(SLEPT);
    presence = { thisWindow: [], otherWindows: [] };
    terminals = [];
    vi.spyOn(projectPresenceClient, "getSnapshot").mockImplementation(async () => presence);
    vi.spyOn(terminalClient, "getAll").mockImplementation(async () => terminals);
    useProjectStore.setState({
      projects: [project("a"), project("b"), project("c")],
      currentProject: null,
      sleepProject,
    });
    useProjectStatsStore.setState({ stats: { a: entry(), b: entry(), c: entry() } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useProjectStore.setState({ projects: [], currentProject: null, sleepProject: initialSleep });
    useProjectStatsStore.setState({ stats: {} });
  });

  const sleptIds = () => sleepProject.mock.calls.map(([id]) => id);

  async function openAndConfirm(result: { current: ReturnType<typeof useSleepIdleProjects> }) {
    await act(async () => {
      await result.current.openPreview();
    });
    await act(async () => {
      await result.current.confirm();
    });
  }

  it("leaves out a project with a working assistant the stats can't see, or one shown in another window", async () => {
    // B's assistant is hidden, so the stats say nothing about it.
    terminals = [terminal("b", "waiting"), terminal("b", "working")];
    presence = {
      thisWindow: [],
      otherWindows: [
        { projectId: "c", windowId: 2, state: "foreground" },
        { projectId: "a", windowId: 3, state: "cached" },
      ],
    };
    const { result } = renderHook(() => useSleepIdleProjects());
    expect(result.current.idleProjects.map((p) => p.id)).toEqual(["a", "b", "c"]);

    await act(async () => {
      await result.current.openPreview();
    });
    expect(result.current.preview?.map((p) => p.id)).toEqual(["a"]);
  });

  it("re-checks each project right before its own sleep, and never swaps one in", async () => {
    let releaseA!: () => void;
    sleepProject.mockImplementation(async (id) => {
      if (id === "a") await new Promise<void>((resolve) => (releaseA = resolve));
      return SLEPT;
    });
    const { result } = renderHook(() => useSleepIdleProjects());
    await act(async () => {
      await result.current.openPreview();
    });
    expect(result.current.preview?.map((p) => p.id)).toEqual(["a", "b", "c"]);

    let confirmed!: Promise<void>;
    act(() => {
      confirmed = result.current.confirm();
    });
    await vi.waitFor(() => expect(sleptIds()).toEqual(["a"]));

    // While A is still going down, B starts work and D turns idle.
    act(() => {
      useProjectStore.setState({
        projects: [project("a"), project("b"), project("c"), project("d")],
      });
      useProjectStatsStore.setState({
        stats: { a: entry(), b: entry({ activeAgentCount: 1 }), c: entry(), d: entry() },
      });
    });
    await act(async () => {
      releaseA();
      await confirmed;
    });

    expect(sleptIds()).toEqual(["a", "c"]);
    expect(result.current.preview).toBeNull();
    expect(result.current.isSleeping).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("carries on past failures, reports each project once in a toast, and retries through the same checks", async () => {
    sleepProject.mockImplementation(async (id) => {
      if (id !== "a") throw new Error("host did not acknowledge");
      return SLEPT;
    });
    const { result } = renderHook(() => useSleepIdleProjects());
    await openAndConfirm(result);

    expect(sleptIds()).toEqual(["a", "b", "c"]);
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(notify).mock.calls[0]![0];
    expect(payload.title).toBe("Couldn't sleep projects");
    expect(payload.priority).toBe("high");
    expect(String(payload.message)).toContain("'Project b', 'Project c'");
    expect(payload.context?.eventKind).toBe("uiFeedback");
    expect(payload.actions?.map((a) => a.label)).toEqual(["Try again"]);

    // C started work before the retry: only B is tried again.
    sleepProject.mockReset();
    sleepProject.mockResolvedValue(SLEPT);
    terminals = [terminal("c", "working")];
    await payload.actions?.[0]?.onClick();
    expect(sleptIds()).toEqual(["b"]);
  });

  it("ignores an exited record's stale state, but not a read that came back empty", async () => {
    useProjectStatsStore.setState({
      stats: { a: entry(), b: entry({ processCount: 2 }), c: entry() },
    });
    // A: an exited agent still reads `working`. B: the stats count two
    // terminals but the host returned none for it, so its state is unknown.
    terminals = [terminal("a", "working", { hasPty: false }), terminal("c", "waiting")];
    const { result } = renderHook(() => useSleepIdleProjects());
    await act(async () => {
      await result.current.openPreview();
    });
    expect(result.current.preview?.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("offers nothing when a live reading fails", async () => {
    vi.mocked(terminalClient.getAll).mockRejectedValue(new Error("host stalled"));
    const { result } = renderHook(() => useSleepIdleProjects());
    await act(async () => {
      await result.current.openPreview();
    });
    expect(result.current.preview).toBeNull();
  });

  it("drops a project that came on screen while its live reading was pending", async () => {
    let release!: () => void;
    vi.mocked(terminalClient.getAll).mockImplementation(
      () =>
        new Promise<BackendTerminalInfo[]>((resolve) => {
          release = () => resolve([]);
        })
    );
    const { result } = renderHook(() => useSleepIdleProjects());
    let opened!: Promise<void>;
    act(() => {
      opened = result.current.openPreview();
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    act(() => {
      useProjectStore.setState({ currentProject: project("b") });
    });
    await act(async () => {
      release();
      await opened;
    });
    expect(result.current.preview?.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("runs a retry after a batch still in flight rather than beside it", async () => {
    useProjectStore.setState({ projects: [project("a")] });
    sleepProject.mockRejectedValueOnce(new Error("host did not acknowledge"));
    const { result } = renderHook(() => useSleepIdleProjects());
    await openAndConfirm(result);
    const retry = vi.mocked(notify).mock.calls[0]![0].actions![0]!;

    act(() => {
      useProjectStore.setState({ projects: [project("a"), project("b")] });
      useProjectStatsStore.setState({ stats: { a: entry(), b: entry() } });
    });
    let releaseB!: () => void;
    sleepProject.mockImplementation(async (id) => {
      if (id === "b") await new Promise<void>((resolve) => (releaseB = resolve));
      useProjectStore.setState((state) => ({
        projects: state.projects.map((p) => (p.id === id ? { ...p, status: "closed" } : p)),
      }));
      return SLEPT;
    });
    await act(async () => {
      await result.current.openPreview();
    });
    let confirmed!: Promise<void>;
    act(() => {
      confirmed = result.current.confirm();
    });
    await vi.waitFor(() => expect(releaseB).toBeTypeOf("function"));
    const retried = retry.onClick();
    await Promise.resolve();
    expect(sleepProject.mock.calls.map(([id]) => id)).toEqual(["a", "a", "b"]);
    await act(async () => {
      releaseB();
      await confirmed;
      await retried;
    });
    // A slept in the confirmed batch, so the queued retry found nothing to do.
    expect(sleepProject.mock.calls.map(([id]) => id)).toEqual(["a", "a", "b"]);
  });

  it("names the one project and its reason when only one fails", async () => {
    useProjectStore.setState({ projects: [project("a")] });
    sleepProject.mockRejectedValue(new Error("host did not acknowledge"));
    const { result } = renderHook(() => useSleepIdleProjects());
    await openAndConfirm(result);

    const payload = vi.mocked(notify).mock.calls[0]![0];
    expect(payload.title).toBe("Couldn't sleep project");
    expect(String(payload.message)).toBe("'Project a' is still open. host did not acknowledge");
  });

  it("says so instead of opening an empty confirmation when nothing checks out idle", async () => {
    terminals = [terminal("a", "working"), terminal("b", "working")];
    presence = {
      thisWindow: [{ projectId: "c", windowId: 1, state: "activating" }],
      otherWindows: [],
    };
    const { result } = renderHook(() => useSleepIdleProjects());
    await act(async () => {
      await result.current.openPreview();
    });
    expect(result.current.preview).toBeNull();
    expect(vi.mocked(notify).mock.calls[0]![0].title).toBe("No idle projects");
  });
});
