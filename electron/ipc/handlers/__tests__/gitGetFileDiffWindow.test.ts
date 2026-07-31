import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../store.js", () => ({ store: { get: vi.fn(() => ({})) } }));
vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: { get: vi.fn() },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
}));

import { registerGitReadHandlers } from "../git-read.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { CHANNELS } from "../../channels.js";
import { GIT_FILE_DIFF_MAX_BYTES } from "../../../../shared/config/gitReadLimits.js";

const getFileDiffMock = vi.fn();

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => unknown;
}

function setup() {
  ipcMainMock.handle.mockClear();
  _resetRateLimitQueuesForTest();
  getFileDiffMock.mockReset().mockResolvedValue({
    content: "diff",
    offset: 0,
    totalBytes: 4,
    truncated: false,
    nextOffset: null,
  });
  registerGitReadHandlers({
    worktreeService: { getFileDiff: getFileDiffMock },
  } as never);
  return getHandler(CHANNELS.GIT_GET_FILE_DIFF);
}

const base = { cwd: "/repo", filePath: "a.ts", status: "modified" };

/**
 * The renderer argsSchema is one caller among several — a direct IPC client
 * bypasses it entirely — so the window bounds are re-enforced here (#11531).
 */
describe("git:get-file-diff window validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards a valid window to the workspace service", async () => {
    const handler = setup();
    await handler({}, { ...base, ignoreWhitespace: true, offset: 2048, maxBytes: 4096 });

    expect(getFileDiffMock).toHaveBeenCalledWith("/repo", "a.ts", "modified", true, 2048, 4096);
  });

  it("forwards undefined bounds untouched so the service picks its own default", async () => {
    const handler = setup();
    await handler({}, base);

    expect(getFileDiffMock).toHaveBeenCalledWith(
      "/repo",
      "a.ts",
      "modified",
      undefined,
      undefined,
      undefined
    );
  });

  it("accepts the exact ceiling and a zero offset", async () => {
    const handler = setup();
    await handler({}, { ...base, offset: 0, maxBytes: GIT_FILE_DIFF_MAX_BYTES });

    expect(getFileDiffMock).toHaveBeenCalledWith(
      "/repo",
      "a.ts",
      "modified",
      undefined,
      0,
      GIT_FILE_DIFF_MAX_BYTES
    );
  });

  it.each([
    ["negative offset", { offset: -1 }],
    ["fractional offset", { offset: 1.5 }],
    ["NaN offset", { offset: Number.NaN }],
    ["zero maxBytes", { maxBytes: 0 }],
    ["fractional maxBytes", { maxBytes: 10.5 }],
    ["over-ceiling maxBytes", { maxBytes: GIT_FILE_DIFF_MAX_BYTES + 1 }],
    ["infinite maxBytes", { maxBytes: Number.POSITIVE_INFINITY }],
  ])("rejects %s without reaching the workspace service", async (_label, bad) => {
    const handler = setup();

    await expect(handler({}, { ...base, ...bad })).rejects.toThrow(/Invalid (offset|maxBytes)/);
    expect(getFileDiffMock).not.toHaveBeenCalled();
  });
});
