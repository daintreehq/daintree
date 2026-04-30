import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
}));

type FileHandleLike = {
  readFile: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const fsMock = vi.hoisted(() => {
  return {
    stat: vi.fn<(p: string) => Promise<{ size: number }>>(),
    realpath: vi.fn<(p: string) => Promise<string>>(),
    open: vi.fn<(p: string, flags: number) => Promise<FileHandleLike>>(),
    readFile: vi.fn<(p: string) => Promise<Buffer>>(),
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100 },
  };
});

vi.mock("fs/promises", () => ({
  default: fsMock,
  ...fsMock,
}));

const checkRateLimitMock = vi.hoisted(() => vi.fn());

type SafeParseable = {
  safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: unknown };
};

vi.mock("../../utils.js", () => ({
  checkRateLimit: checkRateLimitMock,
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: (channel: string, schema: SafeParseable, handler: unknown) => {
    ipcMainMock.handle(channel, async (_e: unknown, ...args: unknown[]) => {
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success) {
        throw new Error(`IPC validation failed: ${channel}`);
      }
      return (handler as (payload: unknown) => unknown)(parsed.data);
    });
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

function makeFileHandle(buffer: Buffer): FileHandleLike {
  return {
    readFile: vi.fn().mockResolvedValue(buffer),
    close: vi.fn().mockResolvedValue(undefined),
  };
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
    fsMock.realpath.mockImplementation(async (p: string) => p);
  });

  it("throws AppError(LFS_POINTER) when the file is a git-lfs v1 pointer", async () => {
    fsMock.stat.mockResolvedValue({ size: VALID_POINTER.length });
    fsMock.open.mockResolvedValue(makeFileHandle(VALID_POINTER));
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "LFS_POINTER",
    });
  });

  it("returns plain content for a normal text file", async () => {
    const content = Buffer.from("hello world\n", "utf-8");
    fsMock.stat.mockResolvedValue({ size: content.length });
    fsMock.open.mockResolvedValue(makeFileHandle(content));
    registerFilesHandlers();

    const result = await getReadHandler()({}, { path: file, rootPath: root });

    expect(result).toEqual({ content: "hello world\n" });
  });

  it("throws AppError(BINARY_FILE) before LFS detection when null bytes are present", async () => {
    const content = Buffer.concat([Buffer.from(LFS_HEADER, "ascii"), Buffer.from([0x00])]);
    fsMock.stat.mockResolvedValue({ size: content.length });
    fsMock.open.mockResolvedValue(makeFileHandle(content));
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "BINARY_FILE",
    });
  });

  it("throws AppError(FILE_TOO_LARGE) without opening the file for oversized files", async () => {
    fsMock.stat.mockResolvedValue({ size: 600 * 1024 });
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "FILE_TOO_LARGE",
    });
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("throws AppError(OUTSIDE_ROOT) when realpath resolves the file outside rootPath", async () => {
    registerFilesHandlers();

    await expect(
      getReadHandler()({}, { path: path.resolve("/etc/passwd"), rootPath: root })
    ).rejects.toMatchObject({ name: "AppError", code: "OUTSIDE_ROOT" });
    expect(fsMock.stat).not.toHaveBeenCalled();
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("throws AppError(OUTSIDE_ROOT) when a symlinked file resolves outside rootPath", async () => {
    const innerPath = path.join(root, "innocuous.json");
    const outsideTarget = path.resolve("/Users/me/.ssh/id_rsa");
    fsMock.realpath.mockImplementation(async (p: string) => (p === innerPath ? outsideTarget : p));
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: innerPath, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "OUTSIDE_ROOT",
    });
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("throws AppError(INVALID_PATH) for relative paths", async () => {
    registerFilesHandlers();

    await expect(
      getReadHandler()({}, { path: "./relative", rootPath: root })
    ).rejects.toMatchObject({ name: "AppError", code: "INVALID_PATH" });
  });

  it("throws AppError(INVALID_PATH) when realpath(rootPath) raises ENOENT", async () => {
    fsMock.realpath.mockImplementation(async (p: string) => {
      if (p === root) {
        throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
      }
      return p;
    });
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "INVALID_PATH",
    });
  });

  it("throws AppError(NOT_FOUND) when realpath(filePath) raises ENOENT", async () => {
    fsMock.realpath.mockImplementation(async (p: string) => {
      if (p === file) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      return p;
    });
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_FOUND",
    });
  });

  it("throws AppError(OUTSIDE_ROOT) when realpath raises ELOOP (circular symlink)", async () => {
    fsMock.realpath.mockImplementation(async (p: string) => {
      if (p === file) {
        throw Object.assign(new Error("too many symbolic links"), { code: "ELOOP" });
      }
      return p;
    });
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "OUTSIDE_ROOT",
    });
  });

  it("throws AppError(OUTSIDE_ROOT) when fs.open raises ELOOP (O_NOFOLLOW symlink rejection)", async () => {
    fsMock.stat.mockResolvedValue({ size: 100 });
    fsMock.open.mockRejectedValue(Object.assign(new Error("symbolic link"), { code: "ELOOP" }));
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "OUTSIDE_ROOT",
    });
  });

  it("opens the file with O_RDONLY | O_NOFOLLOW", async () => {
    const content = Buffer.from("hi", "utf-8");
    fsMock.stat.mockResolvedValue({ size: content.length });
    fsMock.open.mockResolvedValue(makeFileHandle(content));
    registerFilesHandlers();

    await getReadHandler()({}, { path: file, rootPath: root });

    expect(fsMock.open).toHaveBeenCalledWith(
      file,
      fsMock.constants.O_RDONLY | fsMock.constants.O_NOFOLLOW
    );
  });

  it("closes the file handle even when readFile rejects", async () => {
    fsMock.stat.mockResolvedValue({ size: 100 });
    const handle = {
      readFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("file disappeared"), { code: "ENOENT" })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    fsMock.open.mockResolvedValue(handle);
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_FOUND",
    });
    expect(handle.close).toHaveBeenCalledTimes(1);
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
    const handle = {
      readFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("file disappeared"), { code: "ENOENT" })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    fsMock.open.mockResolvedValue(handle);
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_FOUND",
    });
  });

  it("throws AppError(PERMISSION) when readFile raises EACCES", async () => {
    fsMock.stat.mockResolvedValue({ size: 100 });
    const handle = {
      readFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    fsMock.open.mockResolvedValue(handle);
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

  it("throws AppError(OUTSIDE_ROOT) for sibling-prefix escape (root '/tmp/project', file '/tmp/project-evil/x')", async () => {
    const evilFile = path.resolve("/tmp/project-evil/secret.txt");
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: evilFile, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "OUTSIDE_ROOT",
    });
    expect(fsMock.open).not.toHaveBeenCalled();
  });

  it("accepts a file when both root and file canonicalize through symlinked paths", async () => {
    const linkedRoot = path.resolve("/tmp/project-link");
    const linkedFile = path.join(linkedRoot, "a.txt");
    const realProject = path.resolve("/private/tmp/project");
    const realFile = path.join(realProject, "a.txt");
    fsMock.realpath.mockImplementation(async (p: string) => {
      if (p === linkedRoot) return realProject;
      if (p === linkedFile) return realFile;
      return p;
    });
    const content = Buffer.from("ok", "utf-8");
    fsMock.stat.mockResolvedValue({ size: content.length });
    fsMock.open.mockResolvedValue(makeFileHandle(content));
    registerFilesHandlers();

    const result = await getReadHandler()({}, { path: linkedFile, rootPath: linkedRoot });

    expect(result).toEqual({ content: "ok" });
  });

  it("returns the readFile error (not the close error) when both reject", async () => {
    fsMock.stat.mockResolvedValue({ size: 100 });
    const handle = {
      readFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("file disappeared"), { code: "ENOENT" })),
      close: vi.fn().mockRejectedValue(Object.assign(new Error("bad fd"), { code: "EBADF" })),
    };
    fsMock.open.mockResolvedValue(handle);
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_FOUND",
    });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("accepts a file at the exact size limit and rejects one byte over", async () => {
    const limit = 512 * 1024;
    fsMock.stat.mockResolvedValue({ size: limit });
    fsMock.open.mockResolvedValue(makeFileHandle(Buffer.alloc(limit, 0x61)));
    registerFilesHandlers();

    const result = await getReadHandler()({}, { path: file, rootPath: root });
    expect(result.content.length).toBe(limit);

    vi.clearAllMocks();
    fsMock.realpath.mockImplementation(async (p: string) => p);
    fsMock.stat.mockResolvedValue({ size: limit + 1 });
    registerFilesHandlers();

    await expect(getReadHandler()({}, { path: file, rootPath: root })).rejects.toMatchObject({
      name: "AppError",
      code: "FILE_TOO_LARGE",
    });
  });

  describe("schema validation", () => {
    it("rejects null byte in path", async () => {
      registerFilesHandlers();

      await expect(
        getReadHandler()({}, { path: `${file}\x00evil`, rootPath: root })
      ).rejects.toThrow(/IPC validation failed/);
    });

    it("rejects null byte in rootPath", async () => {
      registerFilesHandlers();

      await expect(
        getReadHandler()({}, { path: file, rootPath: `${root}\x00evil` })
      ).rejects.toThrow(/IPC validation failed/);
    });

    it("rejects path longer than 4096 chars without touching the filesystem", async () => {
      registerFilesHandlers();
      const longPath = path.join(root, "a".repeat(4097));

      await expect(getReadHandler()({}, { path: longPath, rootPath: root })).rejects.toThrow(
        /IPC validation failed/
      );
      expect(fsMock.realpath).not.toHaveBeenCalled();
      expect(fsMock.open).not.toHaveBeenCalled();
    });
  });
});
