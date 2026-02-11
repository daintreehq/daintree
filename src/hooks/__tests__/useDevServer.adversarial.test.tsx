// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

const { projectState, useProjectStoreMock } = vi.hoisted(() => {
  const projectState = {
    currentProject: { id: "project-1" } as { id: string } | null,
  };

  const useProjectStoreMock = vi.fn((selector: (state: typeof projectState) => unknown) =>
    selector(projectState)
  );

  return { projectState, useProjectStoreMock };
});

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildState(overrides: Partial<DevPreviewSessionState>): DevPreviewSessionState {
  return {
    panelId: overrides.panelId ?? "panel-1",
    projectId: overrides.projectId ?? "project-1",
    worktreeId: overrides.worktreeId,
    status: overrides.status ?? "stopped",
    url: overrides.url ?? null,
    error: overrides.error ?? null,
    terminalId: overrides.terminalId ?? null,
    isRestarting: overrides.isRestarting ?? false,
    generation: overrides.generation ?? 0,
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

import { useDevServer } from "../useDevServer";

describe("useDevServer adversarial races", () => {
  let ensureMock: ReturnType<typeof vi.fn>;
  let stopMock: ReturnType<typeof vi.fn>;
  let restartMock: ReturnType<typeof vi.fn>;
  let getStateMock: ReturnType<typeof vi.fn>;
  let onStateChangedMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    projectState.currentProject = { id: "project-1" };

    ensureMock = vi.fn(async (request: { projectId: string }) =>
      buildState({
        panelId: "panel-1",
        projectId: request.projectId,
        status: "starting",
        terminalId: `term-${request.projectId}`,
      })
    );
    stopMock = vi.fn(async (request: { projectId: string }) =>
      buildState({
        panelId: "panel-1",
        projectId: request.projectId,
        status: "stopped",
      })
    );
    restartMock = vi.fn(async (request: { projectId: string }) =>
      buildState({
        panelId: "panel-1",
        projectId: request.projectId,
        status: "starting",
        terminalId: `restart-${request.projectId}`,
      })
    );
    getStateMock = vi.fn(async (request: { projectId: string }) =>
      buildState({
        panelId: "panel-1",
        projectId: request.projectId,
        status: "stopped",
      })
    );
    onStateChangedMock = vi.fn(() => vi.fn());

    (window as unknown as { electron: Record<string, unknown> }).electron = {
      devPreview: {
        ensure: ensureMock,
        stop: stopMock,
        restart: restartMock,
        getState: getStateMock,
        onStateChanged: onStateChangedMock,
      },
    };
  });

  it("re-ensures when switching projects with otherwise identical panel config", async () => {
    const { rerender } = renderHook(() =>
      useDevServer({
        panelId: "panel-1",
        devCommand: "npm run dev",
        cwd: "/repo",
      })
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(ensureMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ projectId: "project-1" })
      );
    });

    projectState.currentProject = { id: "project-2" };
    rerender();

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ projectId: "project-2" })
      );
    });
  });

  it("ignores stale ensure responses from a previous project after switch", async () => {
    const firstEnsure = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { projectId: string }) => {
      if (request.projectId === "project-1") {
        return firstEnsure.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-2",
          status: "running",
          terminalId: "term-project-2",
          url: "http://localhost:4173/",
        })
      );
    });

    const { rerender, result } = renderHook(() =>
      useDevServer({
        panelId: "panel-1",
        devCommand: "npm run dev",
        cwd: "/repo",
      })
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
    });

    projectState.currentProject = { id: "project-2" };
    rerender();

    expect(ensureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstEnsure.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          status: "running",
          terminalId: "term-project-1",
          url: "http://localhost:3000/",
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(result.current.url).toBe("http://localhost:4173/");
      expect(result.current.terminalId).toBe("term-project-2");
    });

    expect(result.current.url).toBe("http://localhost:4173/");
    expect(result.current.terminalId).toBe("term-project-2");
    expect(result.current.status).toBe("running");
  });

  it("queues latest config while ensure is in-flight and applies it after completion", async () => {
    const firstEnsure = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { devCommand: string; projectId: string }) => {
      if (request.devCommand === "npm run dev") {
        return firstEnsure.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "starting",
          terminalId: "term-latest",
        })
      );
    });

    const { rerender } = renderHook(
      ({ devCommand }: { devCommand: string }) =>
        useDevServer({
          panelId: "panel-1",
          devCommand,
          cwd: "/repo",
        }),
      {
        initialProps: { devCommand: "npm run dev" },
      }
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(ensureMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ devCommand: "npm run dev" })
      );
    });

    rerender({ devCommand: "pnpm dev" });

    expect(ensureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstEnsure.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          status: "starting",
          terminalId: "term-first",
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ devCommand: "pnpm dev" })
      );
    });
  });

  it("re-ensures when worktree changes with otherwise identical config", async () => {
    const { rerender } = renderHook(
      ({ worktreeId }: { worktreeId?: string }) =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "npm run dev",
          cwd: "/repo",
          worktreeId,
        }),
      {
        initialProps: { worktreeId: "wt-1" },
      }
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(ensureMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ projectId: "project-1", worktreeId: "wt-1" })
      );
    });

    rerender({ worktreeId: "wt-2" });

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ projectId: "project-1", worktreeId: "wt-2" })
      );
    });
  });

  it("ignores stale ensure responses from previous worktree after switch", async () => {
    const firstEnsure = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { projectId: string; worktreeId?: string }) => {
      if (request.worktreeId === "wt-1") {
        return firstEnsure.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          worktreeId: "wt-2",
          status: "running",
          terminalId: "term-worktree-2",
          url: "http://localhost:5174/",
        })
      );
    });

    const { rerender, result } = renderHook(
      ({ worktreeId }: { worktreeId?: string }) =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "npm run dev",
          cwd: "/repo",
          worktreeId,
        }),
      {
        initialProps: { worktreeId: "wt-1" },
      }
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(ensureMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ projectId: "project-1", worktreeId: "wt-1" })
      );
    });

    rerender({ worktreeId: "wt-2" });

    expect(ensureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstEnsure.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          worktreeId: "wt-1",
          status: "running",
          terminalId: "term-worktree-1",
          url: "http://localhost:5173/",
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ projectId: "project-1", worktreeId: "wt-2" })
      );
      expect(result.current.url).toBe("http://localhost:5174/");
      expect(result.current.terminalId).toBe("term-worktree-2");
    });
  });

  it("applies latest project and worktree when both switch during in-flight ensure", async () => {
    const firstEnsure = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { projectId: string; worktreeId?: string }) => {
      if (request.projectId === "project-1") {
        return firstEnsure.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-2",
          worktreeId: "wt-2",
          status: "running",
          terminalId: "term-project-2",
          url: "http://localhost:4173/",
        })
      );
    });

    const { rerender, result } = renderHook(
      ({ worktreeId }: { worktreeId?: string }) =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "npm run dev",
          cwd: "/repo",
          worktreeId,
        }),
      {
        initialProps: { worktreeId: "wt-1" },
      }
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(ensureMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ projectId: "project-1", worktreeId: "wt-1" })
      );
    });

    projectState.currentProject = { id: "project-2" };
    rerender({ worktreeId: "wt-2" });

    expect(ensureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstEnsure.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          worktreeId: "wt-1",
          status: "running",
          terminalId: "term-project-1",
          url: "http://localhost:3000/",
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ projectId: "project-2", worktreeId: "wt-2" })
      );
      expect(result.current.status).toBe("running");
      expect(result.current.url).toBe("http://localhost:4173/");
      expect(result.current.terminalId).toBe("term-project-2");
    });
  });

  it("keeps simultaneous panels isolated when both ensure in the same worktree", async () => {
    const panelOneEnsure = createDeferred<DevPreviewSessionState>();
    const panelTwoEnsure = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { panelId: string; projectId: string }) => {
      if (request.panelId === "panel-1") {
        return panelOneEnsure.promise;
      }
      if (request.panelId === "panel-2") {
        return panelTwoEnsure.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: request.panelId,
          projectId: request.projectId,
          status: "starting",
        })
      );
    });

    const firstHook = renderHook(() =>
      useDevServer({
        panelId: "panel-1",
        devCommand: "npm run dev",
        cwd: "/repo",
        worktreeId: "wt-shared",
      })
    );
    const secondHook = renderHook(() =>
      useDevServer({
        panelId: "panel-2",
        devCommand: "npm run dev",
        cwd: "/repo",
        worktreeId: "wt-shared",
      })
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          panelId: "panel-1",
          projectId: "project-1",
          worktreeId: "wt-shared",
        })
      );
      expect(ensureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          panelId: "panel-2",
          projectId: "project-1",
          worktreeId: "wt-shared",
        })
      );
    });

    await act(async () => {
      panelTwoEnsure.resolve(
        buildState({
          panelId: "panel-2",
          projectId: "project-1",
          worktreeId: "wt-shared",
          status: "running",
          terminalId: "term-panel-2",
          url: "http://localhost:5174/",
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      panelOneEnsure.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          worktreeId: "wt-shared",
          status: "running",
          terminalId: "term-panel-1",
          url: "http://localhost:5173/",
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(firstHook.result.current.status).toBe("running");
      expect(firstHook.result.current.url).toBe("http://localhost:5173/");
      expect(firstHook.result.current.terminalId).toBe("term-panel-1");
      expect(secondHook.result.current.status).toBe("running");
      expect(secondHook.result.current.url).toBe("http://localhost:5174/");
      expect(secondHook.result.current.terminalId).toBe("term-panel-2");
    });
  });

  it("ignores stale stop responses from previous project after project switch", async () => {
    const stopDeferred = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: `term-${request.projectId}`,
          url:
            request.projectId === "project-1" ? "http://localhost:3000/" : "http://localhost:4173/",
        })
      )
    );

    stopMock.mockImplementation((request: { projectId: string }) => {
      if (request.projectId === "project-1") {
        return stopDeferred.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "stopped",
          terminalId: null,
          url: null,
        })
      );
    });

    const { rerender, result } = renderHook(
      ({ devCommand }: { devCommand: string }) =>
        useDevServer({
          panelId: "panel-1",
          devCommand,
          cwd: "/repo",
        }),
      {
        initialProps: { devCommand: "npm run dev" },
      }
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("running");
      expect(result.current.terminalId).toBe("term-project-1");
    });

    rerender({ devCommand: "" });

    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(stopMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ panelId: "panel-1", projectId: "project-1" })
      );
    });

    projectState.currentProject = { id: "project-2" };
    rerender({ devCommand: "npm run dev" });

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ panelId: "panel-1", projectId: "project-2" })
      );
      expect(result.current.status).toBe("running");
      expect(result.current.terminalId).toBe("term-project-2");
      expect(result.current.url).toBe("http://localhost:4173/");
    });

    await act(async () => {
      stopDeferred.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          status: "stopped",
          terminalId: null,
          url: null,
        })
      );
      await Promise.resolve();
    });

    expect(result.current.status).toBe("running");
    expect(result.current.terminalId).toBe("term-project-2");
    expect(result.current.url).toBe("http://localhost:4173/");
  });

  it("auto-restarts a stuck starting session once when no URL is detected", async () => {
    vi.useFakeTimers();
    try {
      ensureMock.mockImplementation((request: { projectId: string }) =>
        Promise.resolve(
          buildState({
            panelId: "panel-1",
            projectId: request.projectId,
            status: "starting",
            terminalId: `term-${request.projectId}`,
          })
        )
      );
      getStateMock.mockImplementation((request: { projectId: string }) =>
        Promise.resolve(
          buildState({
            panelId: "panel-1",
            projectId: request.projectId,
            status: "starting",
            terminalId: `term-${request.projectId}`,
          })
        )
      );
      restartMock.mockImplementation((request: { projectId: string }) =>
        Promise.resolve(
          buildState({
            panelId: "panel-1",
            projectId: request.projectId,
            status: "starting",
            terminalId: `restart-${request.projectId}`,
          })
        )
      );

      const { result } = renderHook(() =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "npm run dev",
          cwd: "/repo",
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.status).toBe("starting");
      expect(ensureMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });

      expect(restartMock).toHaveBeenCalledTimes(1);
      expect(restartMock).toHaveBeenCalledWith(
        expect.objectContaining({ panelId: "panel-1", projectId: "project-1" })
      );

      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });

      expect(restartMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale stop responses when command is re-enabled quickly", async () => {
    const stopDeferred = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { projectId: string; devCommand: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: request.devCommand === "pnpm dev" ? "term-second" : "term-first",
          url:
            request.devCommand === "pnpm dev" ? "http://localhost:4174/" : "http://localhost:5173/",
        })
      )
    );

    stopMock.mockImplementation(() => stopDeferred.promise);

    const { rerender, result } = renderHook(
      ({ devCommand }: { devCommand: string }) =>
        useDevServer({
          panelId: "panel-1",
          devCommand,
          cwd: "/repo",
        }),
      {
        initialProps: { devCommand: "npm run dev" },
      }
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("running");
      expect(result.current.terminalId).toBe("term-first");
    });

    rerender({ devCommand: "" });
    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledTimes(1);
    });

    rerender({ devCommand: "pnpm dev" });
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe("running");
      expect(result.current.terminalId).toBe("term-second");
      expect(result.current.url).toBe("http://localhost:4174/");
    });

    await act(async () => {
      stopDeferred.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          status: "stopped",
          terminalId: null,
          url: null,
        })
      );
      await Promise.resolve();
    });

    expect(result.current.status).toBe("running");
    expect(result.current.terminalId).toBe("term-second");
    expect(result.current.url).toBe("http://localhost:4174/");
  });

  it("ignores stale stop errors after switching project", async () => {
    const stopDeferred = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: `term-${request.projectId}`,
          url:
            request.projectId === "project-1" ? "http://localhost:3000/" : "http://localhost:4173/",
        })
      )
    );

    stopMock.mockImplementation(() => stopDeferred.promise);

    const { rerender, result } = renderHook(
      ({ devCommand }: { devCommand: string }) =>
        useDevServer({
          panelId: "panel-1",
          devCommand,
          cwd: "/repo",
        }),
      {
        initialProps: { devCommand: "npm run dev" },
      }
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("running");
    });

    rerender({ devCommand: "" });
    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledTimes(1);
    });

    projectState.currentProject = { id: "project-2" };
    rerender({ devCommand: "npm run dev" });
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe("running");
      expect(result.current.terminalId).toBe("term-project-2");
    });

    await act(async () => {
      stopDeferred.reject(new Error("old project stop failed"));
      await Promise.resolve();
    });

    expect(result.current.status).toBe("running");
    expect(result.current.terminalId).toBe("term-project-2");
    expect(result.current.error).toBeNull();
  });

  it("ignores stale restart responses from previous project after switch", async () => {
    const restartDeferred = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: `term-${request.projectId}`,
          url:
            request.projectId === "project-1" ? "http://localhost:3000/" : "http://localhost:4173/",
        })
      )
    );

    restartMock.mockImplementation((request: { projectId: string }) => {
      if (request.projectId === "project-1") {
        return restartDeferred.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "starting",
          terminalId: `restart-${request.projectId}`,
        })
      );
    });

    const { rerender, result } = renderHook(() =>
      useDevServer({
        panelId: "panel-1",
        devCommand: "npm run dev",
        cwd: "/repo",
      })
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("running");
      expect(result.current.terminalId).toBe("term-project-1");
    });

    await act(async () => {
      void result.current.restart();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(restartMock).toHaveBeenCalledTimes(1);
      expect(restartMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ panelId: "panel-1", projectId: "project-1" })
      );
    });

    projectState.currentProject = { id: "project-2" };
    rerender();

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe("running");
      expect(result.current.terminalId).toBe("term-project-2");
      expect(result.current.url).toBe("http://localhost:4173/");
    });

    await act(async () => {
      restartDeferred.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          status: "running",
          terminalId: "restart-project-1",
          url: "http://localhost:3001/",
        })
      );
      await Promise.resolve();
    });

    expect(result.current.status).toBe("running");
    expect(result.current.terminalId).toBe("term-project-2");
    expect(result.current.url).toBe("http://localhost:4173/");
  });

  it("ignores stale restart errors from previous project after switch", async () => {
    const restartDeferred = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: `term-${request.projectId}`,
          url:
            request.projectId === "project-1" ? "http://localhost:3000/" : "http://localhost:4173/",
        })
      )
    );

    restartMock.mockImplementation((request: { projectId: string }) => {
      if (request.projectId === "project-1") {
        return restartDeferred.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: `restart-${request.projectId}`,
          url: "http://localhost:4173/",
        })
      );
    });

    const { rerender, result } = renderHook(() =>
      useDevServer({
        panelId: "panel-1",
        devCommand: "npm run dev",
        cwd: "/repo",
      })
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("running");
    });

    await act(async () => {
      void result.current.restart();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(restartMock).toHaveBeenCalledTimes(1);
    });

    projectState.currentProject = { id: "project-2" };
    rerender();

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe("running");
      expect(result.current.terminalId).toBe("term-project-2");
    });

    await act(async () => {
      restartDeferred.reject(new Error("old project restart failed"));
      await Promise.resolve();
    });

    expect(result.current.status).toBe("running");
    expect(result.current.terminalId).toBe("term-project-2");
    expect(result.current.error).toBeNull();
  });

  it("only applies the latest queued config after many rapid changes", async () => {
    const firstEnsure = createDeferred<DevPreviewSessionState>();

    ensureMock.mockImplementation((request: { devCommand: string; projectId: string }) => {
      if (request.devCommand === "npm run dev") {
        return firstEnsure.promise;
      }
      return Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "starting",
          terminalId: "term-latest",
        })
      );
    });

    const { rerender } = renderHook(
      ({ devCommand }: { devCommand: string }) =>
        useDevServer({
          panelId: "panel-1",
          devCommand,
          cwd: "/repo",
        }),
      {
        initialProps: { devCommand: "npm run dev" },
      }
    );

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(ensureMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ devCommand: "npm run dev" })
      );
    });

    rerender({ devCommand: "pnpm dev" });
    rerender({ devCommand: "yarn dev" });
    rerender({ devCommand: "bun run dev" });

    expect(ensureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstEnsure.resolve(
        buildState({
          panelId: "panel-1",
          projectId: "project-1",
          status: "starting",
          terminalId: "term-first",
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ devCommand: "bun run dev" })
      );
    });
  });
});
