import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

import { registerGitFetchHandlers } from "../gitFetch.js";
import { GIT_FETCH_METHOD_CHANNELS } from "../gitFetch.preload.js";
import { GitOperationError } from "../../../utils/errorTypes.js";
import type { HandlerDependencies } from "../../types.js";
import type { WorkspaceFetchResult } from "../../../../shared/types/workspace-host.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("git:fetch IPC", () => {
  let cleanup: () => void;
  let fetchWorktree: ReturnType<typeof vi.fn>;

  function invoke(payload: unknown) {
    return getHandler(GIT_FETCH_METHOD_CHANNELS.fetch)(fakeEvent(), payload);
  }

  function ok(overrides: Partial<WorkspaceFetchResult> = {}): WorkspaceFetchResult {
    return { status: "success", remote: "origin", ...overrides };
  }

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    fetchWorktree = vi.fn().mockResolvedValue(ok());
    cleanup = registerGitFetchHandlers({
      worktreeService: { fetchWorktree },
    } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("routes the fetch through the workspace service, not a local git spawn", async () => {
    // Running git here would bypass the per-repo serialization that keeps
    // sibling worktrees off each other's packed-refs.lock.
    await invoke({ cwd: "/repo" });

    expect(fetchWorktree).toHaveBeenCalledWith("/repo", true);
  });

  it("sends prune=false for the plain Fetch row", async () => {
    await invoke({ cwd: "/repo", prune: false });

    expect(fetchWorktree).toHaveBeenCalledWith("/repo", false);
  });

  it("sends prune=true for Fetch and prune", async () => {
    await invoke({ cwd: "/repo", prune: true });

    expect(fetchWorktree).toHaveBeenCalledWith("/repo", true);
  });

  it("rejects a relative cwd before reaching the workspace service", async () => {
    await expect(invoke({ cwd: "repo" })).rejects.toThrow();
    expect(fetchWorktree).not.toHaveBeenCalled();
  });

  it("rejects a structurally invalid payload", async () => {
    await expect(invoke({ cwd: "/repo", prune: "yes" })).rejects.toThrow();
    await expect(invoke({})).rejects.toThrow();
    expect(fetchWorktree).not.toHaveBeenCalled();
  });

  it("surfaces a failed fetch as a git error rather than a silent success", async () => {
    // A quiet resolve would leave the card's counts exactly as stale as before
    // the click, with nothing on screen saying the fetch never landed.
    fetchWorktree.mockResolvedValue({ status: "failed", reason: "network-unavailable" });

    await expect(invoke({ cwd: "/repo" })).rejects.toBeInstanceOf(GitOperationError);
  });

  it("surfaces an auth-suspended skip, which is a failure the user can act on", async () => {
    fetchWorktree.mockResolvedValue({
      status: "skipped",
      skipReason: "auth-suspended",
      reason: "auth-failed",
    });

    await expect(invoke({ cwd: "/repo" })).rejects.toBeInstanceOf(GitOperationError);
  });

  it("accepts a benign skip — a sibling's fetch seconds ago already refreshed the refs", async () => {
    fetchWorktree.mockResolvedValue({ status: "skipped", skipReason: "no-common-dir" });

    await expect(invoke({ cwd: "/repo" })).resolves.toBeUndefined();
  });

  it("fails loudly when no workspace service is available", async () => {
    cleanup();
    ipcHandlers.clear();
    cleanup = registerGitFetchHandlers({} as HandlerDependencies);

    await expect(invoke({ cwd: "/repo" })).rejects.toThrow();
  });

  it("removes its handler on cleanup", () => {
    cleanup();
    cleanup = () => {};

    expect(ipcHandlers.has(GIT_FETCH_METHOD_CHANNELS.fetch)).toBe(false);
  });
});
