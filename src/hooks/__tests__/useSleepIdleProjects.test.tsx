// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Project } from "@shared/types/project";
import type {
  BulkProjectStatsEntry,
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
import { projectClient } from "@/clients/projectClient";
import { useProjectSleepConfirmStore } from "@/store/projectSleepConfirmStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectStore } from "@/store/projectStore";
import {
  selectIdleProjects,
  sleepIdleProjectsWithConfirm,
  useSleepIdleProjects,
} from "../useSleepIdleProjects";

function bulkEntry(overrides: Partial<BulkProjectStatsEntry> = {}): BulkProjectStatsEntry {
  return {
    processCount: 0,
    terminalCount: 0,
    estimatedMemoryMB: 0,
    terminalTypes: {},
    processIds: [],
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    ...overrides,
  };
}

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
  it("offers background projects with nothing working or blocked, never the one on screen", () => {
    const projects = [
      project("current"),
      project("waiting"),
      project("working"),
      project("blocked"),
      project("closed", "closed"),
      project("missing", "missing"),
      project("active-elsewhere", "active"),
      project("no-stats"),
      project("assistant-working"),
      project("assistant-directing"),
      project("assistant-approval"),
      project("assistant-prompt"),
    ];
    const stats: ProjectStatusMap = {
      current: entry(),
      // The stats can't say why these wait; the live check before the offer can.
      waiting: entry({ waitingAgentCount: 3, processCount: 4 }),
      working: entry({ activeAgentCount: 1 }),
      blocked: entry({ waitingAgentCount: 1, blockedAgentCount: 1, processCount: 1 }),
      closed: entry(),
      missing: entry(),
      "active-elsewhere": entry(),
      "assistant-working": entry({ assistantState: "working" }),
      "assistant-directing": entry({ assistantState: "directing" }),
      "assistant-approval": entry({
        assistantState: "waiting",
        assistantWaitingReason: "approval",
      }),
      "assistant-prompt": entry({ assistantState: "waiting", assistantWaitingReason: "prompt" }),
    };

    expect(selectIdleProjects(projects, stats, "current")).toEqual([
      {
        id: "waiting",
        name: "Project waiting",
        path: "/repos/waiting",
        waitingAgentCount: 3,
        terminalCount: 4,
      },
      {
        id: "assistant-prompt",
        name: "Project assistant-prompt",
        path: "/repos/assistant-prompt",
        waitingAgentCount: 0,
        terminalCount: 0,
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
    vi.spyOn(projectClient, "getBulkStats").mockResolvedValue({});
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
    useProjectSleepConfirmStore.getState().resolveConfirmation(false);
    useProjectStore.setState({ projects: [], currentProject: null, sleepProject: initialSleep });
    useProjectStatsStore.setState({ stats: {} });
  });

  const sleptIds = () => sleepProject.mock.calls.map(([id]) => id);
  const pending = () => useProjectSleepConfirmStore.getState().pendingConfirm;
  const previewIds = () => pending()?.request.projects.map((p) => p.id);

  type Hook = { current: ReturnType<typeof useSleepIdleProjects> };

  /** Starts the flow and waits for its confirmation to open; the returned promise settles after the batch. */
  async function openPreview(result: Hook): Promise<{ flow: Promise<void> }> {
    let flow!: Promise<void>;
    act(() => {
      flow = result.current.openPreview();
    });
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    // Boxed: returning the promise itself would make the async wrapper await the whole flow.
    return { flow };
  }

  async function confirm(flow: Promise<void>) {
    await act(async () => {
      useProjectSleepConfirmStore.getState().resolveConfirmation(true);
      await flow;
    });
  }

  async function openAndConfirm(result: Hook) {
    await confirm((await openPreview(result)).flow);
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

    await openPreview(result);
    expect(previewIds()).toEqual(["a"]);
  });

  it("leaves out a project whose agent waits on an approval, a question or an error", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    useProjectStore.setState({ projects: ids.map((id) => project(id)) });
    useProjectStatsStore.setState({ stats: Object.fromEntries(ids.map((id) => [id, entry()])) });
    terminals = [
      terminal("a", "waiting", { waitingReason: "prompt" }),
      terminal("b", "waiting", { waitingReason: "approval" }),
      terminal("c", "waiting", { waitingReason: "question" }),
      terminal("d", "waiting", { waitingReason: "error" }),
      // No reason recorded reads as a wait at the prompt, as it does everywhere.
      terminal("e", "waiting"),
    ];
    const { result } = renderHook(() => useSleepIdleProjects());
    await openPreview(result);
    expect(previewIds()).toEqual(["a", "e"]);
  });

  it("skips a project whose agent reached an approval after the preview", async () => {
    const { result } = renderHook(() => useSleepIdleProjects());
    const { flow } = await openPreview(result);
    expect(previewIds()).toEqual(["a", "b", "c"]);

    terminals = [terminal("b", "waiting", { waitingReason: "approval" })];
    await confirm(flow);
    expect(sleptIds()).toEqual(["a", "c"]);
  });

  it("resolves with how many actually slept, not how many were previewed", async () => {
    sleepProject.mockImplementation(async (id) => {
      if (id === "b") throw new Error("host did not acknowledge");
      return SLEPT;
    });
    const flow = sleepIdleProjectsWithConfirm();
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    useProjectSleepConfirmStore.getState().resolveConfirmation(true);
    expect(await flow).toBe(2);
  });

  it("resolves 0 when the user cancels, and sleeps without asking when already approved", async () => {
    const cancelled = sleepIdleProjectsWithConfirm();
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    useProjectSleepConfirmStore.getState().resolveConfirmation(false);
    expect(await cancelled).toBe(0);
    expect(sleptIds()).toEqual([]);

    expect(await sleepIdleProjectsWithConfirm({ alreadyApproved: true })).toBe(3);
    expect(pending()).toBeNull();
    expect(sleptIds()).toEqual(["a", "b", "c"]);
  });

  it("sleeps nothing when the confirmation is cancelled", async () => {
    const { result } = renderHook(() => useSleepIdleProjects());
    const { flow } = await openPreview(result);
    await act(async () => {
      useProjectSleepConfirmStore.getState().resolveConfirmation(false);
      await flow;
    });
    expect(sleptIds()).toEqual([]);
  });

  it("previews each project's terminal memory, leaving a missing reading unknown rather than zero", async () => {
    vi.mocked(projectClient.getBulkStats).mockResolvedValue({
      a: bulkEntry({ terminalMemoryMB: 512 }),
      b: bulkEntry(),
    });
    const { result } = renderHook(() => useSleepIdleProjects());
    await openPreview(result);
    expect(vi.mocked(projectClient.getBulkStats)).toHaveBeenCalledTimes(1);
    expect(pending()?.request.projects.map((p) => p.terminalMemoryMB)).toEqual([
      512,
      undefined,
      undefined,
    ]);
  });

  it("still offers the preview when the memory reading fails", async () => {
    vi.mocked(projectClient.getBulkStats).mockRejectedValue(new Error("rate limited"));
    const { result } = renderHook(() => useSleepIdleProjects());
    await openPreview(result);
    expect(previewIds()).toEqual(["a", "b", "c"]);
  });

  it("re-checks each project right before its own sleep, and never swaps one in", async () => {
    let releaseA!: () => void;
    sleepProject.mockImplementation(async (id) => {
      if (id === "a") await new Promise<void>((resolve) => (releaseA = resolve));
      return SLEPT;
    });
    const { result } = renderHook(() => useSleepIdleProjects());
    const { flow } = await openPreview(result);
    expect(previewIds()).toEqual(["a", "b", "c"]);

    act(() => {
      useProjectSleepConfirmStore.getState().resolveConfirmation(true);
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
      await flow;
    });

    expect(sleptIds()).toEqual(["a", "c"]);
    expect(pending()).toBeNull();
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
    // A: an exited agent still reads `working`, and a trashed one an approval.
    // B: the stats count two terminals but the host returned none for it, so
    // its state is unknown.
    terminals = [
      terminal("a", "working", { hasPty: false }),
      terminal("a", "waiting", { waitingReason: "approval", isTrashed: true }),
      terminal("c", "waiting"),
    ];
    const { result } = renderHook(() => useSleepIdleProjects());
    await openPreview(result);
    expect(previewIds()).toEqual(["a", "c"]);
  });

  it("offers nothing when a live reading fails", async () => {
    vi.mocked(terminalClient.getAll).mockRejectedValue(new Error("host stalled"));
    const { result } = renderHook(() => useSleepIdleProjects());
    await act(async () => {
      await result.current.openPreview();
    });
    expect(pending()).toBeNull();
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
    });
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(previewIds()).toEqual(["a", "c"]);
    await act(async () => {
      useProjectSleepConfirmStore.getState().resolveConfirmation(false);
      await opened;
    });
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
    const { flow } = await openPreview(result);
    act(() => {
      useProjectSleepConfirmStore.getState().resolveConfirmation(true);
    });
    await vi.waitFor(() => expect(releaseB).toBeTypeOf("function"));
    const retried = retry.onClick();
    await Promise.resolve();
    expect(sleepProject.mock.calls.map(([id]) => id)).toEqual(["a", "a", "b"]);
    await act(async () => {
      releaseB();
      await flow;
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
    expect(pending()).toBeNull();
    expect(vi.mocked(notify).mock.calls[0]![0].title).toBe("No idle projects");
  });
});
