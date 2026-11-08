// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectOnlineOnlyFiles } from "@shared/types/onlineOnlyFiles";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

const dispatch = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

const viewWorkspaceId = vi.hoisted(() => ({ current: "p1" as string | null }));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => viewWorkspaceId.current }));

import { useOnlineOnlyFilesSync } from "../useOnlineOnlyFilesSync";
import { useOnlineOnlyFilesStore } from "@/store/onlineOnlyFilesStore";
import { useProjectStore } from "@/store/projectStore";
import { notifyHostResync } from "@/store/hostResyncSignal";

const zero = { files: 0, directories: 0, complete: true };

const snapshot = (overrides: Partial<ProjectOnlineOnlyFiles> = {}): ProjectOnlineOnlyFiles => ({
  projectId: "p1",
  service: "Dropbox",
  revision: 1,
  git: zero,
  workingTree: zero,
  ...overrides,
});

const outstanding = (revision: number, files = 3) =>
  snapshot({ revision, git: { ...zero, files } });

function installApi(answer: ProjectOnlineOnlyFiles | null = snapshot()) {
  const listeners = new Set<(files: ProjectOnlineOnlyFiles) => void>();
  const api = {
    watch: vi.fn(async () => answer),
    unwatch: vi.fn(async () => undefined),
    onChanged: vi.fn((listener: (files: ProjectOnlineOnlyFiles) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    push: (files: ProjectOnlineOnlyFiles) => act(() => listeners.forEach((fn) => fn(files))),
    listeners,
  };
  (window as unknown as { electron: unknown }).electron = { onlineOnlyFiles: api };
  return api;
}

const store = () => useOnlineOnlyFilesStore.getState();

describe("useOnlineOnlyFilesSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viewWorkspaceId.current = "p1";
    store().reset();
    useProjectStore.setState({
      projects: [
        { id: "p1", path: "/cloud/p1" },
        { id: "p2", path: "/cloud/p2" },
      ] as never,
      currentProject: null,
    });
  });

  it("subscribes before it asks, so no push can slip between them", async () => {
    const api = installApi();
    renderHook(() => useOnlineOnlyFilesSync());

    expect(api.onChanged.mock.invocationCallOrder[0]).toBeLessThan(
      api.watch.mock.invocationCallOrder[0]!
    );
    await waitFor(() => expect(store().phase).toBe("answered"));
  });

  it("is unsettled from the very first effect, ahead of the answer", () => {
    installApi();
    renderHook(() => useOnlineOnlyFilesSync());
    expect(store().phase).toBe("asking");
  });

  it("follows the counts as they change, down to zero", async () => {
    const api = installApi(outstanding(1, 10));
    renderHook(() => useOnlineOnlyFilesSync());
    await waitFor(() => expect(store().files?.git?.files).toBe(10));

    api.push(outstanding(2, 4));
    expect(store().files?.git?.files).toBe(4);
    api.push(snapshot({ revision: 3 }));
    expect(store().files?.git?.files).toBe(0);
  });

  it("ignores a push for a project this view doesn't show", async () => {
    const api = installApi(snapshot());
    renderHook(() => useOnlineOnlyFilesSync());
    await waitFor(() => expect(store().phase).toBe("answered"));

    api.push({ ...outstanding(9), projectId: "other" });
    expect(store().files?.git?.files).toBe(0);
  });

  it("treats a failed watch as not applying, so the project looks like today", async () => {
    const api = installApi();
    api.watch.mockRejectedValueOnce(new Error("no"));
    renderHook(() => useOnlineOnlyFilesSync());

    await waitFor(() => expect(store().phase).toBe("answered"));
    expect(store().files).toBeNull();
  });

  it("watches again after a resync, since a dropped link took the hold with it", async () => {
    const api = installApi(snapshot({ revision: 40 }));
    renderHook(() => useOnlineOnlyFilesSync());
    await waitFor(() => expect(store().revision).toBe(40));

    api.watch.mockResolvedValueOnce(outstanding(2));
    await act(async () => notifyHostResync());

    expect(api.watch).toHaveBeenCalledTimes(2);
    expect(store().files?.git?.files).toBe(3);
  });

  it("lets go on unmount and drops a late answer", async () => {
    const api = installApi();
    let answer!: (files: ProjectOnlineOnlyFiles | null) => void;
    api.watch.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { unmount } = renderHook(() => useOnlineOnlyFilesSync());

    unmount();
    await act(async () => answer(outstanding(5)));

    expect(api.unwatch).toHaveBeenCalledTimes(1);
    expect(api.listeners.size).toBe(0);
    expect(store().files).toBeNull();
    expect(store().phase).toBe("idle");
  });

  it("does nothing for a closed project", async () => {
    const api = installApi();
    useProjectStore.setState({
      projects: [{ id: "p1", path: "/cloud/p1", status: "closed" }] as never,
    });
    renderHook(() => useOnlineOnlyFilesSync());

    expect(api.watch).not.toHaveBeenCalled();
    expect(store().phase).toBe("idle");
  });

  it("does nothing for an unbound window with no project", async () => {
    viewWorkspaceId.current = null;
    const api = installApi();
    renderHook(() => useOnlineOnlyFilesSync());

    expect(api.watch).not.toHaveBeenCalled();
    expect(store().phase).toBe("idle");
  });

  it("asks before the project list has loaded, so the path warning can't get in first", async () => {
    useProjectStore.setState({ projects: [] as never });
    const api = installApi();
    renderHook(() => useOnlineOnlyFilesSync());

    expect(api.watch).toHaveBeenCalledTimes(1);
    expect(store().phase).toBe("asking");
    await waitFor(() => expect(store().phase).toBe("answered"));

    act(() => useProjectStore.setState({ projects: [{ id: "p1", path: "/cloud/p1" }] as never }));
    expect(api.watch).toHaveBeenCalledTimes(1);
  });

  it("lets go when its project closes", async () => {
    const api = installApi();
    renderHook(() => useOnlineOnlyFilesSync());
    await waitFor(() => expect(store().phase).toBe("answered"));

    act(() =>
      useProjectStore.setState({
        projects: [{ id: "p1", path: "/cloud/p1", status: "closed" }] as never,
      })
    );

    expect(api.unwatch).toHaveBeenCalledTimes(1);
    expect(store().phase).toBe("idle");
  });

  it("isn't moved off its own project when another window's switch repoints currentProject", async () => {
    const api = installApi();
    renderHook(() => useOnlineOnlyFilesSync());
    await waitFor(() => expect(store().phase).toBe("answered"));

    act(() => useProjectStore.setState({ currentProject: { id: "p2", path: "/x" } as never }));

    expect(api.watch).toHaveBeenCalledTimes(1);
    expect(api.unwatch).not.toHaveBeenCalled();
  });

  it("ends a Strict Mode double-mount still watching, with the one subscription", async () => {
    const api = installApi();
    renderHook(() => useOnlineOnlyFilesSync(), { wrapper: StrictMode });
    await waitFor(() => expect(store().phase).toBe("answered"));

    expect(api.listeners.size).toBe(1);
    expect(api.watch.mock.calls.length).toBe(api.unwatch.mock.calls.length + 1);
  });

  describe("inbox", () => {
    it("records one entry per stretch of outstanding files, keyed to the project", async () => {
      const api = installApi(outstanding(1));
      renderHook(() => useOnlineOnlyFilesSync());
      await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(notify.mock.calls[0]?.[0]).toMatchObject({
        priority: "low",
        countable: false,
        supersedeKey: "online-only-files:p1",
      });

      api.push(outstanding(2, 1));
      expect(notify).toHaveBeenCalledTimes(1);

      api.push(snapshot({ revision: 3 }));
      api.push(outstanding(4, 8));
      expect(notify).toHaveBeenCalledTimes(2);
    });

    it("records nothing for a project with everything downloaded", async () => {
      installApi(snapshot());
      renderHook(() => useOnlineOnlyFilesSync());
      await waitFor(() => expect(store().phase).toBe("answered"));
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("a load that failed on placeholders", () => {
    it("tries the load again once .git has downloaded, with no user action", async () => {
      const api = installApi(outstanding(1));
      renderHook(() => useOnlineOnlyFilesSync());
      await waitFor(() => expect(store().files?.git?.files).toBe(3));
      expect(dispatch).not.toHaveBeenCalled();

      api.push(outstanding(2, 1));
      expect(dispatch).not.toHaveBeenCalled();

      api.push(snapshot({ revision: 3 }));
      expect(dispatch).toHaveBeenCalledWith("worktree.retryProjectLoad");
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it("doesn't retry for a project that was never waiting", async () => {
      const api = installApi(snapshot());
      renderHook(() => useOnlineOnlyFilesSync());
      await waitFor(() => expect(store().phase).toBe("answered"));

      api.push(snapshot({ revision: 2, workingTree: { ...zero, files: 2 } }));
      api.push(snapshot({ revision: 3 }));
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("doesn't retry when the project closes mid-wait", async () => {
      installApi(outstanding(1));
      renderHook(() => useOnlineOnlyFilesSync());
      await waitFor(() => expect(store().files?.git?.files).toBe(3));

      act(() =>
        useProjectStore.setState({
          projects: [{ id: "p1", path: "/cloud/p1", status: "closed" }] as never,
        })
      );

      expect(store().files).toBeNull();
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
