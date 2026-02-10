import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const fileSearchServiceMock = vi.hoisted(() => ({
  search: vi.fn<(payload: { cwd: string; query: string; limit?: number }) => Promise<string[]>>(),
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
});
