import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
}));

const fsMock = vi.hoisted(() => ({
  stat: vi.fn<(p: string) => Promise<{ size: number }>>(),
  readFile: vi.fn<(p: string) => Promise<Buffer>>(),
}));

vi.mock("fs/promises", () => ({
  default: fsMock,
  ...fsMock,
}));

const checkRateLimitMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils.js", () => ({
  checkRateLimit: checkRateLimitMock,
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../services/FileSearchService.js", () => ({
  fileSearchService: { search: vi.fn() },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerFilesHandlers, isLfsPointer } from "../files.js";
import type { FileReadResult } from "../../../../shared/types/ipc/files.js";

const LFS_HEADER = "version https://git-lfs.github.com/spec/v1\n";
const VALID_POINTER = Buffer.from(
  `${LFS_HEADER}oid sha256:3f4e9b7d2c0b5a8f6e1d2c3b4a5968777665544332211aabbccddeeff00112233\nsize 12345\n`,
  "ascii"
);

function getReadHandler() {
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  const entry = calls.find((c) => c[0] === CHANNELS.FILES_READ);
  if (!entry) throw new Error("files:read handler not registered");
  return entry[1] as (event: unknown, payload: unknown) => Promise<FileReadResult>;
}

describe("isLfsPointer", () => {
  it("matches a valid v1 pointer stub", () => {
    expect(isLfsPointer(VALID_POINTER)).toBe(true);
  });

  it("matches a minimal header-only buffer", () => {
    expect(isLfsPointer(Buffer.from(LFS_HEADER, "ascii"))).toBe(true);
  });

  it("rejects files larger than the 1024-byte spec cap", () => {
    const padded = Buffer.concat([VALID_POINTER, Buffer.alloc(1024, 32)]);
    expect(padded.length).toBeGreaterThan(1024);
    expect(isLfsPointer(padded)).toBe(false);
  });

  it("rejects buffers shorter than the header length", () => {
    expect(isLfsPointer(Buffer.from("version https://git-lfs", "ascii"))).toBe(false);
  });

  it("rejects non-LFS text that happens to start with 'version '", () => {
    expect(isLfsPointer(Buffer.from("version 1.2.3\n", "ascii"))).toBe(false);
  });

  it("rejects the header when the trailing LF is missing (strict match)", () => {
    const headerWithoutLf = "version https://git-lfs.github.com/spec/v1";
    expect(isLfsPointer(Buffer.from(headerWithoutLf, "ascii"))).toBe(false);
  });

  it("rejects an empty buffer", () => {
    expect(isLfsPointer(Buffer.alloc(0))).toBe(false);
  });
});

describe("files:read handler", () => {
  const root = path.resolve("/tmp/project");
  const file = path.join(root, "asset.bin");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws AppError(LFS_POINTER) when the file is a git-lfs v1 pointer", async () => {
    fsMock.stat.mockResolvedValue({ size: VALID_POINTER.length });
    fsMock.readFile.mockResolvedValue(VALID_POINTER);
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "LFS_POINTER",
    });
  });

  it("returns plain content for a normal text file", async () => {
    const content = Buffer.from("hello world\n", "utf-8");
    fsMock.stat.mockResolvedValue({ size: content.length });
    fsMock.readFile.mockResolvedValue(content);
    registerFilesHandlers();

    const result = await getReadHandler()({}, { path: file, rootPath: root });

    expect(result).toEqual({ content: "hello world\n" });
  });

  it("throws AppError(BINARY_FILE) before LFS detection when null bytes are present", async () => {
    const content = Buffer.concat([Buffer.from(LFS_HEADER, "ascii"), Buffer.from([0x00])]);
    fsMock.stat.mockResolvedValue({ size: content.length });
    fsMock.readFile.mockResolvedValue(content);
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "BINARY_FILE",
    });
  });

  it("throws AppError(FILE_TOO_LARGE) without reading the buffer for oversized files", async () => {
    fsMock.stat.mockResolvedValue({ size: 600 * 1024 });
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "FILE_TOO_LARGE",
    });
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("throws AppError(OUTSIDE_ROOT) when the file is not under rootPath", async () => {
    registerFilesHandlers();

    await expect(
      getReadHandler()({}, { path: path.resolve("/etc/passwd"), rootPath: root })
    ).rejects.toMatchObject({ name: "AppError", code: "OUTSIDE_ROOT" });
    expect(fsMock.stat).not.toHaveBeenCalled();
  });

  it("throws AppError(INVALID_PATH) for relative paths", async () => {
    registerFilesHandlers();

    await expect(
      getReadHandler()({}, { path: "./relative", rootPath: root })
    ).rejects.toMatchObject({ name: "AppError", code: "INVALID_PATH" });
  });

  it("throws AppError(NOT_FOUND) when stat raises ENOENT", async () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    fsMock.stat.mockRejectedValue(err);
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_FOUND",
    });
  });

  it("throws AppError(NOT_FOUND) when stat succeeds but readFile raises ENOENT (TOCTOU)", async () => {
    fsMock.stat.mockResolvedValue({ size: 100 });
    fsMock.readFile.mockRejectedValue(
      Object.assign(new Error("file disappeared"), { code: "ENOENT" })
    );
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_FOUND",
    });
  });

  it("throws AppError(PERMISSION) when readFile raises EACCES", async () => {
    fsMock.stat.mockResolvedValue({ size: 100 });
    fsMock.readFile.mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" })
    );
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "PERMISSION",
    });
  });

  it("throws AppError(PERMISSION) when stat raises EPERM", async () => {
    fsMock.stat.mockRejectedValue(
      Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    );
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "PERMISSION",
    });
  });
});
