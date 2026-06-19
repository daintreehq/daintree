// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

const notifyMock = vi.fn<(payload: unknown) => string>(() => "notif-id");
vi.mock("@/lib/notify", () => ({
  notify: (payload: unknown) => notifyMock(payload),
}));

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

type PortEventName = "fetch-auth-failure-confirmed" | "watcher-recovered";

const listeners = new Map<PortEventName, Set<(data: unknown) => void>>();

function emit(name: PortEventName, data: unknown): void {
  const set = listeners.get(name);
  if (!set) return;
  for (const cb of set) cb(data);
}

function setCurrentProject(path: string | null): void {
  const project = path ? ({ id: "p1", name: "p1", path } as unknown as Project) : null;
  useProjectStore.setState({ currentProject: project });
}

beforeEach(() => {
  listeners.clear();
  notifyMock.mockClear();
  dispatchMock.mockClear();
  setCurrentProject("/repo/proj");

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: (_name: string) =>
        Promise.resolve({
          states: [] as WorktreeSnapshot[],
          watcherDegraded: false,
          topologyWatcherDark: false,
        }),
      onEvent: (name: PortEventName, cb: (data: unknown) => void) => {
        let set = listeners.get(name);
        if (!set) {
          set = new Set();
          listeners.set(name, set);
        }
        set.add(cb);
        return () => set?.delete(cb);
      },
      onReady: (_cb: () => void) => () => {},
      onDisconnected: (_cb: () => void) => () => {},
      onFatalDisconnect: (_cb: () => void) => () => {},
    },
    worktree: {
      getAllIssueAssociations: () => Promise.resolve({}),
      getPRStatus: () => Promise.resolve(null),
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  listeners.clear();
  setCurrentProject(null);
  vi.restoreAllMocks();
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const view = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!view.result.current) throw new Error("WorktreeStoreContext is null");
  return view;
}

describe("WorktreeStoreProvider — confirmed forge-auth escalation", () => {
  it("raises a single error toast with a recovery action on fetch-auth-failure-confirmed", async () => {
    await renderProvider();
    expect(notifyMock).not.toHaveBeenCalled();

    act(() => {
      emit("fetch-auth-failure-confirmed", {
        type: "fetch-auth-failure-confirmed",
        reason: "auth-failed",
      });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0] as {
      type?: string;
      priority?: string;
      title?: string;
      action?: { label?: string };
      supersedeKey?: string;
    };
    expect(payload.type).toBe("error");
    // An error toast must never be low-priority (silently dropped — lint-banned).
    expect(payload.priority).not.toBe("low");
    expect(payload.title).toBeTruthy();
    expect(payload.action?.label).toBeTruthy();
    expect(payload.supersedeKey).toBeTruthy();
  });

  it("dispatches the forge settings action when the recovery button fires", async () => {
    await renderProvider();

    act(() => {
      emit("fetch-auth-failure-confirmed", {
        type: "fetch-auth-failure-confirmed",
        reason: "auth-failed",
      });
    });

    const payload = notifyMock.mock.calls[0]![0] as { action?: { onClick?: () => void } };
    act(() => {
      payload.action?.onClick?.();
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      expect.objectContaining({ tab: "code-forge" }),
      expect.objectContaining({ source: "user" })
    );
  });

  it("stops notifying after the provider unmounts", async () => {
    const view = await renderProvider();
    view.unmount();

    act(() => {
      emit("fetch-auth-failure-confirmed", {
        type: "fetch-auth-failure-confirmed",
        reason: "auth-failed",
      });
    });

    expect(notifyMock).not.toHaveBeenCalled();
  });
});
