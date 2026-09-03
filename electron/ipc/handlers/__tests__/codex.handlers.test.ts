import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const serviceMock = vi.hoisted(() => ({
  listCodexSubagents: vi.fn(),
  readCodexSubagentTranscript: vi.fn(),
  resolveCodexResumeLatestSession: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/codex/CodexSubagentService.js", () => serviceMock);

import { registerCodexHandlers } from "../codex.js";
import { CHANNELS } from "../../channels.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

const resolveChannel = CHANNELS.CODEX_RESOLVE_RESUME_LATEST_SESSION;

describe("codex IPC handlers", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    cleanup = registerCodexHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  describe("resolveResumeLatestSession", () => {
    it("passes an absolute cwd through and returns the resolved session id", async () => {
      serviceMock.resolveCodexResumeLatestSession.mockResolvedValue("session-uuid");

      const result = await getHandler(resolveChannel)(fakeEvent(), { cwd: "/repo/worktree" });

      expect(result).toBe("session-uuid");
      expect(serviceMock.resolveCodexResumeLatestSession).toHaveBeenCalledWith("/repo/worktree");
    });

    it("returns null unchanged when the directory has nothing to resume", async () => {
      serviceMock.resolveCodexResumeLatestSession.mockResolvedValue(null);

      expect(await getHandler(resolveChannel)(fakeEvent(), { cwd: "/repo" })).toBeNull();
    });

    it("does not normalize the cwd, because Codex matches it as an exact string", async () => {
      serviceMock.resolveCodexResumeLatestSession.mockResolvedValue(null);

      await getHandler(resolveChannel)(fakeEvent(), { cwd: "/repo/./worktree/" });

      expect(serviceMock.resolveCodexResumeLatestSession).toHaveBeenCalledWith("/repo/./worktree/");
    });

    it.each([
      ["a relative path", { cwd: "relative/path" }],
      ["an empty path", { cwd: "" }],
      ["a non-string path", { cwd: 42 }],
      ["a missing payload field", {}],
      ["an oversized path", { cwd: `/${"a".repeat(5000)}` }],
    ])("rejects %s before reaching the service", async (_label, payload) => {
      await expect(getHandler(resolveChannel)(fakeEvent(), payload)).rejects.toThrow();

      expect(serviceMock.resolveCodexResumeLatestSession).not.toHaveBeenCalled();
    });

    it("propagates a service failure rather than reporting a resolved session", async () => {
      serviceMock.resolveCodexResumeLatestSession.mockRejectedValue(new Error("app-server down"));

      await expect(getHandler(resolveChannel)(fakeEvent(), { cwd: "/repo" })).rejects.toThrow(
        "app-server down"
      );
    });
  });

  it("removes every codex handler on cleanup", () => {
    expect(ipcHandlers.has(resolveChannel)).toBe(true);
    expect(ipcHandlers.has(CHANNELS.CODEX_LIST_SUBAGENTS)).toBe(true);

    cleanup();

    expect(ipcHandlers.size).toBe(0);
    // Registered again in afterEach's cleanup call, which must stay safe to repeat.
    cleanup = () => {};
  });
});
