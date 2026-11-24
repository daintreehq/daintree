// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { DeclaredProjectLink, ProjectLink } from "@shared/types";
import type {
  DevPreviewAllSessionsPayload,
  DevPreviewSessionState,
  DevPreviewSessionStatus,
} from "@shared/types/ipc/devPreview";
import type { GlobalLink } from "@/store/globalLinksStore";
import type { WorktreeSnapshot } from "@shared/types";
import type { WorktreeChangedDirs } from "@/store/createWorktreeStore";

interface WorktreeFixture {
  worktrees: Map<string, { id: string; path: string; worktreeChanges?: { lastUpdated: number } }>;
  workingTreeChangedAtById: Map<string, number>;
  workingTreeChangedDirsById: Map<string, WorktreeChangedDirs>;
}

const h = vi.hoisted(() => ({
  viewProjectId: "p1" as string | null,
  viewProjectPath: "/repo" as string | null,
  getDeclared: vi.fn((_projectId: string) => Promise.resolve([] as DeclaredProjectLink[])),
  polls: [] as Array<{ callback: () => void; intervalMs: number; enabled: boolean }>,
  worktreeState: null as WorktreeFixture | null,
  worktreeListeners: new Set<() => void>(),
  observable: true,
  settings: {
    projectId: "p1" as string | null,
    settings: { links: [] as ProjectLink[] } as { links?: ProjectLink[] } | null,
  },
  globalLinks: [] as GlobalLink[],
  refresh: vi.fn((_projectId: string) => Promise.resolve()),
  revealed: [] as Array<{ callback: () => void; enabled: boolean }>,
  activeWorktreeId: null as string | null,
  worktrees: new Map<string, WorktreeSnapshot>(),
  codeProviderId: "github.github" as string | null,
  resolvedFor: [] as Array<string | null | undefined>,
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) => selector({}),
}));
vi.mock("@/store/viewWorkspace", () => ({
  selectViewProject: () =>
    h.viewProjectId === null ? null : { id: h.viewProjectId, path: h.viewProjectPath },
}));
vi.mock("@/lib/viewCacheState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewCacheState")>()),
  isProjectViewObservable: () => h.observable,
}));
vi.mock("@/clients/projectClient", () => ({
  projectClient: { getDeclaredLinks: (projectId: string) => h.getDeclared(projectId) },
}));
vi.mock("@/hooks/useSharedPollTick", () => ({
  useSharedPollTick: (callback: () => void, intervalMs: number, enabled = true) => {
    h.polls.push({ callback, intervalMs, enabled });
  },
}));
vi.mock("@/hooks/useWorktreeStore", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    h.worktreeListeners.add(listener);
    return () => h.worktreeListeners.delete(listener);
  };
  return {
    useWorktreeStore: (selector: (s: { worktrees: Map<string, WorktreeSnapshot> }) => unknown) =>
      selector({ worktrees: h.worktrees }),
    useWorktreeStoreOptional: <T,>(selector: (s: WorktreeFixture) => T, fallback: T): T =>
      useSyncExternalStore(subscribe, () =>
        h.worktreeState === null ? fallback : selector(h.worktreeState)
      ),
  };
});
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => "ws-1" }));
vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: (selector: (s: typeof h.settings) => unknown) => selector(h.settings),
  refreshCachedProjectLinks: (projectId: string) => h.refresh(projectId),
}));
vi.mock("@/store/globalLinksStore", () => ({
  useGlobalLinksStore: (selector: (s: { links: GlobalLink[] }) => unknown) =>
    selector({ links: h.globalLinks }),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: h.activeWorktreeId }),
}));
vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: (projectId: string | null | undefined) => {
    h.resolvedFor.push(projectId);
    return { providerId: h.codeProviderId };
  },
}));
vi.mock("@/hooks/useProjectViewRevealed", () => ({
  useProjectViewRevealed: (callback: () => void, { enabled }: { enabled: boolean }) => {
    h.revealed.push({ callback, enabled });
  },
}));

const {
  useLinksLauncherDeploymentTarget,
  useLinksLauncherLinks,
  useLinksLauncherPullRequest,
  useLinksLauncherRefresh,
  hasLauncherLinks,
  useHasLiveDevServer,
} = await import("../useLinksLauncher");
const { _resetAllDevSessionsForTests, acquireAllDevSessions, useAllDevSessionsStore } =
  await import("@/store/allDevSessionsStore");
const { useLinksLauncherStore } = await import("@/store/linksLauncherStore");
const { useDeclaredProjectLinksStore, _resetDeclaredProjectLinksForTests } =
  await import("@/store/declaredProjectLinksStore");

const HOMEPAGE: DeclaredProjectLink = {
  source: "package.json",
  title: "Homepage",
  url: "https://widget.example.dev/",
};

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Move the root worktree's watcher on, as a host event landing would. */
function setWorktreeState(next: WorktreeFixture): void {
  h.worktreeState = next;
  for (const listener of h.worktreeListeners) listener();
}

function dirsAt(at: number, previousAt: number | null, dirs: string[]): WorktreeChangedDirs {
  return { at, previousAt, dirs, run: "run-1" };
}

function rootWorktree(
  fsTick: number,
  dirs: WorktreeChangedDirs,
  { gitTick = 1, otherTick = 1 }: { gitTick?: number; otherTick?: number } = {}
): WorktreeFixture {
  return {
    worktrees: new Map([
      ["wt-root", { id: "wt-root", path: "/repo", worktreeChanges: { lastUpdated: gitTick } }],
      ["wt-other", { id: "wt-other", path: "/repo-worktrees/feature" }],
    ]),
    workingTreeChangedAtById: new Map([
      ["wt-root", fsTick],
      ["wt-other", otherTick],
    ]),
    workingTreeChangedDirsById: new Map([
      ["wt-root", dirs],
      ["wt-other", dirsAt(otherTick, null, [""])],
    ]),
  };
}

function globalLink(id: string, enabled: boolean): GlobalLink {
  return { id, title: id, url: `https://${id}.example.com`, icon: "globe", enabled, order: 0 };
}

beforeEach(() => {
  h.viewProjectId = "p1";
  h.viewProjectPath = "/repo";
  h.getDeclared.mockReset();
  h.getDeclared.mockImplementation(() => Promise.resolve([]));
  h.polls.length = 0;
  h.worktreeState = null;
  h.observable = true;
  _resetDeclaredProjectLinksForTests();
  h.settings = { projectId: "p1", settings: { links: [] } };
  h.globalLinks = [];
  h.refresh.mockClear();
  h.revealed.length = 0;
  h.activeWorktreeId = null;
  h.worktrees = new Map();
  h.codeProviderId = "github.github";
  h.resolvedFor.length = 0;
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

  it("lists the view's project's declared links, which alone bring the button up", () => {
    useDeclaredProjectLinksStore.setState({ projectId: "p1", links: [HOMEPAGE] });
    const { result } = renderHook(() => useLinksLauncherLinks());
    expect(result.current.declaredLinks).toEqual([HOMEPAGE]);
    expect(hasLauncherLinks(result.current)).toBe(true);
  });

  it("never shows the links another project declared", () => {
    useDeclaredProjectLinksStore.setState({ projectId: "other", links: [HOMEPAGE] });
    const { result } = renderHook(() => useLinksLauncherLinks());
    expect(result.current.declaredLinks).toEqual([]);
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

describe("useLinksLauncherRefresh: declared links (#17252)", () => {
  it("reads them from mount and on every opening, without waiting for the settings", async () => {
    h.settings = { projectId: "p1", settings: null };
    h.getDeclared.mockImplementation(() => Promise.resolve([HOMEPAGE]));
    renderHook(() => useLinksLauncherRefresh());
    await flush();
    expect(h.getDeclared.mock.calls).toEqual([["p1"]]);
    expect(useDeclaredProjectLinksStore.getState()).toMatchObject({
      projectId: "p1",
      links: [HOMEPAGE],
    });

    act(() => useLinksLauncherStore.getState().open("button"));
    await flush();
    expect(h.getDeclared.mock.calls).toEqual([["p1"], ["p1"]]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("polls slowly while the view has a project, and not without one", async () => {
    const { rerender } = renderHook(() => useLinksLauncherRefresh());
    await flush();
    const poll = h.polls.at(-1)!;
    expect(poll).toMatchObject({ intervalMs: 20_000, enabled: true });

    h.getDeclared.mockClear();
    poll.callback();
    await flush();
    expect(h.getDeclared.mock.calls).toEqual([["p1"]]);

    h.viewProjectId = null;
    rerender();
    expect(h.polls.at(-1)!.enabled).toBe(false);
  });

  it("re-reads when the root worktree's watcher reports the root folder, not another folder", async () => {
    h.worktreeState = rootWorktree(10, dirsAt(10, null, ["src"]));
    renderHook(() => useLinksLauncherRefresh());
    await flush();
    expect(h.getDeclared).toHaveBeenCalledTimes(1);

    act(() => setWorktreeState(rootWorktree(11, dirsAt(11, 10, ["src/lib"]))));
    await flush();
    expect(h.getDeclared).toHaveBeenCalledTimes(1);

    act(() => setWorktreeState(rootWorktree(12, dirsAt(12, 11, ["", "src"]))));
    await flush();
    expect(h.getDeclared).toHaveBeenCalledTimes(2);
  });

  it("ignores a burst in another worktree", async () => {
    h.worktreeState = rootWorktree(10, dirsAt(10, null, ["src"]));
    renderHook(() => useLinksLauncherRefresh());
    await flush();
    act(() => setWorktreeState(rootWorktree(10, dirsAt(10, null, ["src"]), { otherTick: 50 })));
    await flush();
    expect(h.getDeclared).toHaveBeenCalledTimes(1);
  });

  it("re-reads when only the root worktree's git status moved", async () => {
    h.worktreeState = rootWorktree(10, dirsAt(10, null, ["src"]));
    renderHook(() => useLinksLauncherRefresh());
    await flush();
    act(() => setWorktreeState(rootWorktree(10, dirsAt(10, null, ["src"]), { gitTick: 20 })));
    await flush();
    expect(h.getDeclared).toHaveBeenCalledTimes(2);
  });

  it("reads nothing while the view can't be seen, leaving the catch-up to the poll", async () => {
    h.observable = false;
    h.worktreeState = rootWorktree(10, dirsAt(10, null, ["src"]));
    renderHook(() => useLinksLauncherRefresh());
    await flush();
    act(() => setWorktreeState(rootWorktree(11, dirsAt(11, 10, [""]))));
    await flush();
    expect(h.getDeclared).not.toHaveBeenCalled();

    h.observable = true;
    h.polls.at(-1)!.callback();
    await flush();
    expect(h.getDeclared.mock.calls).toEqual([["p1"]]);
  });

  it("leaves the read to the poll when no worktree sits at the project's root", async () => {
    h.viewProjectPath = "/elsewhere";
    h.worktreeState = rootWorktree(10, dirsAt(10, null, [""]));
    renderHook(() => useLinksLauncherRefresh());
    await flush();
    act(() => setWorktreeState(rootWorktree(11, dirsAt(11, 10, [""]))));
    await flush();
    expect(h.getDeclared).toHaveBeenCalledTimes(1);
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
    // Wherever it sits among servers that aren't live, in any project.
    act(() => push!({ sessions: [server("stopped", "other"), server(status)] }));
    expect(result.current).toBe(live);
    act(() =>
      push!({ sessions: [{ ...server(status), projectId: "p2" }, server("stopped", "other")] })
    );
    expect(result.current).toBe(live);
    act(() => push!({ sessions: [] }));
    expect(result.current).toBe(false);
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

function worktree(
  id: string,
  overrides: Partial<WorktreeSnapshot> = {},
  pr: { number?: number; url?: string; title?: string; providerId?: string } | null = {}
): WorktreeSnapshot {
  const providerId = pr?.providerId ?? "github.github";
  const number = pr?.number ?? 42;
  return {
    id,
    path: `/repo/${id}`,
    name: id,
    branch: `feature/${id}`,
    isCurrent: false,
    ...(pr === null
      ? {}
      : {
          linked: {
            providerId,
            pr: {
              ref: { providerId, owner: "acme", repo: "app", number, rawData: null },
              url: pr.url ?? `https://github.com/acme/app/pull/${number}`,
              title: pr.title ?? "Fix login",
              state: "open",
            },
          },
        }),
    ...overrides,
  } as WorktreeSnapshot;
}

describe("useLinksLauncherPullRequest", () => {
  it("is the active worktree's pull request, headed by its branch, under the view project's forge", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1")]]);
    h.activeWorktreeId = "wt-1";
    const { result } = renderHook(() => useLinksLauncherPullRequest());
    expect(result.current).toEqual({
      worktreeId: "wt-1",
      worktreePath: "/repo/wt-1",
      worktreeLabel: "feature/wt-1",
      providerId: "github.github",
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      title: "Fix login",
      state: "open",
    });
    // The view's own project, never the broadcast current one.
    expect(h.resolvedFor.at(-1)).toBe("p1");
  });

  it("switches with the active worktree", () => {
    h.worktrees = new Map([
      ["wt-1", worktree("wt-1")],
      ["wt-2", worktree("wt-2", {}, { number: 43, title: "Add signup" })],
      ["wt-3", worktree("wt-3", {}, null)],
    ]);
    h.activeWorktreeId = "wt-1";
    const { result, rerender } = renderHook(() => useLinksLauncherPullRequest());
    expect(result.current?.number).toBe(42);

    h.activeWorktreeId = "wt-2";
    rerender();
    expect(result.current).toMatchObject({ worktreeId: "wt-2", number: 43, title: "Add signup" });

    h.activeWorktreeId = "wt-3";
    rerender();
    expect(result.current).toBeNull();
  });

  it("keeps its identity through updates that change none of what it shows", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1")]]);
    h.activeWorktreeId = "wt-1";
    const { result, rerender } = renderHook(() => useLinksLauncherPullRequest());
    const first = result.current;
    expect(first?.number).toBe(42);
    h.worktrees = new Map([["wt-1", worktree("wt-1", { modifiedCount: 3 })]]);
    rerender();
    expect(result.current).toBe(first);
  });

  it("shows nothing for a selection this view doesn't hold", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1")]]);
    h.activeWorktreeId = "other-project-wt";
    const { result } = renderHook(() => useLinksLauncherPullRequest());
    expect(result.current).toBeNull();
  });

  it("shows nothing for a pull request no provider is attributed with", () => {
    h.worktrees = new Map([
      [
        "wt-1",
        worktree(
          "wt-1",
          { prNumber: 42, prUrl: "https://github.com/acme/app/pull/42", prState: "open" },
          null
        ),
      ],
    ]);
    h.activeWorktreeId = "wt-1";
    const { result } = renderHook(() => useLinksLauncherPullRequest());
    expect(result.current).toBeNull();
  });

  it("shows nothing once the project has no code forge, or another one", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1")]]);
    h.activeWorktreeId = "wt-1";
    h.codeProviderId = null;
    const { result, rerender } = renderHook(() => useLinksLauncherPullRequest());
    expect(result.current).toBeNull();

    h.codeProviderId = "gitlab.gitlab";
    rerender();
    expect(result.current).toBeNull();

    h.codeProviderId = "github.github";
    rerender();
    expect(result.current?.number).toBe(42);
  });

  it("shows nothing for an address that isn't plain http(s)", () => {
    for (const url of [
      "javascript:alert(1)",
      "https://user:secret@github.com/acme/app/pull/42",
      "file:///etc/passwd",
    ]) {
      h.worktrees = new Map([["wt-1", worktree("wt-1", {}, { url })]]);
      h.activeWorktreeId = "wt-1";
      const { result, unmount } = renderHook(() => useLinksLauncherPullRequest());
      expect(result.current, url).toBeNull();
      unmount();
    }
  });

  it("names a pull request without a title by nothing rather than by blanks", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1", {}, { title: "   " })]]);
    h.activeWorktreeId = "wt-1";
    const { result } = renderHook(() => useLinksLauncherPullRequest());
    expect(result.current?.number).toBe(42);
    expect(result.current?.title).toBeUndefined();
  });

  it("goes by the pull request's own provider, not the record's", () => {
    // An issue another forge detected rebuilds `linked` under its id and
    // carries the old pull request over.
    const carried = worktree("wt-1");
    carried.linked = { ...carried.linked!, providerId: "gitlab.gitlab" };
    h.worktrees = new Map([["wt-1", carried]]);
    h.activeWorktreeId = "wt-1";
    h.codeProviderId = "gitlab.gitlab";
    const { result, rerender } = renderHook(() => useLinksLauncherPullRequest());
    expect(result.current).toBeNull();

    h.codeProviderId = "github.github";
    rerender();
    expect(result.current?.providerId).toBe("github.github");
  });

  it("shows nothing once the worktree has no remote", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1", { hasRemote: false })]]);
    h.activeWorktreeId = "wt-1";
    const { result, rerender } = renderHook(() => useLinksLauncherPullRequest());
    expect(result.current).toBeNull();

    h.worktrees = new Map([["wt-1", worktree("wt-1", { hasRemote: true })]]);
    rerender();
    expect(result.current?.number).toBe(42);
  });
});

describe("useLinksLauncherDeploymentTarget", () => {
  function useTarget() {
    return useLinksLauncherDeploymentTarget(useLinksLauncherPullRequest());
  }

  it("asks by the pull request when the launcher shows one", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1")]]);
    h.activeWorktreeId = "wt-1";
    const { result } = renderHook(() => useTarget());
    expect(result.current).toEqual({
      worktreeId: "wt-1",
      worktreePath: "/repo/wt-1",
      worktreeLabel: "feature/wt-1",
      providerId: "github.github",
      kind: "pullRequest",
      prNumber: 42,
      prUrl: "https://github.com/acme/app/pull/42",
    });
  });

  it("asks by the checked-out branch, the default one included, when there is none", () => {
    h.worktrees = new Map([
      ["wt-1", worktree("wt-1", {}, null)],
      ["main", worktree("main", { branch: "main", isMainWorktree: true }, null)],
    ]);
    h.activeWorktreeId = "wt-1";
    const { result, rerender } = renderHook(() => useTarget());
    expect(result.current).toEqual({
      worktreeId: "wt-1",
      worktreePath: "/repo/wt-1",
      worktreeLabel: "feature/wt-1",
      providerId: "github.github",
      kind: "branch",
      branch: "feature/wt-1",
    });

    h.activeWorktreeId = "main";
    rerender();
    expect(result.current).toMatchObject({ kind: "branch", branch: "main" });
  });

  it("asks by branch under the project's forge when the pull request belongs to another", () => {
    const carried = worktree("wt-1", {}, { providerId: "gitlab.gitlab" });
    h.worktrees = new Map([["wt-1", carried]]);
    h.activeWorktreeId = "wt-1";
    const { result } = renderHook(() => useTarget());
    expect(result.current).toMatchObject({
      providerId: "github.github",
      kind: "branch",
      branch: "feature/wt-1",
    });
  });

  it("has nowhere to ask without a forge, a remote, a branch, or a worktree this view holds", () => {
    h.activeWorktreeId = "wt-1";
    const cases: Array<[string, () => void]> = [
      ["no forge", () => (h.codeProviderId = null)],
      [
        "no remote",
        () => (h.worktrees = new Map([["wt-1", worktree("wt-1", { hasRemote: false })]])),
      ],
      [
        "detached, keeping its old branch",
        () => (h.worktrees = new Map([["wt-1", worktree("wt-1", { isDetached: true }, null)]])),
      ],
      [
        "no branch",
        () => (h.worktrees = new Map([["wt-1", worktree("wt-1", { branch: " " }, null)]])),
      ],
      ["another project's", () => (h.activeWorktreeId = "other-project-wt")],
    ];
    for (const [name, arrange] of cases) {
      h.codeProviderId = "github.github";
      h.activeWorktreeId = "wt-1";
      h.worktrees = new Map([["wt-1", worktree("wt-1", {}, null)]]);
      arrange();
      const { result, unmount } = renderHook(() => useTarget());
      expect(result.current, name).toBeNull();
      unmount();
    }
  });

  it("asks under whichever forge the project resolved to", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1", {}, { providerId: "github.github" })]]);
    h.activeWorktreeId = "wt-1";
    h.codeProviderId = "gitlab.gitlab";
    const { result } = renderHook(() => useTarget());
    expect(result.current).toMatchObject({ providerId: "gitlab.gitlab", kind: "branch" });
  });

  it("passes the branch on exactly as git names it", () => {
    // A no-break space is a legal start to a branch name, and trimming it
    // would ask about another branch.
    const branch = `${String.fromCharCode(0xa0)}main`;
    h.worktrees = new Map([["wt-1", worktree("wt-1", { branch }, null)]]);
    h.activeWorktreeId = "wt-1";
    const { result } = renderHook(() => useTarget());
    expect(result.current).toMatchObject({ kind: "branch", branch });
  });

  it("asks while the host has yet to read the remotes", () => {
    h.worktrees = new Map([["wt-1", worktree("wt-1", { hasRemote: undefined }, null)]]);
    h.activeWorktreeId = "wt-1";
    const { result } = renderHook(() => useTarget());
    expect(result.current?.kind).toBe("branch");
  });
});
