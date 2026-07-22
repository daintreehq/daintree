import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const readFileAtHeadMock = vi.hoisted(() => vi.fn());
const readPreviousFileVersionMock = vi.hoisted(() => vi.fn());
const getGitServiceMock = vi.hoisted(() => vi.fn());

const fileHandleMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  close: vi.fn(async () => {}),
}));

const fsMock = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100 },
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));
vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: { getGitService: getGitServiceMock },
}));

import { registerDiffMediaHandlers } from "../diffMedia.js";
import { DIFF_MEDIA_METHOD_CHANNELS } from "../diffMedia.preload.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import type { DiffMediaFileVersions } from "../../../../shared/types/ipc/diffMedia.js";

type Handler = (
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<DiffMediaFileVersions>;

function getHandler(): Handler {
  const fn = ipcHandlers.get(DIFF_MEDIA_METHOD_CHANNELS.readFileVersions);
  if (!fn) throw new Error("handler not registered");
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

function invoke(payload: { cwd: string; filePath: string }): Promise<DiffMediaFileVersions> {
  return getHandler()(fakeEvent(), payload);
}

const WORKING_BUFFER = Buffer.from("working-image-bytes");
const HEAD_BUFFER = Buffer.from("head-image-bytes");
const ROOT = path.parse(process.cwd()).root;
const REPO_ROOT = path.join(ROOT, "repo");
const OUTSIDE_FILE = path.join(ROOT, "elsewhere", "img.png");

describe("diffMedia readFileVersions", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();

    getGitServiceMock.mockReturnValue({
      readFileAtHead: readFileAtHeadMock,
      readPreviousFileVersion: readPreviousFileVersionMock,
    });
    readFileAtHeadMock.mockResolvedValue({ ok: true, content: HEAD_BUFFER });
    readPreviousFileVersionMock.mockResolvedValue({ ok: false, reason: "NOT_FOUND" });

    fsMock.realpath.mockImplementation(async (p: string) => p);
    fsMock.stat.mockResolvedValue({ size: WORKING_BUFFER.byteLength, isFile: () => true });
    fsMock.open.mockResolvedValue(fileHandleMock);
    fileHandleMock.readFile.mockResolvedValue(WORKING_BUFFER);
    fileHandleMock.stat.mockResolvedValue({
      size: WORKING_BUFFER.byteLength,
      isFile: () => true,
    });
    fileHandleMock.close.mockResolvedValue(undefined);

    cleanup = registerDiffMediaHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("rejects absolute filePath without touching git or the filesystem", async () => {
    await expect(
      invoke({ cwd: REPO_ROOT, filePath: path.join(ROOT, "etc", "passwd.png") })
    ).rejects.toThrow(/relative/);
    expect(getGitServiceMock).not.toHaveBeenCalled();
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("rejects .. traversal segments", async () => {
    await expect(invoke({ cwd: REPO_ROOT, filePath: "../outside.png" })).rejects.toThrow(
      /traversal/i
    );
    expect(getGitServiceMock).not.toHaveBeenCalled();
  });

  it("rejects traversal that only appears after normalization", async () => {
    await expect(invoke({ cwd: REPO_ROOT, filePath: "assets/../../outside.png" })).rejects.toThrow(
      /traversal/i
    );
  });

  it("rejects null bytes in filePath", async () => {
    // Caught at the zod boundary (opValidated), whose ValidationError message
    // is deliberately sanitized — no schema details reach the renderer.
    await expect(invoke({ cwd: REPO_ROOT, filePath: "img\0.png" })).rejects.toThrow(
      /validation failed/i
    );
  });

  it("rejects a relative cwd", async () => {
    await expect(invoke({ cwd: "repo", filePath: "img.png" })).rejects.toThrow(/absolute/i);
  });

  it("returns UNSUPPORTED for both sides on a non-image extension without I/O", async () => {
    const result = await invoke({ cwd: REPO_ROOT, filePath: "notes.txt" });
    expect(result.head).toEqual({ ok: false, error: "UNSUPPORTED" });
    expect(result.working).toEqual({ ok: false, error: "UNSUPPORTED" });
    expect(getGitServiceMock).not.toHaveBeenCalled();
    expect(fsMock.realpath).not.toHaveBeenCalled();
  });

  it("maps a file missing at HEAD to NOT_FOUND while the working side loads", async () => {
    readFileAtHeadMock.mockResolvedValue({ ok: false, reason: "NOT_FOUND" });

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.head).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(result.working).toEqual({
      ok: true,
      dataUrl: `data:image/png;base64,${WORKING_BUFFER.toString("base64")}`,
      byteSize: WORKING_BUFFER.byteLength,
    });
    // A present working copy means untracked/re-added, not a committed
    // deletion — no history walk.
    expect(readPreviousFileVersionMock).not.toHaveBeenCalled();
  });

  // Committed deletion: nothing at literal HEAD and nothing on disk.
  function mockCommittedDeletion(): void {
    readFileAtHeadMock.mockResolvedValue({ ok: false, reason: "NOT_FOUND" });
    fsMock.realpath.mockImplementation(async (p: string) => {
      if (p === REPO_ROOT) return REPO_ROOT;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  }

  it("falls back to the prior committed version for a committed deletion", async () => {
    const previousBuffer = Buffer.from("previous-image-bytes");
    mockCommittedDeletion();
    readPreviousFileVersionMock.mockResolvedValue({ ok: true, content: previousBuffer });

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.head).toEqual({
      ok: true,
      dataUrl: `data:image/png;base64,${previousBuffer.toString("base64")}`,
      byteSize: previousBuffer.byteLength,
    });
    expect(result.working).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("does not consult history when HEAD has the file", async () => {
    await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(readPreviousFileVersionMock).not.toHaveBeenCalled();
  });

  it("does not consult history for a TOO_LARGE HEAD blob", async () => {
    readFileAtHeadMock.mockResolvedValue({ ok: false, reason: "TOO_LARGE" });

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.head).toEqual({ ok: false, error: "TOO_LARGE" });
    expect(readPreviousFileVersionMock).not.toHaveBeenCalled();
  });

  it("maps a fallback failure to a HEAD-side ERROR instead of rejecting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCommittedDeletion();
    readPreviousFileVersionMock.mockRejectedValue(new Error("git exploded"));

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.head).toEqual({ ok: false, error: "ERROR" });
    expect(result.working).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("maps a missing working-tree file to NOT_FOUND", async () => {
    fsMock.realpath.mockImplementation(async (p: string) => {
      if (p === REPO_ROOT) return REPO_ROOT;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.working).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(result.head.ok).toBe(true);
  });

  it("caps the working side at the size limit", async () => {
    fsMock.stat.mockResolvedValue({ size: 9 * 1024 * 1024, isFile: () => true });

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.working).toEqual({ ok: false, error: "TOO_LARGE" });
    expect(fsMock.open).not.toHaveBeenCalled();
    expect(result.head.ok).toBe(true);
  });

  it("passes the HEAD-side TOO_LARGE result through", async () => {
    readFileAtHeadMock.mockResolvedValue({ ok: false, reason: "TOO_LARGE" });

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.head).toEqual({ ok: false, error: "TOO_LARGE" });
  });

  it("maps an unexpected git failure to a HEAD-side ERROR instead of rejecting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readFileAtHeadMock.mockRejectedValue(new Error("git exploded"));

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.head).toEqual({ ok: false, error: "ERROR" });
    expect(result.working.ok).toBe(true);
    expect(readPreviousFileVersionMock).not.toHaveBeenCalled();
  });

  it("returns ERROR for a working-tree file that escapes the root via symlink", async () => {
    fsMock.realpath.mockImplementation(async (p: string) =>
      p === REPO_ROOT ? REPO_ROOT : OUTSIDE_FILE
    );

    const result = await invoke({ cwd: REPO_ROOT, filePath: "img.png" });

    expect(result.working).toEqual({ ok: false, error: "ERROR" });
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("encodes both sides with the extension's mime type and real byte sizes", async () => {
    const result = await invoke({ cwd: REPO_ROOT, filePath: "logo.svg" });

    expect(result.head).toEqual({
      ok: true,
      dataUrl: `data:image/svg+xml;base64,${HEAD_BUFFER.toString("base64")}`,
      byteSize: HEAD_BUFFER.byteLength,
    });
    expect(result.working).toEqual({
      ok: true,
      dataUrl: `data:image/svg+xml;base64,${WORKING_BUFFER.toString("base64")}`,
      byteSize: WORKING_BUFFER.byteLength,
    });
    expect(fsMock.open).toHaveBeenCalledWith(
      path.join(REPO_ROOT, "logo.svg"),
      fsMock.constants.O_RDONLY | fsMock.constants.O_NOFOLLOW
    );
  });
});
