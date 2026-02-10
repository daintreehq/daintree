import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const fsPromisesMock = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

const gitUtilsMock = vi.hoisted(() => ({
  getGitDir: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("fs/promises", () => fsPromisesMock);
vi.mock("../../../utils/gitUtils.js", () => gitUtilsMock);
vi.mock("../../../utils/logger.js", () => loggerMock);

import { NoteFileReader } from "../NoteFileReader.js";

describe("NoteFileReader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (gitUtilsMock.getGitDir as Mock).mockReturnValue("/repo/.git");
    (fsPromisesMock.stat as Mock).mockResolvedValue({ mtimeMs: 1234 });
    (fsPromisesMock.readFile as Mock).mockResolvedValue("first line\nlast line");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when disabled", async () => {
    const reader = new NoteFileReader("/repo", false);

    await expect(reader.read()).resolves.toBeUndefined();
    expect(gitUtilsMock.getGitDir).not.toHaveBeenCalled();
  });

  it("returns the last non-empty line and timestamp", async () => {
    const reader = new NoteFileReader("/repo", true, "canopy/note");

    await expect(reader.read()).resolves.toEqual({
      content: "last line",
      timestamp: 1234,
    });
  });

  it("truncates overly long last line", async () => {
    const reader = new NoteFileReader("/repo", true, "canopy/note");
    (fsPromisesMock.readFile as Mock).mockResolvedValue(`ok\n${"x".repeat(600)}`);

    const result = await reader.read();
    expect(result?.content.length).toBe(500);
    expect(result?.content.endsWith("...")).toBe(true);
  });

  it("rejects absolute note filename paths", async () => {
    const reader = new NoteFileReader("/repo", true, "/etc/passwd");

    await expect(reader.read()).resolves.toBeUndefined();
    expect(fsPromisesMock.stat).not.toHaveBeenCalled();
    expect(fsPromisesMock.readFile).not.toHaveBeenCalled();
    expect(loggerMock.logWarn).toHaveBeenCalledWith(
      "Invalid AI note filename configuration",
      expect.objectContaining({
        path: "/repo",
        filename: "/etc/passwd",
      })
    );
  });

  it("rejects path traversal note filename paths", async () => {
    const reader = new NoteFileReader("/repo", true, "../secrets.txt");

    await expect(reader.read()).resolves.toBeUndefined();
    expect(fsPromisesMock.stat).not.toHaveBeenCalled();
    expect(fsPromisesMock.readFile).not.toHaveBeenCalled();
    expect(loggerMock.logWarn).toHaveBeenCalledWith(
      "Invalid AI note filename configuration",
      expect.objectContaining({
        path: "/repo",
        filename: "../secrets.txt",
      })
    );
  });
});
