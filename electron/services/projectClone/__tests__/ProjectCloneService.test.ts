import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectCloneState } from "../../../../shared/types/project.js";
import type { PersistedCloneJob } from "../../ProjectStore.js";
import type { ExecuteCloneOptions } from "../../../ipc/handlers/projectCrud/gitClone.js";

const h = vi.hoisted(() => {
  interface Row {
    project: Project;
    job: PersistedCloneJob | null;
  }
  const rows = new Map<string, Row>();
  const calls: Array<{
    options: ExecuteCloneOptions;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const events: string[] = [];
  /** When set, an aborted clone settles only once the test releases it. */
  const control = {
    holdTeardown: false,
    releaseTeardown: [] as Array<() => void>,
    destination: null as Promise<void> | null,
  };
  return { rows, calls, events, control };
});

vi.mock("../../../ipc/handlers/projectCrud/gitClone.js", async () => {
  const { AppError } = await import("../../../utils/errorTypes.js");
  return {
    resolveCloneTarget: (options: { url: string; parentPath: string; folderName: string }) => ({
      url: options.url,
      parentPath: options.parentPath,
      folderName: options.folderName.trim(),
      targetPath: `${options.parentPath}/${options.folderName.trim()}`,
    }),
    assertCloneDestination: vi.fn(async () => {
      if (h.control.destination) await h.control.destination;
    }),
    executeClone: vi.fn(
      (options: ExecuteCloneOptions) =>
        new Promise<void>((resolve, reject) => {
          h.calls.push({ options, resolve, reject });
          options.signal.addEventListener("abort", () => {
            const cancel = () =>
              reject(new AppError({ code: "CANCELLED", message: "Clone cancelled" }));
            if (h.control.holdTeardown) h.control.releaseTeardown.push(cancel);
            else cancel();
          });
        })
    ),
  };
});

vi.mock("../../ProjectStore.js", () => {
  const read = (id: string) => h.rows.get(id)?.project ?? null;
  return {
    projectStore: {
      getProjectByPath: vi.fn(async (p: string) => {
        for (const row of h.rows.values()) if (row.project.path === p) return row.project;
        return null;
      }),
      getProjectById: vi.fn((id: string) => read(id)),
      insertCloningProject: vi.fn(
        (
          projectPath: string,
          options: { identity?: { name: string; emoji: string }; job: PersistedCloneJob }
        ) => {
          const id = `id-${h.rows.size + 1}`;
          const project: Project = {
            id,
            path: projectPath,
            name: options.identity?.name ?? projectPath.split("/").pop()!,
            emoji: options.identity?.emoji ?? "🌲",
            lastOpened: 1,
            status: "closed",
            cloneState: "cloning",
          };
          h.rows.set(id, { project, job: options.job });
          return project;
        }
      ),
      setCloneState: vi.fn((id: string, state: ProjectCloneState, job: PersistedCloneJob) => {
        const row = h.rows.get(id);
        if (!row) throw new Error(`Project not found: ${id}`);
        row.project = { ...row.project, cloneState: state };
        row.job = job;
        return row.project;
      }),
      getCloneJob: vi.fn((id: string) => h.rows.get(id)?.job ?? null),
      getProjectsAwaitingClone: vi.fn(() =>
        [...h.rows.values()]
          .filter((row) => row.project.cloneState !== undefined)
          .map((row) => ({ project: row.project, job: row.job }))
      ),
      classifyGitBacking: vi.fn(async (p: string) => ({ gitBacked: true, gitRoot: p })),
      completeClone: vi.fn(async (id: string) => {
        const row = h.rows.get(id)!;
        const { cloneState: _cloneState, ...ready } = row.project;
        row.project = ready;
        row.job = null;
        h.events.push(`complete:${id}`);
        return row.project;
      }),
    },
  };
});

vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn((channel: string, payload: { id?: string; cloneState?: string }) => {
    h.events.push(`broadcast:${channel}:${payload?.id}:${payload?.cloneState ?? "ready"}`);
  }),
  broadcastToProjectRenderers: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  realpath: vi.fn(async (p: string) => p),
  lstat: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(async () => {}),
}));
vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));

import { ProjectCloneService } from "../ProjectCloneService.js";
import {
  isCheckoutPendingPath,
  isCheckoutPendingProject,
  resetCheckoutGateForTests,
} from "../checkoutGate.js";
import { broadcastToProjectRenderers } from "../../../ipc/utils.js";
import { projectStore } from "../../ProjectStore.js";
import { GitOperationError } from "../../../utils/errorTypes.js";
import { CHANNELS } from "../../../ipc/channels.js";

const request = (folderName: string) => ({
  url: "https://github.com/acme/widgets.git",
  parentPath: "/work",
  folderName,
  shallowClone: false,
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("ProjectCloneService", () => {
  let service: ProjectCloneService;

  beforeEach(() => {
    h.rows.clear();
    h.calls.length = 0;
    h.events.length = 0;
    h.control.holdTeardown = false;
    h.control.releaseTeardown.length = 0;
    h.control.destination = null;
    resetCheckoutGateForTests();
    vi.clearAllMocks();
    service = new ProjectCloneService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the project in its cloning state before git has finished", async () => {
    const { project } = await service.start(request("widgets"));

    expect(project.cloneState).toBe("cloning");
    expect(project.path).toBe("/work/widgets");
    expect(h.calls).toHaveLength(1);
    expect(isCheckoutPendingProject(project.id)).toBe(true);
    expect(isCheckoutPendingPath("/work/widgets")).toBe(true);
    expect(h.events).toContain(`broadcast:${CHANNELS.PROJECT_UPDATED}:${project.id}:cloning`);
    expect(service.getSnapshot(project.id)).toMatchObject({ status: "running", stages: [] });
  });

  it("follows git's phases and output in the snapshot", async () => {
    const { project } = await service.start(request("widgets"));
    const { onProgress, onOutput } = h.calls[0]!.options;

    onProgress("receiving objects", 40, "Receiving objects: 40%");
    onProgress("receiving objects", 100, "Receiving objects: 100%");
    onProgress("resolving deltas", 12, "Resolving deltas: 12%");
    onOutput?.("remote: Enumerating objects: 10\nResolving deltas:  12% (1/8)\r");

    const snapshot = service.getSnapshot(project.id)!;
    expect(snapshot.stages).toEqual([
      { key: "receiving objects", label: "Receiving objects", percent: 100 },
      { key: "resolving deltas", label: "Resolving deltas", percent: 12 },
    ]);
    expect(snapshot.currentStageKey).toBe("resolving deltas");
    expect(snapshot.output).toEqual([
      "remote: Enumerating objects: 10",
      "Resolving deltas:  12% (1/8)",
    ]);
  });

  it("names git's checkout phase for what it is", async () => {
    const { project } = await service.start(request("widgets"));
    h.calls[0]!.options.onProgress("updating files", 30, "Updating files: 30%");
    expect(service.getSnapshot(project.id)!.stages[0]!.label).toBe("Checking out files");
  });

  it("turns the project ready and loads its windows before any view hears about it", async () => {
    let finishLoading!: () => void;
    const onCheckoutReady = vi.fn((ready: Project) => {
      h.events.push(`ready-hook:${ready.id}:${ready.cloneState ?? "ready"}`);
      expect(isCheckoutPendingProject(ready.id)).toBe(false);
      return new Promise<void>((resolve) => (finishLoading = resolve));
    });
    service.setHooks({ onCheckoutReady });
    const { project } = await service.start(request("widgets"));
    h.events.length = 0;
    vi.mocked(broadcastToProjectRenderers).mockClear();

    h.calls[0]!.resolve();
    await flush();
    await flush();

    // The windows' workspaces are still loading: no view may hear it landed.
    expect(h.events).toEqual([`complete:${project.id}`, `ready-hook:${project.id}:ready`]);
    expect(broadcastToProjectRenderers).not.toHaveBeenCalled();

    finishLoading();
    await flush();

    expect(projectStore.classifyGitBacking).toHaveBeenCalledWith("/work/widgets");
    expect(h.events.at(-1)).toBe(`broadcast:${CHANNELS.PROJECT_UPDATED}:${project.id}:ready`);
    // Kept for a view that hydrated from an older row and asks afterwards.
    expect(service.getSnapshot(project.id)).toMatchObject({ status: "succeeded", canRetry: false });
  });

  it("stops only the clone it names when two run at once", async () => {
    const first = await service.start(request("one"));
    const second = await service.start(request("two"));

    service.cancel(first.project.id);
    await flush();

    expect(h.calls[0]!.options.signal.aborted).toBe(true);
    expect(h.calls[1]!.options.signal.aborted).toBe(false);
    expect(service.getSnapshot(first.project.id)!.status).toBe("cancelled");
    expect(service.getSnapshot(second.project.id)!.status).toBe("running");
    expect(h.rows.get(first.project.id)!.project.cloneState).toBe("cancelled");
    expect(h.rows.get(second.project.id)!.project.cloneState).toBe("cloning");
  });

  it("refuses a second clone into a folder a running clone owns", async () => {
    await service.start(request("widgets"));
    h.rows.clear();
    await expect(service.start(request("widgets"))).rejects.toThrow(/already exists/);
    expect(h.calls).toHaveLength(1);
  });

  it("keeps a failed clone on its project with git's scrubbed error, and retries it", async () => {
    const { project } = await service.start(request("widgets"));
    h.calls[0]!.reject(
      new GitOperationError(
        "auth-failed",
        "Authentication failed for https://u:secret-token-value@host/r",
        {
          op: "clone",
        }
      )
    );
    await flush();

    const failed = service.getSnapshot(project.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.gitReason).toBe("auth-failed");
    expect(failed.error).not.toContain("secret-token-value");
    expect(failed.canRetry).toBe(true);
    expect(h.rows.get(project.id)!.project.cloneState).toBe("failed");
    expect(h.rows.get(project.id)!.job).toMatchObject({ error: failed.error });

    expect(failed.error).toContain("Authentication failed");

    await service.retry(project.id);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.options.targetPath).toBe("/work/widgets");
    expect(h.rows.get(project.id)!.project.cloneState).toBe("cloning");
    const retried = service.getSnapshot(project.id)!;
    expect(retried).toMatchObject({ status: "running", error: null, stages: [], output: [] });
    expect(retried.gitReason).toBeUndefined();
    // Newer than anything the failed attempt published, so no view keeps it.
    expect(retried.sequence).toBeGreaterThan(failed.sequence);
  });

  it("offers no retry while a partial clone is still on disk", async () => {
    const { project } = await service.start(request("widgets"));
    const { onProgress } = h.calls[0]!.options;
    onProgress("cleanup-failed", 0, "Couldn't remove the partial clone");
    h.calls[0]!.reject(new Error("boom"));
    await flush();

    const snapshot = service.getSnapshot(project.id)!;
    expect(snapshot.cleanupError).toBe("Couldn't remove the partial clone");
    expect(snapshot.canRetry).toBe(false);
  });

  it("reads a failed clone from an earlier session back from its row", async () => {
    h.rows.set("old", {
      project: {
        id: "old",
        path: "/work/old",
        name: "old",
        emoji: "🌲",
        lastOpened: 1,
        cloneState: "failed",
      },
      job: { url: "git@github.com:acme/old.git", shallow: true, error: "Repository not found" },
    });

    const snapshot = service.getSnapshot("old")!;
    expect(snapshot).toMatchObject({
      status: "failed",
      error: "Repository not found",
      canRetry: true,
      targetPath: "/work/old",
    });

    await service.retry("old");
    expect(h.calls[0]!.options).toMatchObject({
      url: "git@github.com:acme/old.git",
      depth: "shallow",
    });
  });

  it("records a clone the app quit on as failed, not as stopped", async () => {
    const { project } = await service.start(request("widgets"));
    await service.shutdown(1000);

    expect(h.calls[0]!.options.signal.aborted).toBe(true);
    expect(h.rows.get(project.id)!.project.cloneState).toBe("failed");
    expect(h.rows.get(project.id)!.job!.error).toMatch(/Daintree closed/);
    await expect(service.start(request("other"))).rejects.toThrow(/quitting/);
  });

  it("waits for a running clone to tear down before its project is removed", async () => {
    const { project } = await service.start(request("widgets"));
    h.control.holdTeardown = true;
    let released = false;
    const removal = service.releaseForRemoval(project.id).then((end) => {
      released = true;
      return end;
    });
    await flush();

    expect(h.calls[0]!.options.signal.aborted).toBe(true);
    // Git is still tearing down: the row must not go yet.
    expect(released).toBe(false);

    h.control.releaseTeardown.forEach((cancel) => cancel());
    const end = await removal;
    // Still gated until the row is actually gone.
    expect(isCheckoutPendingProject(project.id)).toBe(true);
    h.rows.delete(project.id);
    end(true);
    expect(isCheckoutPendingProject(project.id)).toBe(false);
    expect(service.getSnapshot(project.id)).toBeNull();
  });

  it("keeps a project gated when its removal fails", async () => {
    const { project } = await service.start(request("widgets"));
    const end = await service.releaseForRemoval(project.id);
    end(false);
    expect(isCheckoutPendingProject(project.id)).toBe(true);
    expect(service.getSnapshot(project.id)!.status).toBe("cancelled");
  });

  it("lets a second Retry join the first instead of launching another clone", async () => {
    const { project } = await service.start(request("widgets"));
    h.calls[0]!.reject(new Error("boom"));
    await flush();
    let releaseCheck!: () => void;
    h.control.destination = new Promise<void>((resolve) => (releaseCheck = resolve));

    const first = service.retry(project.id);
    const second = service.retry(project.id);
    releaseCheck();
    await Promise.all([first, second]);

    expect(h.calls).toHaveLength(2);
  });

  it("starts no clone for a Retry that a removal overtook", async () => {
    const { project } = await service.start(request("widgets"));
    h.calls[0]!.reject(new Error("boom"));
    await flush();
    let releaseCheck!: () => void;
    h.control.destination = new Promise<void>((resolve) => (releaseCheck = resolve));

    const retrying = service.retry(project.id);
    const removal = service.releaseForRemoval(project.id);
    releaseCheck();

    await expect(retrying).rejects.toThrow(/being removed/);
    (await removal)(true);
    expect(h.calls).toHaveLength(1);
  });

  it("launches nothing for a start that was still checking when quit began", async () => {
    let releaseCheck!: () => void;
    h.control.destination = new Promise<void>((resolve) => (releaseCheck = resolve));
    const starting = service.start(request("widgets"));
    await flush();

    await service.shutdown(1000);
    releaseCheck();

    await expect(starting).rejects.toThrow(/quitting/);
    expect(h.calls).toHaveLength(0);
    expect(h.rows.size).toBe(0);
  });

  it("treats two spellings of one folder as one on a case-insensitive volume", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      await service.start(request("widgets"));
      await expect(service.start(request("Widgets"))).rejects.toThrow(/already exists/);
      expect(h.calls).toHaveLength(1);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  describe("recoverInterrupted", () => {
    const seed = (id: string, state: ProjectCloneState) =>
      h.rows.set(id, {
        project: {
          id,
          path: `/work/${id}`,
          name: id,
          emoji: "🌲",
          lastOpened: 1,
          cloneState: state,
        },
        job: { url: `https://github.com/acme/${id}.git`, shallow: false },
      });

    it("removes the partial checkout a crash left and marks the clone failed", async () => {
      seed("crashed", "cloning");
      fsMock.lstat.mockResolvedValue({ isDirectory: () => true });
      fsMock.readdir.mockResolvedValue([".git"]);

      await service.recoverInterrupted();

      expect(fsMock.rm).toHaveBeenCalledWith("/work/crashed", { recursive: true, force: true });
      expect(h.rows.get("crashed")!.project.cloneState).toBe("failed");
      expect(h.rows.get("crashed")!.job).toMatchObject({
        url: "https://github.com/acme/crashed.git",
        error: expect.stringMatching(/Daintree closed/),
      });
      expect(isCheckoutPendingPath("/work/crashed")).toBe(true);
    });

    it("leaves a folder that isn't provably the clone's and says so", async () => {
      seed("crowded", "cloning");
      fsMock.lstat.mockResolvedValue({ isDirectory: () => true });
      fsMock.readdir.mockResolvedValue(["notes.txt"]);

      await service.recoverInterrupted();

      expect(fsMock.rm).not.toHaveBeenCalled();
      expect(h.rows.get("crowded")!.job!.cleanupError).toMatch(/\/work\/crowded/);
    });

    it("keeps an already failed clone gated without touching it", async () => {
      seed("failed", "failed");
      await service.recoverInterrupted();
      expect(projectStore.setCloneState).not.toHaveBeenCalled();
      expect(fsMock.lstat).not.toHaveBeenCalled();
      expect(isCheckoutPendingProject("failed")).toBe(true);
    });
  });

  it("coalesces progress pushes to the project's views", async () => {
    vi.useFakeTimers();
    const { project } = await service.start(request("widgets"));
    vi.mocked(broadcastToProjectRenderers).mockClear();
    const { onProgress } = h.calls[0]!.options;

    onProgress("receiving objects", 1, "Receiving objects: 1%");
    onProgress("receiving objects", 2, "Receiving objects: 2%");
    onProgress("receiving objects", 3, "Receiving objects: 3%");
    // The stage change goes out at once; the two ticks after it wait.
    expect(broadcastToProjectRenderers).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(150);
    expect(broadcastToProjectRenderers).toHaveBeenCalledTimes(2);
    const last = vi.mocked(broadcastToProjectRenderers).mock.calls.at(-1)!;
    expect(last[0]).toBe(project.id);
    expect(last[1]).toBe(CHANNELS.PROJECT_CLONE_JOB_UPDATED);
    expect((last[2] as { stages: Array<{ percent: number }> }).stages[0]!.percent).toBe(3);
  });
});
