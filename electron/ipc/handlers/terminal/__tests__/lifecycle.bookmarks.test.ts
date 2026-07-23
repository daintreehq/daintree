import { describe, it, expect, vi, beforeEach } from "vitest";
import { CHANNELS } from "../../../channels.js";
import type { HandlerDependencies } from "../../../types.js";

// Focused coverage of the bookmark IPC handlers in registerTerminalLifecycleHandlers:
// error-code mapping, the generation freeze/recheck, and the prepare-before-remove
// contract. The journal + ledger + service mutators are mocked so this exercises the
// handler orchestration only (their behavior is covered by agentSessionHistory/journal
// suites). Handlers are captured off the mocked ipcMain the namespace registers against.

const ipcMainMock = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: { getPath: vi.fn(() => "/tmp/test") },
}));

vi.mock("../../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(),
    getProjectById: vi.fn(),
    getProjectSettings: vi.fn(),
  },
}));
vi.mock("../../../../services/pty/terminalShell.js", () => ({
  getDefaultShell: vi.fn(() => "/bin/zsh"),
}));

const m = vi.hoisted(() => ({
  journalAgentSessionRecord: vi.fn(),
  journalAgentSession: vi.fn().mockResolvedValue(true),
  promoteBookmark: vi.fn(),
  renameBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  listBookmarks: vi.fn(() => []),
  currentGeneration: vi.fn(() => 1),
  isCurrent: vi.fn(() => true),
}));

vi.mock("../../../../services/pty/agentSessionHistory.js", () => ({
  persistAgentSession: vi.fn().mockResolvedValue(undefined),
  listAgentSessions: vi.fn(() => []),
  clearAgentSessions: vi.fn().mockResolvedValue(undefined),
  pruneAgentSessions: vi.fn().mockResolvedValue(undefined),
  promoteBookmark: m.promoteBookmark,
  renameBookmark: m.renameBookmark,
  deleteBookmark: m.deleteBookmark,
  listBookmarks: m.listBookmarks,
  DEFAULT_RETENTION_DAYS: 30,
}));
vi.mock("../../../../services/pty/agentSessionJournal.js", () => ({
  journalAgentSession: m.journalAgentSession,
  journalAgentSessionRecord: m.journalAgentSessionRecord,
}));
vi.mock("../../../../services/pty/agentSessionRetention.js", () => ({
  getAgentSessionRetentionDays: vi.fn(() => 30),
}));
vi.mock("../../../../services/pty/lifecycleLedger.js", () => ({
  getLifecycleLedger: () => ({
    currentGeneration: m.currentGeneration,
    isCurrent: m.isCurrent,
  }),
}));
vi.mock("../../../../shared/config/agentRegistry.js", () => ({
  isRegisteredAgent: vi.fn(() => false),
  getAssistantWiredAgentIds: vi.fn(() => ["claude"]),
  getEffectiveAgentConfig: vi.fn((id: string) => {
    if (id === "claude") return { resume: { kind: "session-id" } };
    if (id === "rolling") return { resume: { kind: "rolling-history" } };
    return undefined;
  }),
}));

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
vi.mock("../../../utils.js", () => ({
  waitForRateLimitSlot: vi.fn().mockResolvedValue(undefined),
  waitForBurstRateLimitSlot: vi.fn().mockResolvedValue(undefined),
  consumeRestoreQuota: vi.fn(() => false),
  typedHandle: (channel: string, handler: (...a: unknown[]) => unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) => handler(...args));
    return () => {};
  },
  typedHandleWithContext: (channel: string, handler: (...a: unknown[]) => unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      handler({ projectId: null }, ...args)
    );
    return () => {};
  },
  typedHandleValidated: (
    channel: string,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
    handler: (payload: unknown) => unknown
  ) => {
    ipcMainMock.handle(channel, async (_e: unknown, ...args: unknown[]) => {
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success) throw new Error(`IPC validation failed: ${channel}`);
      return handler(parsed.data);
    });
    return () => {};
  },
  typedHandleWithContextValidated: (
    channel: string,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
    handler: (ctx: unknown, payload: unknown) => unknown
  ) => {
    ipcMainMock.handle(channel, async (_e: unknown, ...args: unknown[]) => {
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success) throw new Error(`IPC validation failed: ${channel}`);
      return handler({ projectId: null }, parsed.data);
    });
    return () => {};
  },
}));

import { registerTerminalLifecycleHandlers } from "../lifecycle.js";

const agentInfo = {
  id: "term-1",
  launchAgentId: "claude",
  worktreeId: "wt-1",
  title: "Claude",
  lastObservedTitle: "fix auth",
  titleMode: "default" as const,
  projectId: "proj-1",
  cwd: "/repo/feature",
  agentLaunchFlags: ["--resume"],
  agentModelId: "claude-opus-4-8",
};

let ptyClient: {
  getTerminalAsync: ReturnType<typeof vi.fn>;
  gracefulKill: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};
let worktreeService: { getMonitorAsync: ReturnType<typeof vi.fn> };

function register() {
  registerTerminalLifecycleHandlers({
    ptyClient,
    worktreeService,
  } as unknown as HandlerDependencies);
}

function handlerFor(channel: string): Handler {
  const call = ipcMainMock.handle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as Handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.currentGeneration.mockReturnValue(1);
  m.isCurrent.mockReturnValue(true);
  ptyClient = { getTerminalAsync: vi.fn(), gracefulKill: vi.fn(), kill: vi.fn() };
  worktreeService = { getMonitorAsync: vi.fn().mockResolvedValue({ branch: "feature/foo" }) };
});

describe("prepareBookmark handler", () => {
  it("captures, journals with bookmark intent, and returns the durable record", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    const record = { sessionId: "sess-abc", bookmark: { bookmarkedAt: 1, label: "L" } };
    m.journalAgentSessionRecord.mockResolvedValue(record);
    register();

    const result = await handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)(
      {},
      {
        terminalId: "term-1",
        label: "L",
      }
    );

    expect(ptyClient.gracefulKill).toHaveBeenCalledWith("term-1");
    const [journaled, ctx] = m.journalAgentSessionRecord.mock.calls[0];
    expect(journaled.sessionId).toBe("sess-abc");
    expect(journaled.bookmark).toMatchObject({ label: "L" });
    expect(journaled.branch).toBe("feature/foo");
    expect(ctx).toEqual({ terminalId: "term-1", generation: 1 });
    expect(result).toEqual({ record });
  });

  it("rejects NOT_BOOKMARKABLE for a non-agent terminal", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue({ id: "term-9", cwd: "/repo" });
    register();
    await expect(
      handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)({}, { terminalId: "term-9", label: "L" })
    ).rejects.toMatchObject({ code: "NOT_BOOKMARKABLE" });
    expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
  });

  it("rejects NOT_BOOKMARKABLE for an agent without exact-session resume", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue({ ...agentInfo, launchAgentId: "rolling" });
    register();
    await expect(
      handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)({}, { terminalId: "term-1", label: "L" })
    ).rejects.toMatchObject({ code: "NOT_BOOKMARKABLE" });
    expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
  });

  it("rejects SESSION_CAPTURE_FAILED when no session id is captured", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue(null);
    register();
    await expect(
      handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)({}, { terminalId: "term-1", label: "L" })
    ).rejects.toMatchObject({ code: "SESSION_CAPTURE_FAILED" });
    expect(m.journalAgentSessionRecord).not.toHaveBeenCalled();
  });

  it("rejects STALE_GENERATION and never journals when a successor appears during capture", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    m.isCurrent.mockReturnValue(false); // a successor took the id
    register();
    await expect(
      handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)({}, { terminalId: "term-1", label: "L" })
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
    expect(m.journalAgentSessionRecord).not.toHaveBeenCalled();
  });

  it("rejects PERSIST_FAILED when the journal write throws", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    m.journalAgentSessionRecord.mockRejectedValue(new Error("disk gone"));
    register();
    await expect(
      handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)({}, { terminalId: "term-1", label: "L" })
    ).rejects.toMatchObject({ code: "PERSIST_FAILED" });
  });

  it("rejects PERSIST_FAILED (not a mismatched promote) when the journal was already claimed", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    m.journalAgentSessionRecord.mockResolvedValue(null); // duplicate generation
    register();
    await expect(
      handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)({}, { terminalId: "term-1", label: "L" })
    ).rejects.toMatchObject({ code: "PERSIST_FAILED" });
    expect(m.promoteBookmark).not.toHaveBeenCalled();
  });

  it("freezes an evicted generation as null (not undefined) so it can't reserve a successor's slot", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    m.currentGeneration.mockReturnValue(undefined); // ledger evicted the entry
    const record = { sessionId: "sess-abc", bookmark: { bookmarkedAt: 1, label: "L" } };
    m.journalAgentSessionRecord.mockResolvedValue(record);
    register();

    const result = await handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)(
      {},
      { terminalId: "term-1", label: "L" }
    );

    // The frozen-but-unknown sentinel is null (#11340) — never undefined.
    expect(m.journalAgentSessionRecord.mock.calls[0][1]).toEqual({
      terminalId: "term-1",
      generation: null,
    });
    // isCurrent is never consulted when the generation is unknown.
    expect(m.isCurrent).not.toHaveBeenCalled();
    expect(result).toEqual({ record });
  });

  it("rejects STALE_GENERATION when a successor appears AFTER the journal write", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    m.journalAgentSessionRecord.mockResolvedValue({ sessionId: "sess-abc" });
    // Pre-capture recheck passes; the successor lands during the journal write.
    m.isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);
    register();

    await expect(
      handlerFor(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK)({}, { terminalId: "term-1", label: "L" })
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
    // The record was journaled (for the old session) but the pane is NOT removed
    // by the caller because prepareBookmark rejected.
    expect(m.journalAgentSessionRecord).toHaveBeenCalledTimes(1);
  });
});

describe("bookmark mutator handlers", () => {
  it("promote returns the record, maps null to SESSION_NOT_FOUND and a throw to PERSIST_FAILED", async () => {
    register();
    const promote = handlerFor(CHANNELS.AGENT_SESSION_PROMOTE_BOOKMARK);

    m.promoteBookmark.mockResolvedValueOnce({
      sessionId: "s1",
      bookmark: { bookmarkedAt: 1, label: "L" },
    });
    await expect(promote({}, { sessionId: "s1", label: "L" })).resolves.toMatchObject({
      sessionId: "s1",
    });

    m.promoteBookmark.mockResolvedValueOnce(null);
    await expect(promote({}, { sessionId: "missing", label: "L" })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

    m.promoteBookmark.mockRejectedValueOnce(new Error("io"));
    await expect(promote({}, { sessionId: "s1", label: "L" })).rejects.toMatchObject({
      code: "PERSIST_FAILED",
    });
  });

  it("rename returns the record, maps null to SESSION_NOT_FOUND and a throw to PERSIST_FAILED", async () => {
    register();
    const rename = handlerFor(CHANNELS.AGENT_SESSION_RENAME_BOOKMARK);

    m.renameBookmark.mockResolvedValueOnce({
      sessionId: "s1",
      bookmark: { bookmarkedAt: 1, label: "R" },
    });
    await expect(rename({}, { sessionId: "s1", label: "R" })).resolves.toMatchObject({
      sessionId: "s1",
    });

    m.renameBookmark.mockResolvedValueOnce(null);
    await expect(rename({}, { sessionId: "missing", label: "R" })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

    m.renameBookmark.mockRejectedValueOnce(new Error("io"));
    await expect(rename({}, { sessionId: "s1", label: "R" })).rejects.toMatchObject({
      code: "PERSIST_FAILED",
    });
  });

  it("delete maps false to SESSION_NOT_FOUND and a throw to PERSIST_FAILED", async () => {
    register();
    const del = handlerFor(CHANNELS.AGENT_SESSION_DELETE_BOOKMARK);

    m.deleteBookmark.mockResolvedValueOnce(true);
    await expect(del({}, { sessionId: "s1" })).resolves.toBeUndefined();

    m.deleteBookmark.mockResolvedValueOnce(false);
    await expect(del({}, { sessionId: "missing" })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

    m.deleteBookmark.mockRejectedValueOnce(new Error("io"));
    await expect(del({}, { sessionId: "s1" })).rejects.toMatchObject({ code: "PERSIST_FAILED" });
  });
});
