import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});
const broadcastMock = vi.hoisted(() => vi.fn());
const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn<(id: string) => { path: string } | undefined>(() => undefined),
}));
type StatesResult =
  | { status: "ok"; projectId: string; states: Array<{ id: string }> }
  | { status: "unavailable"; reason: string };
const workspaceClientMock = vi.hoisted(() => ({
  getAllStatesForProjectResultAsync: vi.fn<
    (projectPath: string, projectId: string) => Promise<StatesResult>
  >(async () => ({ status: "unavailable", reason: "project-unavailable" })),
}));
const serviceRefsMock = vi.hoisted(() => ({
  getWorkspaceClientRef: vi.fn((): unknown => workspaceClientMock),
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../../utils.js", () => ({ broadcastToProjectRenderers: broadcastMock }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../window/serviceRefs.js", () => serviceRefsMock);

import { CHANNELS } from "../../channels.js";
import { worktreeTitlesNamespace } from "../worktreeTitles.js";
import { setWorktreeCustomTitle } from "../../../services/worktreeCustomTitles.js";
import type { WorktreeTitlesSnapshot } from "../../../../shared/types/ipc/worktreeTitles.js";

const PROJECT_A = "a".repeat(64);
const ROOT_A = "/repos/alpha";
const WT_1 = "/repos/alpha/feature-1";
const WT_2 = "/repos/alpha/feature-2";

type HydrateHandler = (
  context: IpcContext,
  legacyTitles: Record<string, string>
) => Promise<WorktreeTitlesSnapshot | null>;
type SetHandler = (
  context: IpcContext,
  worktreeId: string,
  title: string | null
) => Promise<WorktreeTitlesSnapshot>;
type PruneHandler = (
  context: IpcContext,
  staleWorktreeIds: string[]
) => Promise<WorktreeTitlesSnapshot>;

const hydrate = worktreeTitlesNamespace.ops.hydrate.handler as unknown as HydrateHandler;
const set = worktreeTitlesNamespace.ops.set.handler as unknown as SetHandler;
const prune = worktreeTitlesNamespace.ops.prune.handler as unknown as PruneHandler;

function ctx(
  projectId: string | null,
  client: "local" | "remote" = "local",
  endpoint: "local-view" | "remote-view" = "local-view"
): IpcContext {
  return {
    projectId,
    client: { kind: client },
    endpoint: { kind: endpoint },
  } as unknown as IpcContext;
}

function liveWorktrees(...ids: string[]): void {
  projectStoreMock.getProjectById.mockReturnValue({ path: ROOT_A });
  workspaceClientMock.getAllStatesForProjectResultAsync.mockResolvedValue({
    status: "ok",
    projectId: PROJECT_A,
    states: ids.map((id) => ({ id })),
  });
}

beforeEach(() => {
  storeMock.data.clear();
  vi.clearAllMocks();
  projectStoreMock.getProjectById.mockReturnValue(undefined);
  serviceRefsMock.getWorkspaceClientRef.mockReturnValue(workspaceClientMock);
  workspaceClientMock.getAllStatesForProjectResultAsync.mockResolvedValue({
    status: "unavailable",
    reason: "project-unavailable",
  });
});

describe("worktreeTitles IPC namespace", () => {
  it("answers an unbound sender with null so the view reads again", async () => {
    expect(await hydrate(ctx(null), { [WT_1]: "Legacy" })).toBeNull();
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("takes a local view's legacy titles and tells every view, once", async () => {
    const snapshot = await hydrate(ctx(PROJECT_A), { [WT_1]: "Legacy" });

    expect(snapshot).toEqual({ projectId: PROJECT_A, titles: { [WT_1]: "Legacy" }, revision: 1 });
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.WORKTREE_TITLES_CHANGED,
      snapshot
    );

    broadcastMock.mockClear();
    expect(await hydrate(ctx(PROJECT_A), { [WT_1]: "Stale" })).toEqual(snapshot);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("reads without writing or broadcasting for an empty hand-over", async () => {
    expect(await hydrate(ctx(PROJECT_A), {})).toEqual({
      projectId: PROJECT_A,
      titles: {},
      revision: 0,
    });
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a remote Shell", ctx(PROJECT_A, "remote", "remote-view")],
    ["a remote view of a local client", ctx(PROJECT_A, "local", "remote-view")],
    ["a remote client on a local endpoint", ctx(PROJECT_A, "remote", "local-view")],
  ])("never seeds the host from %s's localStorage", async (_label, context) => {
    expect(await hydrate(context, { [WT_1]: "Shell's" })).toEqual({
      projectId: PROJECT_A,
      titles: {},
      revision: 0,
    });
    expect(storeMock.set).not.toHaveBeenCalled();

    // The host's own view still hands its copy over afterwards.
    expect((await hydrate(ctx(PROJECT_A), { [WT_2]: "Host's" }))?.titles).toEqual({
      [WT_2]: "Host's",
    });
  });

  it("sets for the sender's own project and pushes the result to its views", async () => {
    const snapshot = await set(ctx(PROJECT_A), WT_1, "Release prep");

    expect(snapshot).toEqual({
      projectId: PROJECT_A,
      titles: { [WT_1]: "Release prep" },
      revision: 1,
    });
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.WORKTREE_TITLES_CHANGED,
      snapshot
    );
  });

  it("replies without a push when nothing changed", async () => {
    await set(ctx(PROJECT_A), WT_1, "Release prep");
    broadcastMock.mockClear();

    expect((await set(ctx(PROJECT_A), WT_1, "Release prep")).revision).toBe(1);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("refuses a set from a sender with no project", async () => {
    await expect(set(ctx(null), WT_1, "Release prep")).rejects.toThrow(/no project/);
  });

  it("refuses a title over the limit rather than truncating it", async () => {
    await expect(set(ctx(PROJECT_A), WT_1, "x".repeat(81))).rejects.toThrow(/longer than/);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe("worktreeTitles prune", () => {
  beforeEach(() => {
    setWorktreeCustomTitle(PROJECT_A, WT_1, "One");
    setWorktreeCustomTitle(PROJECT_A, WT_2, "Two");
    broadcastMock.mockClear();
  });

  it("clears only the titles of worktrees the host confirms are gone", async () => {
    liveWorktrees(WT_2);

    const snapshot = await prune(ctx(PROJECT_A), [WT_1, WT_2]);

    expect(workspaceClientMock.getAllStatesForProjectResultAsync).toHaveBeenCalledWith(
      ROOT_A,
      PROJECT_A
    );
    expect(snapshot.titles).toEqual({ [WT_2]: "Two" });
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.WORKTREE_TITLES_CHANGED,
      snapshot
    );
  });

  it("keeps a title another view just set for a worktree this view hasn't listed yet", async () => {
    liveWorktrees(WT_1, WT_2);

    const snapshot = await prune(ctx(PROJECT_A), [WT_2]);

    expect(snapshot.titles).toEqual({ [WT_1]: "One", [WT_2]: "Two" });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("clears nothing when the host can't list the project's worktrees", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ path: ROOT_A });

    expect((await prune(ctx(PROJECT_A), [WT_1])).titles).toEqual({
      [WT_1]: "One",
      [WT_2]: "Two",
    });

    serviceRefsMock.getWorkspaceClientRef.mockReturnValue(null);
    expect((await prune(ctx(PROJECT_A), [WT_1])).titles).toEqual({
      [WT_1]: "One",
      [WT_2]: "Two",
    });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("asks the host nothing when no stale id holds a title", async () => {
    liveWorktrees();

    await prune(ctx(PROJECT_A), ["/never-titled"]);

    expect(workspaceClientMock.getAllStatesForProjectResultAsync).not.toHaveBeenCalled();
  });

  it("refuses a sender with no project and a list that isn't one", async () => {
    await expect(prune(ctx(null), [WT_1])).rejects.toThrow(/no project/);
    await expect(prune(ctx(PROJECT_A), "nope" as unknown as string[])).rejects.toThrow(
      /list of worktree ids/
    );
  });
});
