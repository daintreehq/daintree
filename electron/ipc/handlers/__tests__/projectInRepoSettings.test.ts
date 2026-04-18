import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
}));

const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getAllProjects: vi.fn(),
  getProjectSettings: vi.fn(),
  writeInRepoProjectIdentity: vi.fn(),
  writeInRepoSettings: vi.fn(),
  writeInRepoRecipe: vi.fn(),
  getRecipes: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../../utils.js", () => ({
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectInRepoSettingsHandlers } from "../projectInRepoSettings.js";
import type { HandlerDependencies } from "../../types.js";

type HandlerEntry = [string, (event: unknown, ...args: unknown[]) => unknown];

function getHandler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const calls = (ipcMain.handle as unknown as { mock: { calls: HandlerEntry[] } }).mock.calls;
  const entry = calls.find((c) => c[0] === channel);
  if (!entry) throw new Error(`Handler not registered for ${channel}`);
  return entry[1];
}

describe("project:detect-context-files handler", () => {
  let tempDir: string;
  let cleanup: (() => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-detect-context-"));
    cleanup = registerProjectInRepoSettingsHandlers({} as HandlerDependencies);
  });

  afterEach(async () => {
    cleanup?.();
    cleanup = null;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("throws on invalid project ID", async () => {
    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    await expect(handler({}, "")).rejects.toThrow(/Invalid project ID/);
    await expect(handler({}, null)).rejects.toThrow(/Invalid project ID/);
  });

  it("throws when project is not found", async () => {
    projectStoreMock.getProjectById.mockReturnValue(undefined);
    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    await expect(handler({}, "missing-id")).rejects.toThrow(/Project not found/);
  });

  it("returns empty array when no context files exist", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: tempDir });
    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");
    expect(result).toEqual([]);
  });

  it("detects a single CLAUDE.md file", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: tempDir });
    await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "# claude", "utf-8");

    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");

    expect(result).toEqual(["CLAUDE.md"]);
  });

  it("detects multiple context files and preserves canonical order", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: tempDir });
    await fs.writeFile(path.join(tempDir, ".cursorrules"), "rules", "utf-8");
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# agents", "utf-8");
    await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "# claude", "utf-8");

    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");

    // Order follows CONTEXT_FILE_CANDIDATES: CLAUDE.md, AGENTS.md, ..., .cursorrules
    expect(result).toEqual(["CLAUDE.md", "AGENTS.md", ".cursorrules"]);
  });

  it("detects nested .claude/settings.json", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: tempDir });
    await fs.mkdir(path.join(tempDir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".claude/settings.json"), "{}", "utf-8");

    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");

    expect(result).toEqual([".claude/settings.json"]);
  });

  it("detects .mcp.json and .windsurfrules", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: tempDir });
    await fs.writeFile(path.join(tempDir, ".mcp.json"), "{}", "utf-8");
    await fs.writeFile(path.join(tempDir, ".windsurfrules"), "rules", "utf-8");

    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");

    expect(result).toEqual([".mcp.json", ".windsurfrules"]);
  });

  it("treats filesystem errors for individual files as absent", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: "/nonexistent/path/xyz" });
    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");
    expect(result).toEqual([]);
  });

  it("ignores directories that share a candidate name", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: tempDir });
    // A directory named CLAUDE.md should not count as a context file.
    await fs.mkdir(path.join(tempDir, "CLAUDE.md"));

    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");

    expect(result).toEqual([]);
  });

  it("rejects symlinks even when they target real files", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: tempDir });
    const realTarget = path.join(tempDir, "real-claude.md");
    await fs.writeFile(realTarget, "# claude", "utf-8");
    await fs.symlink(realTarget, path.join(tempDir, "CLAUDE.md"));

    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");

    expect(result).toEqual([]);
  });

  it("returns other files when one candidate cannot be read", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: tempDir });
    await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "# claude", "utf-8");
    // A directory at this path will be rejected by isFile(); remaining files still reported.
    await fs.mkdir(path.join(tempDir, ".cursorrules"));
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# agents", "utf-8");

    const handler = getHandler(CHANNELS.PROJECT_DETECT_CONTEXT_FILES);
    const result = await handler({}, "p1");

    expect(result).toEqual(["CLAUDE.md", "AGENTS.md"]);
  });
});
