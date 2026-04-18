import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
}));

const fileSearchServiceMock = vi.hoisted(() => ({
  search: vi.fn<(payload: { cwd: string; query: string; limit?: number }) => Promise<string[]>>(),
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
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      (event: { sender?: { id?: number } } | null | undefined, ...args: unknown[]) => {
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: null,
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../services/FileSearchService.js", () => ({
  fileSearchService: fileSearchServiceMock,
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerFilesHandlers } from "../files.js";

describe("files:search handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSearchServiceMock.search.mockResolvedValue(["README.md"]);
  });

  it("returns files for valid payloads", async () => {
    registerFilesHandlers();

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const entry = calls.find((c) => c[0] === CHANNELS.FILES_SEARCH);
    expect(entry).toBeTruthy();

    const handler = entry?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<{ files: string[] }>;
    const result = await handler({} as unknown, {
      cwd: "/tmp/project",
      query: "readme",
      limit: 5,
    });

    expect(result).toEqual({ files: ["README.md"] });
    expect(fileSearchServiceMock.search).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      query: "readme",
      limit: 5,
    });
  });

  it("returns empty files for invalid payloads", async () => {
    registerFilesHandlers();
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const entry = calls.find((c) => c[0] === CHANNELS.FILES_SEARCH);
    const handler = entry?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<{ files: string[] }>;

    const result = await handler({} as unknown, { cwd: "/tmp/project", query: 123 });

    expect(result).toEqual({ files: [] });
    expect(fileSearchServiceMock.search).not.toHaveBeenCalled();
  });

  it("returns empty files when cwd is not absolute", async () => {
    registerFilesHandlers();
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const entry = calls.find((c) => c[0] === CHANNELS.FILES_SEARCH);
    const handler = entry?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<{ files: string[] }>;

    const result = await handler({} as unknown, { cwd: "relative/path", query: "readme" });

    expect(result).toEqual({ files: [] });
    expect(fileSearchServiceMock.search).not.toHaveBeenCalled();
  });

  it("returns empty files when search service throws", async () => {
    fileSearchServiceMock.search.mockRejectedValue(new Error("Unexpected failure"));
    registerFilesHandlers();
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const entry = calls.find((c) => c[0] === CHANNELS.FILES_SEARCH);
    const handler = entry?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<{ files: string[] }>;

    const result = await handler({} as unknown, { cwd: "/tmp/project", query: "readme" });

    expect(result).toEqual({ files: [] });
  });

  it("removes handler on cleanup", () => {
    const cleanup = registerFilesHandlers();
    cleanup();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(CHANNELS.FILES_SEARCH);
  });

  it("calls checkRateLimit with files:search limits on every invocation", async () => {
    registerFilesHandlers();
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const entry = calls.find((c) => c[0] === CHANNELS.FILES_SEARCH);
    const handler = entry?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<{ files: string[] }>;

    await handler({} as unknown, { cwd: "/tmp/project", query: "readme" });

    expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.FILES_SEARCH, 20, 10_000);
  });

  it("propagates rate-limit errors and skips search service", async () => {
    checkRateLimitMock.mockImplementationOnce(() => {
      throw new Error("Rate limit exceeded");
    });
    registerFilesHandlers();
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const entry = calls.find((c) => c[0] === CHANNELS.FILES_SEARCH);
    const handler = entry?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<{ files: string[] }>;

    await expect(handler({} as unknown, { cwd: "/tmp/project", query: "readme" })).rejects.toThrow(
      "Rate limit exceeded"
    );
    expect(fileSearchServiceMock.search).not.toHaveBeenCalled();
  });
});
