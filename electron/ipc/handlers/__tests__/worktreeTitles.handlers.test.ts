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

vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../../utils.js", () => ({ broadcastToProjectRenderers: broadcastMock }));

import { CHANNELS } from "../../channels.js";
import { worktreeTitlesNamespace } from "../worktreeTitles.js";
import { setWorktreeCustomTitle } from "../../../services/worktreeCustomTitles.js";
import type { WorktreeTitlesSnapshot } from "../../../../shared/types/ipc/worktreeTitles.js";

const PROJECT_A = "a".repeat(64);
const WT_1 = "/repos/alpha/feature-1";

type HydrateHandler = (
  context: IpcContext,
  legacyTitles: Record<string, string>
) => Promise<WorktreeTitlesSnapshot | null>;
type SetHandler = (
  context: IpcContext,
  worktreeId: string,
  title: string | null
) => Promise<WorktreeTitlesSnapshot>;

const hydrate = worktreeTitlesNamespace.ops.hydrate.handler as unknown as HydrateHandler;
const set = worktreeTitlesNamespace.ops.set.handler as unknown as SetHandler;

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

beforeEach(() => {
  storeMock.data.clear();
  vi.clearAllMocks();
});

describe("worktreeTitles IPC namespace", () => {
  it("answers an unbound sender with null so the view reads again", async () => {
    expect(await hydrate(ctx(null), { [WT_1]: "Legacy" })).toBeNull();
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("hands a local view's legacy titles to main once and tells every view", async () => {
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

  it("broadcasts nothing for an empty hand-over", async () => {
    expect(await hydrate(ctx(PROJECT_A), {})).toEqual({
      projectId: PROJECT_A,
      titles: {},
      revision: 1,
    });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a remote Shell", ctx(PROJECT_A, "remote", "remote-view")],
    ["a remote view of a local client", ctx(PROJECT_A, "local", "remote-view")],
    ["a remote client on a local endpoint", ctx(PROJECT_A, "remote", "local-view")],
  ])("never seeds the host from %s's localStorage", async (_label, context) => {
    setWorktreeCustomTitle(PROJECT_A, WT_1, "Host's");
    storeMock.set.mockClear();

    expect(await hydrate(context, { [WT_1]: "Shell's", "/other": "Shell's too" })).toEqual({
      projectId: PROJECT_A,
      titles: { [WT_1]: "Host's" },
      revision: 1,
    });
    expect(storeMock.set).not.toHaveBeenCalled();
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
