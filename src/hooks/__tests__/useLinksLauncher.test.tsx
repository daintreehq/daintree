// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ProjectLink } from "@shared/types";
import type {
  DevPreviewAllSessionsPayload,
  DevPreviewSessionState,
  DevPreviewSessionStatus,
} from "@shared/types/ipc/devPreview";
import type { GlobalLink } from "@/store/globalLinksStore";

const h = vi.hoisted(() => ({
  viewProjectId: "p1" as string | null,
  settings: {
    projectId: "p1" as string | null,
    settings: { links: [] as ProjectLink[] } as { links?: ProjectLink[] } | null,
  },
  globalLinks: [] as GlobalLink[],
  refresh: vi.fn((_projectId: string) => Promise.resolve()),
  revealed: [] as Array<{ callback: () => void; enabled: boolean }>,
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) => selector({}),
}));
vi.mock("@/store/viewWorkspace", () => ({
  selectViewProject: () => (h.viewProjectId === null ? null : { id: h.viewProjectId }),
}));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => "ws-1" }));
vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: (selector: (s: typeof h.settings) => unknown) => selector(h.settings),
  refreshCachedProjectLinks: (projectId: string) => h.refresh(projectId),
}));
vi.mock("@/store/globalLinksStore", () => ({
  useGlobalLinksStore: (selector: (s: { links: GlobalLink[] }) => unknown) =>
    selector({ links: h.globalLinks }),
}));
vi.mock("@/hooks/useProjectViewRevealed", () => ({
  useProjectViewRevealed: (callback: () => void, { enabled }: { enabled: boolean }) => {
    h.revealed.push({ callback, enabled });
  },
}));

const { useLinksLauncherLinks, useLinksLauncherRefresh, hasLauncherLinks, useHasLiveDevServer } =
  await import("../useLinksLauncher");
const { _resetAllDevSessionsForTests, acquireAllDevSessions, useAllDevSessionsStore } =
  await import("@/store/allDevSessionsStore");
const { useLinksLauncherStore } = await import("@/store/linksLauncherStore");

function globalLink(id: string, enabled: boolean): GlobalLink {
  return { id, title: id, url: `https://${id}.example.com`, icon: "globe", enabled, order: 0 };
}

beforeEach(() => {
  h.viewProjectId = "p1";
  h.settings = { projectId: "p1", settings: { links: [] } };
  h.globalLinks = [];
  h.refresh.mockClear();
  h.revealed.length = 0;
  useLinksLauncherStore.setState({ opening: null, refreshSeq: 0, closeFocus: null });
});

describe("useLinksLauncherLinks", () => {
  it("lists the view's project links and only the switched-on global links", () => {
    const link: ProjectLink = { id: "a", title: "Staging", url: "https://s.example.com" };
    h.settings = { projectId: "p1", settings: { links: [link] } };
    h.globalLinks = [globalLink("on", true), globalLink("off", false)];
    const { result } = renderHook(() => useLinksLauncherLinks());
    expect(result.current.projectLinks).toEqual([link]);
    expect(result.current.globalLinks.map((l) => l.id)).toEqual(["on"]);
    expect(hasLauncherLinks(result.current)).toBe(true);
  });

  it("never shows another project's cached links", () => {
    h.settings = {
      projectId: "other",
      settings: { links: [{ id: "x", title: "X", url: "https://x.example.com" }] },
    };
    const { result } = renderHook(() => useLinksLauncherLinks());
    expect(result.current.projectLinks).toEqual([]);
    expect(hasLauncherLinks(result.current)).toBe(false);
  });
});

describe("useLinksLauncherRefresh", () => {
  it("reads main's list once the project's settings are cached, and on each opening", () => {
    renderHook(() => useLinksLauncherRefresh());
    expect(h.refresh.mock.calls).toEqual([["p1"]]);

    act(() => useLinksLauncherStore.getState().open("button"));
    expect(h.refresh.mock.calls).toEqual([["p1"], ["p1"]]);

    act(() => useLinksLauncherStore.getState().requestRefresh());
    expect(h.refresh).toHaveBeenCalledTimes(3);
  });

  it("re-reads when the view comes back", () => {
    renderHook(() => useLinksLauncherRefresh());
    const last = h.revealed.at(-1)!;
    expect(last.enabled).toBe(true);
    h.refresh.mockClear();
    last.callback();
    expect(h.refresh).toHaveBeenCalledWith("p1");
  });

  it("does nothing until this project's settings are in the cache", () => {
    h.settings = { projectId: "p1", settings: null };
    renderHook(() => useLinksLauncherRefresh());
    act(() => useLinksLauncherStore.getState().open("detached"));
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.revealed.at(-1)!.enabled).toBe(false);
  });
});

describe("useHasLiveDevServer", () => {
  let push: ((payload: DevPreviewAllSessionsPayload) => void) | null;
  let resolveFirstLoad: (sessions: DevPreviewSessionState[]) => void;
  const getAllSessions = vi.fn(
    () =>
      new Promise<DevPreviewSessionState[]>((resolve) => {
        resolveFirstLoad = resolve;
      })
  );
  const unsubscribe = vi.fn();

  function server(status: DevPreviewSessionStatus, panelId = "panel-1"): DevPreviewSessionState {
    return {
      panelId,
      projectId: "p1",
      worktreeId: "wt-1",
      status,
      url: null,
      predictedUrl: null,
      error: null,
      terminalId: null,
      isRestarting: false,
      generation: 1,
      updatedAt: 1,
    };
  }

  beforeEach(() => {
    _resetAllDevSessionsForTests();
    push = null;
    getAllSessions.mockClear();
    unsubscribe.mockClear();
    Reflect.set(window, "electron", {
      devPreview: {
        getAllSessions,
        onAllSessionsChanged: (callback: (payload: DevPreviewAllSessionsPayload) => void) => {
          push = callback;
          return unsubscribe;
        },
      },
    });
  });

  it("reads every dev server from mount, before anything opens the launcher", async () => {
    const { result } = renderHook(() => useHasLiveDevServer());
    expect(getAllSessions).toHaveBeenCalledOnce();
    expect(result.current).toBe(false);

    await act(async () => resolveFirstLoad([server("running")]));
    expect(result.current).toBe(true);
  });

  it.each([
    ["starting", true],
    ["installing", true],
    ["running", true],
    ["stopping", true],
    ["error", true],
    ["restored-stopped", false],
    ["stopped", false],
  ] as const)("counts a %s server as live: %s", (status, live) => {
    const { result } = renderHook(() => useHasLiveDevServer());
    act(() => push!({ sessions: [server("stopped", "other"), server(status)] }));
    expect(result.current).toBe(live);
  });

  it("keeps the list when the launcher's own read of it comes and goes", () => {
    const { result } = renderHook(() => useHasLiveDevServer());
    act(() => push!({ sessions: [server("running")] }));

    const release = acquireAllDevSessions();
    release();

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(useAllDevSessionsStore.getState().sessions).toHaveLength(1);
    expect(result.current).toBe(true);
  });

  it("lets go of the subscription when the toolbar goes", () => {
    const { unmount } = renderHook(() => useHasLiveDevServer());
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
