import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));
const listCommitsMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../store.js", () => ({ store: { get: vi.fn(() => ({})) } }));
vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: { get: vi.fn() },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
}));
vi.mock("../../../utils/git.js", () => ({ listCommits: listCommitsMock }));

import { registerGitReadHandlers } from "../git-read.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { CHANNELS } from "../../channels.js";

function setup() {
  ipcMainMock.handle.mockClear();
  _resetRateLimitQueuesForTest();
  listCommitsMock.mockReset().mockResolvedValue({ items: [], hasMore: false, total: 3 });
  registerGitReadHandlers({ worktreeService: {} } as never);
  const call = ipcMainMock.handle.mock.calls.find(
    (c: unknown[]) => c[0] === CHANNELS.GIT_LIST_COMMITS
  );
  if (!call) throw new Error("git:list-commits handler not registered");
  return call[1] as (_e: unknown, ...args: unknown[]) => unknown;
}

describe("git:list-commits includeTotal forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([true, false, undefined])("forwards includeTotal=%s", async (includeTotal) => {
    const handler = setup();
    await handler({}, { cwd: "/repo", skip: 30, limit: 30, includeTotal });

    expect(listCommitsMock).toHaveBeenCalledWith({
      cwd: "/repo",
      search: undefined,
      branch: undefined,
      skip: 30,
      limit: 30,
      includeTotal,
    });
  });

  it("rejects a non-boolean includeTotal without listing commits", async () => {
    const handler = setup();

    await expect(handler({}, { cwd: "/repo", includeTotal: "false" })).rejects.toThrow(
      /includeTotal/
    );
    expect(listCommitsMock).not.toHaveBeenCalled();
  });
});
