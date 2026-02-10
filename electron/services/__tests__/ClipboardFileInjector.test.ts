import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const clipboardMock = vi.hoisted(() => ({
  availableFormats: vi.fn(() => []),
  read: vi.fn(() => ""),
  readBuffer: vi.fn(() => Buffer.alloc(0)),
  readText: vi.fn(() => ""),
}));

vi.mock("electron", () => ({
  clipboard: clipboardMock,
  WebContents: class {},
}));

import { ClipboardFileInjector } from "../ClipboardFileInjector.js";

function validate(paths: string[]): Promise<string[]> {
  const injector = ClipboardFileInjector as unknown as {
    validateFilePaths(paths: string[]): Promise<string[]>;
  };
  return injector.validateFilePaths(paths);
}

describe("ClipboardFileInjector", () => {
  let tempRoot: string;
  let homeDir: string;
  let tmpDir: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clipboard-file-injector-test-"));
    homeDir = path.join(tempRoot, "home", "user");
    tmpDir = path.join(tempRoot, "runtime-temp");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(tmpDir, { recursive: true });

    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.spyOn(os, "tmpdir").mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("accepts files located under the configured home directory", async () => {
    const filePath = path.join(homeDir, "notes.txt");
    await fs.writeFile(filePath, "hello");

    const result = await validate([filePath]);

    expect(result).toEqual([await fs.realpath(filePath)]);
  });

  it("accepts files located under os.tmpdir()", async () => {
    const filePath = path.join(tmpDir, "staged-upload.txt");
    await fs.writeFile(filePath, "tmp");

    const result = await validate([filePath]);

    expect(result).toEqual([await fs.realpath(filePath)]);
  });

  it("rejects sibling paths that share only a home-directory string prefix", async () => {
    const siblingDir = path.join(tempRoot, "home", "user-evil");
    const siblingFile = path.join(siblingDir, "steal.txt");
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(siblingFile, "nope");

    const result = await validate([siblingFile]);

    expect(result).toEqual([]);
  });

  it("rejects relative clipboard paths", async () => {
    const result = await validate(["../relative.txt"]);
    expect(result).toEqual([]);
  });

  it("rejects non-file paths", async () => {
    const dirPath = path.join(homeDir, "folder-only");
    await fs.mkdir(dirPath, { recursive: true });

    const result = await validate([dirPath]);
    expect(result).toEqual([]);
  });
});
