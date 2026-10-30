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
  listCodexSessionsForCwd: vi.fn(),
  matchCodexRestoreSessions: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/codex/CodexSubagentService.js", () => serviceMock);
const quotaMock = vi.hoisted(() => ({
  readCodexQuotaProfiles: vi.fn(),
  refreshCodexQuotaProfiles: vi.fn(),
}));
vi.mock("../../../services/codex/CodexQuotaService.js", () => quotaMock);

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
const findSessionsChannel = CHANNELS.CODEX_FIND_SESSIONS;
const matchRestoreChannel = CHANNELS.CODEX_MATCH_RESTORE_SESSIONS;

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

  // issue #12182 — "Find session" on the lost-session banner.
  describe("findSessions", () => {
    it("passes cwd and an optional codexHome through to the service", async () => {
      serviceMock.listCodexSessionsForCwd.mockResolvedValue({ status: "ok", sessions: [] });

      const result = await getHandler(findSessionsChannel)(fakeEvent(), {
        cwd: "/repo/worktree",
        codexHome: "/repo/.codex-home",
      });

      expect(result).toEqual({ status: "ok", sessions: [] });
      expect(serviceMock.listCodexSessionsForCwd).toHaveBeenCalledWith(
        "/repo/worktree",
        "/repo/.codex-home"
      );
    });

    it("omits codexHome when the caller doesn't supply one", async () => {
      serviceMock.listCodexSessionsForCwd.mockResolvedValue({ status: "ok", sessions: [] });

      await getHandler(findSessionsChannel)(fakeEvent(), { cwd: "/repo" });

      expect(serviceMock.listCodexSessionsForCwd).toHaveBeenCalledWith("/repo", undefined);
    });

    it.each([
      ["a relative cwd", { cwd: "relative/path" }],
      ["a relative codexHome", { cwd: "/repo", codexHome: "relative" }],
      ["a NUL byte in cwd", { cwd: "/repo\0" }],
      ["a non-string codexHome", { cwd: "/repo", codexHome: 42 }],
    ])("rejects %s before reaching the service", async (_label, payload) => {
      await expect(getHandler(findSessionsChannel)(fakeEvent(), payload)).rejects.toThrow();

      expect(serviceMock.listCodexSessionsForCwd).not.toHaveBeenCalled();
    });

    it("propagates a service failure", async () => {
      serviceMock.listCodexSessionsForCwd.mockRejectedValue(new Error("app-server down"));

      await expect(getHandler(findSessionsChannel)(fakeEvent(), { cwd: "/repo" })).rejects.toThrow(
        "app-server down"
      );
    });
  });

  describe("matchRestoreSessions", () => {
    const hash = "a".repeat(64);
    const request = {
      scopes: [
        {
          cwd: "/repo",
          codexHome: "/profiles/work",
          reserveLatest: true,
          panes: [{ key: "pane-1", promptHash: hash, at: 1_800_000_000_000, resolve: true }],
        },
      ],
      exclude: ["sess-held"],
    };

    it("passes a well-formed request through and returns ids only", async () => {
      serviceMock.matchCodexRestoreSessions.mockResolvedValue({
        matches: [{ key: "pane-1", sessionId: "sess-1" }],
      });

      const result = await getHandler(matchRestoreChannel)(fakeEvent(), request);

      expect(result).toEqual({ matches: [{ key: "pane-1", sessionId: "sess-1" }] });
      expect(serviceMock.matchCodexRestoreSessions).toHaveBeenCalledWith(request);
    });

    const withPane = (pane: Record<string, unknown>) => ({
      ...request,
      scopes: [{ ...request.scopes[0], panes: [{ ...request.scopes[0]!.panes[0], ...pane }] }],
    });

    it.each([
      ["prompt text in place of a digest", withPane({ promptHash: "Fix the parser" })],
      ["an uppercase digest", withPane({ promptHash: "A".repeat(64) })],
      ["a launch time that isn't one", withPane({ at: 0 })],
      ["a relative folder", { ...request, scopes: [{ ...request.scopes[0], cwd: "repo" }] }],
      [
        "a relative profile",
        { ...request, scopes: [{ ...request.scopes[0], codexHome: "profiles/work" }] },
      ],
      ["a scope with no panes", { ...request, scopes: [{ ...request.scopes[0], panes: [] }] }],
      ["a missing exclude list", { scopes: request.scopes }],
    ])("rejects %s before reaching the service", async (_label, payload) => {
      await expect(getHandler(matchRestoreChannel)(fakeEvent(), payload)).rejects.toThrow();

      expect(serviceMock.matchCodexRestoreSessions).not.toHaveBeenCalled();
    });
  });

  describe("readQuota", () => {
    const profiles = [
      {
        key: "k",
        isDefault: true,
        presetNames: [],
        result: { status: "unavailable", reason: "read-failed", fetchedAt: 1 },
      },
    ];

    it("returns every profile main resolved, unchanged (#12797, #13686)", async () => {
      quotaMock.readCodexQuotaProfiles.mockResolvedValue(profiles);

      expect(await getHandler(CHANNELS.CODEX_READ_QUOTA)(fakeEvent())).toBe(profiles);
      expect(quotaMock.readCodexQuotaProfiles).toHaveBeenCalledTimes(1);
    });

    it("never passes a renderer payload through as a home", async () => {
      quotaMock.readCodexQuotaProfiles.mockResolvedValue(profiles);

      await getHandler(CHANNELS.CODEX_READ_QUOTA)(fakeEvent(), { codexHome: "/elsewhere" });
      expect(quotaMock.readCodexQuotaProfiles).toHaveBeenCalledWith();
    });

    it("routes an explicit refresh past the cache", async () => {
      quotaMock.refreshCodexQuotaProfiles.mockResolvedValue(profiles);

      expect(await getHandler(CHANNELS.CODEX_REFRESH_QUOTA)(fakeEvent())).toBe(profiles);
      expect(quotaMock.readCodexQuotaProfiles).not.toHaveBeenCalled();
    });
  });
});
