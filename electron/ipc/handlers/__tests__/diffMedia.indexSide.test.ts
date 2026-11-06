import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

import { registerDiffMediaHandlers } from "../diffMedia.js";
import { DIFF_MEDIA_METHOD_CHANNELS } from "../diffMedia.preload.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { gitServiceCache } from "../../../services/GitServiceCache.js";
import { DIFF_MEDIA_MAX_BYTES } from "../../../../shared/types/ipc/diffMedia.js";
import type {
  DiffMediaFileVersionsResponse,
  DiffMediaReadFileVersionsPayload,
  DiffMediaWireSide,
} from "../../../../shared/types/ipc/diffMedia.js";

/**
 * Real-git coverage for #15610: one image with a different version at HEAD, in
 * the index and on disk, so each side of a partially staged file can be told
 * apart by the bytes it returns.
 */

type Handler = (
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<DiffMediaFileVersionsResponse>;

function invoke(payload: DiffMediaReadFileVersionsPayload): Promise<DiffMediaFileVersionsResponse> {
  const fn = ipcHandlers.get(DIFF_MEDIA_METHOD_CHANNELS.readFileVersions);
  if (!fn) throw new Error("handler not registered");
  const event = { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
  return (fn as Handler)(event, payload);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

// NUL bytes keep git from ever treating these as text.
const RED = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x72, 0x65, 0x64]);
const BLUE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x62, 0x6c, 0x75, 0x65]);
const GREEN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x67, 0x72, 0x65, 0x65, 0x6e]);

const FILE = "assets/logo.png";

function bytesOf(side: DiffMediaWireSide): Buffer {
  if (!side.ok || "unchanged" in side) {
    throw new Error(`expected image bytes, got ${JSON.stringify(side)}`);
  }
  return Buffer.from(side.dataUrl.slice(side.dataUrl.indexOf(",") + 1), "base64");
}

describe("diffMedia readFileVersions against a real repository", () => {
  let root: string;
  let repo: string;
  let cleanup: (() => void) | undefined;

  function write(relativePath: string, content: Buffer): void {
    const absolute = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }

  function commitAll(message: string): void {
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", message]);
  }

  beforeEach(() => {
    ipcHandlers.clear();
    cleanup = undefined;
    _resetRateLimitQueuesForTest();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-diff-media-index-")));
    repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    write("README.md", Buffer.from("fixture\n"));
    commitAll("init");
    cleanup = registerDiffMediaHandlers();
  });

  afterEach(() => {
    cleanup?.();
    gitServiceCache.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("with distinct HEAD, index and working-tree versions", () => {
    beforeEach(() => {
      write(FILE, RED);
      commitAll("red");
      write(FILE, BLUE);
      git(repo, ["add", "--", FILE]);
      write(FILE, GREEN);
    });

    it("compares HEAD with the working tree when no side is named", async () => {
      const result = await invoke({ cwd: repo, filePath: FILE });
      expect(bytesOf(result.head)).toEqual(RED);
      expect(bytesOf(result.working)).toEqual(GREEN);
    });

    it("compares HEAD with the index for the staged side", async () => {
      const result = await invoke({ cwd: repo, filePath: FILE, side: "staged" });
      expect(bytesOf(result.head)).toEqual(RED);
      expect(bytesOf(result.working)).toEqual(BLUE);
    });

    it("compares the index with the working tree for the unstaged side", async () => {
      const result = await invoke({ cwd: repo, filePath: FILE, side: "unstaged" });
      expect(bytesOf(result.head)).toEqual(BLUE);
      expect(bytesOf(result.working)).toEqual(GREEN);
    });

    it("revalidates an index side by its blob without resending it", async () => {
      const first = await invoke({ cwd: repo, filePath: FILE, side: "staged" });
      const headVersion = first.head.ok ? first.head.version : undefined;
      const indexVersion = first.working.ok ? first.working.version : undefined;
      expect(indexVersion).toBeDefined();
      expect(indexVersion).not.toBe(headVersion);

      const second = await invoke({
        cwd: repo,
        filePath: FILE,
        side: "staged",
        known: { head: headVersion, working: indexVersion },
      });
      expect(second.head).toEqual({ ok: true, unchanged: true, version: headVersion });
      expect(second.working).toEqual({ ok: true, unchanged: true, version: indexVersion });

      // Restaging moves the index blob, so the held version no longer matches.
      write(FILE, GREEN);
      git(repo, ["add", "--", FILE]);
      const third = await invoke({
        cwd: repo,
        filePath: FILE,
        side: "staged",
        known: { head: headVersion, working: indexVersion },
      });
      expect(bytesOf(third.working)).toEqual(GREEN);
    });
  });

  it("shows a staged-new image's index bytes, and its later edit against them", async () => {
    write(FILE, BLUE);
    git(repo, ["add", "--", FILE]);
    write(FILE, GREEN);

    const staged = await invoke({ cwd: repo, filePath: FILE, side: "staged" });
    expect(staged.head).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(bytesOf(staged.working)).toEqual(BLUE);

    const unstaged = await invoke({ cwd: repo, filePath: FILE, side: "unstaged" });
    expect(bytesOf(unstaged.head)).toEqual(BLUE);
    expect(bytesOf(unstaged.working)).toEqual(GREEN);
  });

  it("has no index version for a staged deletion, and no working one for an unstaged deletion", async () => {
    write(FILE, RED);
    commitAll("red");
    write(FILE, BLUE);
    git(repo, ["add", "--", FILE]);
    fs.rmSync(path.join(repo, FILE));

    const unstaged = await invoke({ cwd: repo, filePath: FILE, side: "unstaged" });
    expect(bytesOf(unstaged.head)).toEqual(BLUE);
    expect(unstaged.working).toEqual({ ok: false, error: "NOT_FOUND" });

    git(repo, ["rm", "-q", "--cached", "--", FILE]);
    const staged = await invoke({ cwd: repo, filePath: FILE, side: "staged" });
    expect(bytesOf(staged.head)).toEqual(RED);
    expect(staged.working).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("reads the index of a repository with no commits yet", async () => {
    const fresh = path.join(root, "fresh");
    fs.mkdirSync(fresh);
    git(fresh, ["init", "-q", "-b", "main"]);
    fs.mkdirSync(path.join(fresh, "assets"));
    fs.writeFileSync(path.join(fresh, FILE), BLUE);
    git(fresh, ["add", "--", FILE]);
    fs.writeFileSync(path.join(fresh, FILE), GREEN);

    const staged = await invoke({ cwd: fresh, filePath: FILE, side: "staged" });
    expect(staged.head).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(bytesOf(staged.working)).toEqual(BLUE);
  });

  it("reads each worktree's own index", async () => {
    write(FILE, RED);
    commitAll("red");
    const linked = path.join(root, "linked");
    git(repo, ["worktree", "add", "-q", "-b", "linked", linked]);
    fs.writeFileSync(path.join(linked, FILE), BLUE);
    git(linked, ["add", "--", FILE]);
    fs.writeFileSync(path.join(linked, FILE), GREEN);

    const inLinked = await invoke({ cwd: linked, filePath: FILE, side: "staged" });
    expect(bytesOf(inLinked.working)).toEqual(BLUE);
    const inMain = await invoke({ cwd: repo, filePath: FILE, side: "staged" });
    expect(bytesOf(inMain.working)).toEqual(RED);
  });

  it("reads a renamed image at its new path only, as the HEAD side always has", async () => {
    write("assets/old.png", RED);
    commitAll("red");
    git(repo, ["mv", "assets/old.png", FILE]);
    write(FILE, GREEN);

    const staged = await invoke({ cwd: repo, filePath: FILE, side: "staged" });
    expect(staged.head).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(bytesOf(staged.working)).toEqual(RED);

    const unstaged = await invoke({ cwd: repo, filePath: FILE, side: "unstaged" });
    expect(bytesOf(unstaged.head)).toEqual(RED);
    expect(bytesOf(unstaged.working)).toEqual(GREEN);
  });

  it("falls back to history after a committed deletion only when no side is named", async () => {
    write(FILE, RED);
    commitAll("red");
    git(repo, ["rm", "-q", "--", FILE]);
    git(repo, ["commit", "-qm", "delete"]);

    const plain = await invoke({ cwd: repo, filePath: FILE });
    expect(bytesOf(plain.head)).toEqual(RED);

    for (const side of ["staged", "unstaged"] as const) {
      const result = await invoke({ cwd: repo, filePath: FILE, side });
      expect(result.head).toEqual({ ok: false, error: "NOT_FOUND" });
      expect(result.working).toEqual({ ok: false, error: "NOT_FOUND" });
    }
  });

  it("caps an oversized index blob like any other side", async () => {
    write(FILE, RED);
    commitAll("red");
    write(FILE, Buffer.alloc(DIFF_MEDIA_MAX_BYTES + 1, 0x01));
    git(repo, ["add", "--", FILE]);
    write(FILE, GREEN);

    const staged = await invoke({ cwd: repo, filePath: FILE, side: "staged" });
    expect(bytesOf(staged.head)).toEqual(RED);
    expect(staged.working).toEqual({ ok: false, error: "TOO_LARGE" });

    const unstaged = await invoke({ cwd: repo, filePath: FILE, side: "unstaged" });
    expect(unstaged.head).toEqual({ ok: false, error: "TOO_LARGE" });
    expect(bytesOf(unstaged.working)).toEqual(GREEN);
  });
});
