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
    predictedUrl: overrides.predictedUrl ?? null,
    error: overrides.error ?? null,
    terminalId: overrides.terminalId ?? null,
    isRestarting: overrides.isRestarting ?? false,
    generation: overrides.generation ?? 0,
    updatedAt: overrides.updatedAt ?? Date.now(),
    phaseLabel: overrides.phaseLabel ?? undefined,
  };
}

import { useDevServer, _resetPersistedEnsureCacheForTests } from "../useDevServer";

describe("useDevServer adversarial races", () => {
  let ensureMock: ReturnType<typeof vi.fn>;
  let stopMock: ReturnType<typeof vi.fn>;
  let restartMock: ReturnType<typeof vi.fn>;
  let getStateMock: ReturnType<typeof vi.fn>;
  let onStateChangedMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPersistedEnsureCacheForTests();
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

  it("escalates stuckTier at 6s/20s/45s without restarting a stuck starting session (#8276, retuned #9099)", async () => {
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
      expect(result.current.stuckTier).toBe(0);
      expect(ensureMock).toHaveBeenCalledTimes(1);

      // 0 → 6000 (Tier 1)
      await act(async () => {
        vi.advanceTimersByTime(6000);
        await Promise.resolve();
      });
      expect(result.current.stuckTier).toBe(1);

      // 6000 → 20000 (Tier 2)
      await act(async () => {
        vi.advanceTimersByTime(14000);
        await Promise.resolve();
      });
      expect(result.current.stuckTier).toBe(2);

      // 20000 → 45000 (Tier 3)
      await act(async () => {
        vi.advanceTimersByTime(25000);
        await Promise.resolve();
      });
      expect(result.current.stuckTier).toBe(3);

      // The #8276 contract: escalation never silently restarts.
      expect(restartMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending stuck timers when the server recovers (#8276)", async () => {
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
      let stateChangedHandler: ((payload: { state: DevPreviewSessionState }) => void) | null = null;
      onStateChangedMock.mockImplementation(
        (cb: (payload: { state: DevPreviewSessionState }) => void) => {
          stateChangedHandler = cb;
          return vi.fn();
        }
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

      await act(async () => {
        vi.advanceTimersByTime(8000);
        await Promise.resolve();
      });
      expect(result.current.stuckTier).toBe(1);

      // Server reports a URL — the stuck timer effect must tear down its
      // pending tier-2/tier-3 timers and reset the tier.
      await act(async () => {
        stateChangedHandler?.({
          state: buildState({
            panelId: "panel-1",
            projectId: "project-1",
            status: "running",
            terminalId: "term-project-1",
            url: "http://localhost:3000/",
          }),
        });
        await Promise.resolve();
      });

      expect(result.current.status).toBe("running");
      expect(result.current.stuckTier).toBe(0);

      await act(async () => {
        vi.advanceTimersByTime(30000);
        await Promise.resolve();
      });

      expect(result.current.stuckTier).toBe(0);
      expect(restartMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances stuckTier exactly on the 6s/20s/45s boundaries (#8276, retuned #9099)", async () => {
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

      const tick = async (ms: number) => {
        await act(async () => {
          vi.advanceTimersByTime(ms);
          await Promise.resolve();
        });
      };

      await tick(5999);
      expect(result.current.stuckTier).toBe(0);
      await tick(1); // 6000
      expect(result.current.stuckTier).toBe(1);
      await tick(13999); // 19999
      expect(result.current.stuckTier).toBe(1);
      await tick(1); // 20000
      expect(result.current.stuckTier).toBe(2);
      await tick(24999); // 44999
      expect(result.current.stuckTier).toBe(2);
      await tick(1); // 45000
      expect(result.current.stuckTier).toBe(3);

      expect(restartMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses Tier 2 when phaseLabel turns 'Compiling' before the 20s mark (#9099)", async () => {
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
      let stateChangedHandler: ((payload: { state: DevPreviewSessionState }) => void) | null = null;
      onStateChangedMock.mockImplementation(
        (cb: (payload: { state: DevPreviewSessionState }) => void) => {
          stateChangedHandler = cb;
          return vi.fn();
        }
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

      // Advance past Tier 1 — confirm ambient signal still fires.
      await act(async () => {
        vi.advanceTimersByTime(6000);
        await Promise.resolve();
      });
      expect(result.current.stuckTier).toBe(1);

      // Backend emits "Compiling" before the 20s Tier 2 timer fires.
      await act(async () => {
        stateChangedHandler?.({
          state: buildState({
            panelId: "panel-1",
            projectId: "project-1",
            status: "starting",
            terminalId: "term-project-1",
            phaseLabel: "Compiling",
          }),
        });
        await Promise.resolve();
      });
      expect(result.current.phaseLabel).toBe("Compiling");

      // 6000 → 20000: Tier 2 timer fires, but the fire-time guard
      // suppresses it because Compiling is now active.
      await act(async () => {
        vi.advanceTimersByTime(14000);
        await Promise.resolve();
      });
      expect(result.current.stuckTier).toBe(1);

      // 20000 → 45000: Tier 3 still fires even mid-compile.
      await act(async () => {
        vi.advanceTimersByTime(25000);
        await Promise.resolve();
      });
      expect(result.current.stuckTier).toBe(3);

      expect(restartMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // #12299: the downgrade effect used `prev >= 2`, so a compile signal arriving
  // *after* Tier 3 had fired collapsed the 45s warning to Tier 1 — the opposite
  // of the "Tier 3 still fires at 45s even mid-compile" rule it sits next to.
  it("keeps Tier 3 when a compile signal arrives after the 45s mark (#12299)", async () => {
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
      let stateChangedHandler: ((payload: { state: DevPreviewSessionState }) => void) | null = null;
      onStateChangedMock.mockImplementation(
        (cb: (payload: { state: DevPreviewSessionState }) => void) => {
          stateChangedHandler = cb;
          return vi.fn();
        }
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

      // Run all three timers out with no compile signal at all.
      await act(async () => {
        vi.advanceTimersByTime(45000);
        await Promise.resolve();
      });
      expect(result.current.stuckTier).toBe(3);

      // Only now does the backend report a compile. A 45s start that is still
      // compiling is exactly the case Tier 3 exists to surface.
      await act(async () => {
        stateChangedHandler?.({
          state: buildState({
            panelId: "panel-1",
            projectId: "project-1",
            status: "starting",
            terminalId: "term-project-1",
            phaseLabel: "Compiling",
          }),
        });
        await Promise.resolve();
      });

      expect(result.current.phaseLabel).toBe("Compiling");
      expect(result.current.stuckTier).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows Tier 2 to fire normally when phaseLabel never reaches 'Compiling' (#9099)", async () => {
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

      // Advance to 20s with no Compiling signal — Tier 2 must fire.
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });
      expect(result.current.phaseLabel).toBeUndefined();
      expect(result.current.stuckTier).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-restart a stuck installing session (backend handles install lifecycle)", async () => {
    vi.useFakeTimers();
    try {
      ensureMock.mockImplementation((request: { projectId: string }) =>
        Promise.resolve(
          buildState({
            panelId: "panel-1",
            projectId: request.projectId,
            status: "installing",
            terminalId: `term-${request.projectId}`,
          })
        )
      );
      getStateMock.mockImplementation((request: { projectId: string }) =>
        Promise.resolve(
          buildState({
            panelId: "panel-1",
            projectId: request.projectId,
            status: "installing",
            terminalId: `term-${request.projectId}`,
          })
        )
      );

      const { result } = renderHook(() =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "npm install && npm run dev",
          cwd: "/repo",
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.status).toBe("installing");
      expect(ensureMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(120000);
        await Promise.resolve();
      });

      expect(restartMock).not.toHaveBeenCalled();
      // Installing is exempt from stuck-start escalation (#8276).
      expect(result.current.stuckTier).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-restart installing session with URL present", async () => {
    vi.useFakeTimers();
    try {
      ensureMock.mockImplementation((request: { projectId: string }) =>
        Promise.resolve(
          buildState({
            panelId: "panel-1",
            projectId: request.projectId,
            status: "installing",
            terminalId: `term-${request.projectId}`,
            url: "http://localhost:3000/",
          })
        )
      );
      getStateMock.mockImplementation((request: { projectId: string }) =>
        Promise.resolve(
          buildState({
            panelId: "panel-1",
            projectId: request.projectId,
            status: "installing",
            terminalId: `term-${request.projectId}`,
            url: "http://localhost:3000/",
          })
        )
      );

      const { result } = renderHook(() =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "npm install && npm run dev",
          cwd: "/repo",
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.status).toBe("installing");
      expect(result.current.url).toBe("http://localhost:3000/");

      await act(async () => {
        vi.advanceTimersByTime(120000);
        await Promise.resolve();
      });

      expect(restartMock).not.toHaveBeenCalled();
      expect(result.current.stuckTier).toBe(0);
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

  it("skips ensure() on remount when session was already ensured with same config", async () => {
    ensureMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: "term-1",
          url: "http://localhost:3000/",
        })
      )
    );
    getStateMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: "term-1",
          url: "http://localhost:3000/",
        })
      )
    );

    const props = {
      panelId: "panel-1",
      devCommand: "npm run dev",
      cwd: "/repo",
    };

    // First mount: ensure() fires
    const { unmount, result } = renderHook(() => useDevServer(props));
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("running");
    });

    // Unmount (simulates dock → grid transition)
    unmount();

    // Remount with identical props: ensure() should NOT fire again
    const { result: result2 } = renderHook(() => useDevServer(props));
    await waitFor(() => {
      expect(result2.current.status).toBe("running");
      expect(result2.current.url).toBe("http://localhost:3000/");
    });

    // ensure() was only called once total (from the first mount)
    expect(ensureMock).toHaveBeenCalledTimes(1);
    // getState() was called on both mounts
    expect(getStateMock).toHaveBeenCalledTimes(2);
  });

  it("re-ensures on remount after stop() was called", async () => {
    ensureMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: "term-1",
          url: "http://localhost:3000/",
        })
      )
    );
    getStateMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "stopped",
        })
      )
    );

    const props = {
      panelId: "panel-1",
      devCommand: "npm run dev",
      cwd: "/repo",
    };

    const { unmount, result } = renderHook(() => useDevServer(props));
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("running");
    });

    // Call stop() — invalidates the persisted cache
    act(() => {
      result.current.stop();
    });
    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledTimes(1);
    });

    unmount();

    // Remount: ensure() should fire again because stop() cleared the cache
    renderHook(() => useDevServer(props));
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
    });
  });

  it("re-ensures on remount after crash via onStateChanged", async () => {
    let stateChangedCallback: ((payload: { state: DevPreviewSessionState }) => void) | null = null;
    onStateChangedMock.mockImplementation(
      (cb: (payload: { state: DevPreviewSessionState }) => void) => {
        stateChangedCallback = cb;
        return vi.fn();
      }
    );

    ensureMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: "term-1",
          url: "http://localhost:3000/",
        })
      )
    );
    getStateMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: "term-1",
          url: "http://localhost:3000/",
        })
      )
    );

    const props = {
      panelId: "panel-1",
      devCommand: "npm run dev",
      cwd: "/repo",
    };

    const { unmount } = renderHook(() => useDevServer(props));
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
    });

    // Simulate server crash via onStateChanged
    act(() => {
      stateChangedCallback?.({
        state: buildState({
          panelId: "panel-1",
          projectId: "project-1",
          status: "error",
          error: { type: "unknown", message: "Server crashed" },
        }),
      });
    });

    unmount();

    // Remount: ensure() should fire because crash cleared the cache
    renderHook(() => useDevServer(props));
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
    });
  });

  it("re-ensures on remount when configKey changes", async () => {
    ensureMock.mockImplementation((request: { projectId: string }) =>
      Promise.resolve(
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "running",
          terminalId: "term-1",
          url: "http://localhost:3000/",
        })
      )
    );

    const { unmount } = renderHook(() =>
      useDevServer({
        panelId: "panel-1",
        devCommand: "npm run dev",
        cwd: "/repo",
      })
    );
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(1);
    });

    unmount();

    // Remount with different devCommand: ensure() must fire
    renderHook(() =>
      useDevServer({
        panelId: "panel-1",
        devCommand: "pnpm dev",
        cwd: "/repo",
      })
    );
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ devCommand: "pnpm dev" })
      );
    });
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

  describe("restored-stopped auto-start on relaunch", () => {
    it("auto-ensures (restarts the dev server) when the panel is restored-stopped on launch", async () => {
      // A dev server that was running when Daintree closed comes back when the
      // project reopens — cold launch or live switch alike — instead of stalling
      // on the restart CTA.
      getStateMock.mockImplementation(async (request: { projectId: string }) =>
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "restored-stopped",
        })
      );

      renderHook(() =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "npm run dev",
          cwd: "/repo",
        })
      );

      await waitFor(() => {
        expect(ensureMock).toHaveBeenCalledTimes(1);
      });
      expect(ensureMock).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-1", devCommand: "npm run dev" })
      );
    });

    it("waits for getState() to resolve before auto-ensuring a restored-stopped panel", async () => {
      // The initial-state gate still holds: ensure() must wait for the first
      // getState() so it reconciles to the real status before spawning, never
      // firing on the synchronous mount with the stale "stopped" default.
      const pendingState = createDeferred<DevPreviewSessionState>();
      getStateMock.mockImplementation(() => pendingState.promise);

      renderHook(() =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "npm run dev",
          cwd: "/repo",
        })
      );

      // getState() still pending → nothing has spawned yet.
      await act(async () => {
        await Promise.resolve();
      });
      expect(ensureMock).not.toHaveBeenCalled();

      await act(async () => {
        pendingState.resolve(
          buildState({
            panelId: "panel-1",
            projectId: "project-1",
            status: "restored-stopped",
          })
        );
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(ensureMock).toHaveBeenCalledTimes(1);
      });
    });

    it("does not auto-ensure a restored-stopped panel with no dev command", async () => {
      // Auto-start still requires a runnable command: a restored-stopped panel
      // whose command was cleared must not spawn, it gets stopped instead.
      getStateMock.mockImplementation(async (request: { projectId: string }) =>
        buildState({
          panelId: "panel-1",
          projectId: request.projectId,
          status: "restored-stopped",
        })
      );

      renderHook(() =>
        useDevServer({
          panelId: "panel-1",
          devCommand: "   ",
          cwd: "/repo",
        })
      );

      await waitFor(() => {
        expect(stopMock).toHaveBeenCalledTimes(1);
      });
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });
});
