import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const compareWorktreesMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../store.js", () => ({ store: { get: vi.fn(() => ({})) } }));
vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: {
    get: vi.fn(),
    getGitService: vi.fn(() => ({ compareWorktrees: compareWorktreesMock })),
  },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
}));

import { registerGitReadHandlers } from "../git-read.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { CHANNELS } from "../../channels.js";

function setup() {
  ipcMainMock.handle.mockClear();
  _resetRateLimitQueuesForTest();
  compareWorktreesMock.mockReset().mockResolvedValue("diff");
  registerGitReadHandlers({} as never);
  const call = ipcMainMock.handle.mock.calls.find(
    (c: unknown[]) => c[0] === CHANNELS.GIT_COMPARE_WORKTREES
  );
  if (!call) throw new Error("compare handler not registered");
  return call[1] as (_e: unknown, ...args: unknown[]) => unknown;
}

const base = { cwd: "/repo", branch1: "main", branch2: "feature" };

describe("git:compare-worktrees oldPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards a rename's source path byte-exact with the other options", async () => {
    const handler = setup();
    await handler(
      {},
      { ...base, filePath: "src/new.ts", oldPath: " old\tname.ts ", contextLines: 10 }
    );

    expect(compareWorktreesMock).toHaveBeenCalledWith(
      "main",
      "feature",
      "src/new.ts",
      undefined,
      undefined,
      10,
      " old\tname.ts "
    );
  });

  it("keeps a destination-only detail request working", async () => {
    const handler = setup();
    await handler({}, { ...base, filePath: "src/app.ts", ignoreWhitespace: true });

    expect(compareWorktreesMock).toHaveBeenCalledWith(
      "main",
      "feature",
      "src/app.ts",
      undefined,
      true,
      undefined,
      undefined
    );
  });

  it.each([
    ["an empty source", { filePath: "src/new.ts", oldPath: "" }],
    ["a non-string source", { filePath: "src/new.ts", oldPath: 7 }],
    ["a source without a destination", { oldPath: "src/old.ts" }],
  ])("rejects %s without reaching git", async (_label, extra) => {
    const handler = setup();

    await expect(handler({}, { ...base, ...extra })).rejects.toThrow("Invalid oldPath");
    expect(compareWorktreesMock).not.toHaveBeenCalled();
  });
});
