import { describe, it, expect, vi, beforeEach } from "vitest";

const journalMock = vi.hoisted(() => ({
  journalAgentSession: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
}));
vi.mock("../agentSessionJournal.js", () => journalMock);

const ledgerMock = vi.hoisted(() => ({
  currentGeneration: vi.fn<(id: string) => number | undefined>(),
}));
vi.mock("../lifecycleLedger.js", () => ({
  getLifecycleLedger: () => ledgerMock,
}));

// The helper writes captured session ids back through the project store when
// asked. Mocked wholesale: the real module opens the SQLite-backed store at
// import time, which a node-environment unit suite has no business booting.
const projectStoreMock = vi.hoisted(() => ({
  enqueueProjectStateUpdate:
    vi.fn<(id: string, updater: (state: unknown) => unknown) => Promise<void>>(),
}));
vi.mock("../../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

// The assistant-terminal predicate falls back to this store for records that
// predate the spawn-time stamp; faked so both of its branches are exercised.
vi.mock("../../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: (id: string) => id === "marked-help" }),
}));

import { gracefulTeardownAndJournalProject } from "../projectSessionJournal.js";
import type { PtyClient } from "../../PtyClient.js";
import type { WorkspaceClient } from "../../WorkspaceClient.js";

interface FakeTerminal {
  id: string;
  projectId?: string;
  launchAgentId?: string;
  worktreeId?: string;
  title?: string;
  titleMode?: string;
  lastObservedTitle?: string;
  cwd: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  isAssistantTerminal?: boolean;
  spawnedAt: number;
}

function makePtyClient(config: {
  terminals?: FakeTerminal[] | (() => Promise<FakeTerminal[]>);
  outcome: { confirmed: boolean; sessions: Array<{ id: string; agentSessionId: string | null }> };
}): { client: PtyClient; gracefulKillByProjectConfirmed: ReturnType<typeof vi.fn> } {
  const gracefulKillByProjectConfirmed = vi.fn(async () => config.outcome);
  const getAllTerminalsAsync = vi.fn(async () =>
    typeof config.terminals === "function" ? await config.terminals() : (config.terminals ?? [])
  );
  const client = {
    getAllTerminalsAsync,
    gracefulKillByProjectConfirmed,
  } as unknown as PtyClient;
  return { client, gracefulKillByProjectConfirmed };
}

function makeWorkspaceClient(branchByWorktree: Record<string, string | null>): WorkspaceClient {
  return {
    getMonitorAsync: vi.fn(async (wid: string) => {
      const branch = branchByWorktree[wid];
      return branch === undefined ? null : { branch };
    }),
  } as unknown as WorkspaceClient;
}

describe("gracefulTeardownAndJournalProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    journalMock.journalAgentSession.mockResolvedValue(true);
    ledgerMock.currentGeneration.mockReturnValue(undefined);
    projectStoreMock.enqueueProjectStateUpdate.mockResolvedValue(undefined);
  });

  it("journals only in-scope agent terminals with a captured session", async () => {
    const { client } = makePtyClient({
      terminals: [
        { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
        // non-agent: no launchAgentId
        { id: "t2", projectId: "proj", cwd: "/b", spawnedAt: 1 },
        // other project: filtered out at snapshot
        { id: "t3", projectId: "other", launchAgentId: "claude", cwd: "/c", spawnedAt: 1 },
      ],
      outcome: {
        confirmed: true,
        sessions: [
          { id: "t1", agentSessionId: "s1" },
          { id: "t2", agentSessionId: null },
          { id: "t3", agentSessionId: "s3" },
        ],
      },
    });

    const result = await gracefulTeardownAndJournalProject("proj", client);

    expect(result).toMatchObject({ confirmed: true, terminalsKilled: 3 });
    expect(journalMock.journalAgentSession).toHaveBeenCalledTimes(1);
    const [record, ctx] = journalMock.journalAgentSession.mock.calls[0]!;
    expect(record).toMatchObject({ sessionId: "s1", agentId: "claude", projectId: "proj" });
    expect(ctx).toMatchObject({ terminalId: "t1" });
  });

  it("freezes each terminal's generation before the kill and passes it to the journal", async () => {
    ledgerMock.currentGeneration.mockReturnValue(7);
    const { client, gracefulKillByProjectConfirmed } = makePtyClient({
      terminals: [
        { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
      ],
      outcome: { confirmed: true, sessions: [{ id: "t1", agentSessionId: "s1" }] },
    });

    await gracefulTeardownAndJournalProject("proj", client);

    const genOrder = ledgerMock.currentGeneration.mock.invocationCallOrder[0]!;
    const killOrder = gracefulKillByProjectConfirmed.mock.invocationCallOrder[0]!;
    expect(genOrder).toBeLessThan(killOrder);

    const [, ctx] = journalMock.journalAgentSession.mock.calls[0]!;
    expect(ctx).toEqual({ terminalId: "t1", generation: 7 });
  });

  it("passes an explicit null generation when the ledger has evicted the entry", async () => {
    // Bounded LRU can evict a live agent terminal → currentGeneration is
    // undefined at freeze. The helper must send null (frozen-unknown), not
    // undefined, so the funnel fails open instead of re-reading a respawn (#11340).
    ledgerMock.currentGeneration.mockReturnValue(undefined);
    const { client } = makePtyClient({
      terminals: [
        { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
      ],
      outcome: { confirmed: true, sessions: [{ id: "t1", agentSessionId: "s1" }] },
    });

    await gracefulTeardownAndJournalProject("proj", client);

    const [, ctx] = journalMock.journalAgentSession.mock.calls[0]!;
    expect(ctx).toEqual({ terminalId: "t1", generation: null });
  });

  it("prefers the observed title unless a user title lock is set", async () => {
    const { client } = makePtyClient({
      terminals: [
        {
          id: "t1",
          projectId: "proj",
          launchAgentId: "claude",
          title: "typed",
          lastObservedTitle: "observed",
          titleMode: "auto",
          cwd: "/a",
          spawnedAt: 1,
        },
        {
          id: "t2",
          projectId: "proj",
          launchAgentId: "claude",
          title: "locked",
          lastObservedTitle: "observed2",
          titleMode: "user",
          cwd: "/b",
          spawnedAt: 1,
        },
      ],
      outcome: {
        confirmed: true,
        sessions: [
          { id: "t1", agentSessionId: "s1" },
          { id: "t2", agentSessionId: "s2" },
        ],
      },
    });

    await gracefulTeardownAndJournalProject("proj", client);

    const byId = new Map(
      journalMock.journalAgentSession.mock.calls.map((c) => [
        (c[0] as { sessionId: string }).sessionId,
        c[0] as { title: string | null },
      ])
    );
    expect(byId.get("s1")?.title).toBe("observed");
    expect(byId.get("s2")?.title).toBe("locked");
  });

  it("resolves a worktree branch and ignores HEAD", async () => {
    const { client } = makePtyClient({
      terminals: [
        {
          id: "t1",
          projectId: "proj",
          launchAgentId: "claude",
          worktreeId: "w1",
          cwd: "/a",
          spawnedAt: 1,
        },
        {
          id: "t2",
          projectId: "proj",
          launchAgentId: "claude",
          worktreeId: "w2",
          cwd: "/b",
          spawnedAt: 1,
        },
      ],
      outcome: {
        confirmed: true,
        sessions: [
          { id: "t1", agentSessionId: "s1" },
          { id: "t2", agentSessionId: "s2" },
        ],
      },
    });
    const workspaceClient = makeWorkspaceClient({ w1: "feature/x", w2: "HEAD" });

    await gracefulTeardownAndJournalProject("proj", client, workspaceClient);

    const byId = new Map(
      journalMock.journalAgentSession.mock.calls.map((c) => [
        (c[0] as { sessionId: string }).sessionId,
        c[0] as { branch?: string },
      ])
    );
    expect(byId.get("s1")?.branch).toBe("feature/x");
    expect(byId.get("s2")?.branch).toBeUndefined();
  });

  it("isolates a per-record journal failure so the rest still journal", async () => {
    journalMock.journalAgentSession
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(true);
    const { client } = makePtyClient({
      terminals: [
        { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
        { id: "t2", projectId: "proj", launchAgentId: "claude", cwd: "/b", spawnedAt: 1 },
      ],
      outcome: {
        confirmed: true,
        sessions: [
          { id: "t1", agentSessionId: "s1" },
          { id: "t2", agentSessionId: "s2" },
        ],
      },
    });

    await expect(gracefulTeardownAndJournalProject("proj", client)).resolves.toMatchObject({
      confirmed: true,
      terminalsKilled: 2,
    });
    expect(journalMock.journalAgentSession).toHaveBeenCalledTimes(2);
    // The second session must genuinely be journaled — not the first retried.
    const journaledIds = journalMock.journalAgentSession.mock.calls.map(
      (c) => (c[0] as { sessionId: string }).sessionId
    );
    expect(journaledIds).toEqual(expect.arrayContaining(["s1", "s2"]));
  });

  it("journals without a branch when the worktree lookup hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makePtyClient({
        terminals: [
          {
            id: "t1",
            projectId: "proj",
            launchAgentId: "claude",
            worktreeId: "w1",
            cwd: "/a",
            spawnedAt: 1,
          },
        ],
        outcome: { confirmed: true, sessions: [{ id: "t1", agentSessionId: "s1" }] },
      });
      // getMonitorAsync never resolves — the 200ms race timer must win.
      const workspaceClient = {
        getMonitorAsync: vi.fn(() => new Promise(() => {})),
      } as unknown as WorkspaceClient;

      const promise = gracefulTeardownAndJournalProject("proj", client, workspaceClient);
      await vi.advanceTimersByTimeAsync(250);

      await expect(promise).resolves.toMatchObject({ confirmed: true, terminalsKilled: 1 });
      const [record] = journalMock.journalAgentSession.mock.calls[0]!;
      expect((record as { branch?: string }).branch).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaits each journal write before resolving (not fire-and-forget)", async () => {
    let resolveJournal: (v: boolean) => void = () => {};
    journalMock.journalAgentSession.mockReturnValue(
      new Promise<boolean>((res) => {
        resolveJournal = res;
      })
    );
    const { client } = makePtyClient({
      terminals: [
        { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
      ],
      outcome: { confirmed: true, sessions: [{ id: "t1", agentSessionId: "s1" }] },
    });

    let settled = false;
    const promise = gracefulTeardownAndJournalProject("proj", client).then((r) => {
      settled = true;
      return r;
    });

    // Drain all microtasks — the helper should be parked on the pending journal.
    await new Promise((r) => setImmediate(r));
    expect(journalMock.journalAgentSession).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    resolveJournal(true);
    await expect(promise).resolves.toMatchObject({ confirmed: true, terminalsKilled: 1 });
    expect(settled).toBe(true);
  });

  it("passes an unconfirmed outcome through without journaling", async () => {
    const { client } = makePtyClient({
      terminals: [
        { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
      ],
      outcome: { confirmed: false, sessions: [] },
    });

    const result = await gracefulTeardownAndJournalProject("proj", client);

    expect(result).toMatchObject({ confirmed: false, terminalsKilled: 0 });
    expect(journalMock.journalAgentSession).not.toHaveBeenCalled();
  });

  it("returns confirmed with nothing to journal when the host was already gone", async () => {
    const { client } = makePtyClient({
      terminals: [
        { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
      ],
      outcome: { confirmed: true, sessions: [] },
    });

    const result = await gracefulTeardownAndJournalProject("proj", client);

    expect(result).toMatchObject({ confirmed: true, terminalsKilled: 0 });
    expect(journalMock.journalAgentSession).not.toHaveBeenCalled();
  });

  it("survives a failed terminal snapshot (best-effort) and still reports the kill", async () => {
    const { client } = makePtyClient({
      terminals: () => Promise.reject(new Error("host unreachable")),
      outcome: { confirmed: true, sessions: [{ id: "t1", agentSessionId: "s1" }] },
    });

    const result = await gracefulTeardownAndJournalProject("proj", client);

    // Info is absent, so nothing is journaled — but the kill outcome is honored.
    expect(result).toMatchObject({ confirmed: true, terminalsKilled: 1 });
    expect(journalMock.journalAgentSession).not.toHaveBeenCalled();
  });

  describe("teardown options", () => {
    function agentClient(sessions: Array<{ id: string; agentSessionId: string | null }>) {
      return makePtyClient({
        terminals: sessions.map((s) => ({
          id: s.id,
          projectId: "proj",
          launchAgentId: "claude",
          cwd: `/${s.id}`,
          spawnedAt: 1,
        })),
        outcome: { confirmed: true, sessions },
      });
    }

    it("leaves the kill unqualified when no preserveSession preference is given", async () => {
      // Close/remove must keep deleting the session files they orphan; only an
      // explicit opt-in may change what the host does with them.
      const { client, gracefulKillByProjectConfirmed } = agentClient([
        { id: "t1", agentSessionId: "s1" },
      ]);

      await gracefulTeardownAndJournalProject("proj", client);

      expect(gracefulKillByProjectConfirmed).toHaveBeenCalledWith("proj", undefined);
    });

    it("threads preserveSession through to the kill", async () => {
      const { client, gracefulKillByProjectConfirmed } = agentClient([
        { id: "t1", agentSessionId: "s1" },
      ]);

      await gracefulTeardownAndJournalProject("proj", client, undefined, {
        preserveSession: true,
      });

      expect(gracefulKillByProjectConfirmed).toHaveBeenCalledWith("proj", {
        preserveSession: true,
      });
    });

    it("returns the killed terminals so the caller can act per terminal", async () => {
      // Sleep writes one hibernation marker per terminal off this list.
      const sessions = [
        { id: "t1", agentSessionId: "s1" },
        { id: "t2", agentSessionId: null },
      ];
      const { client } = agentClient(sessions);

      const result = await gracefulTeardownAndJournalProject("proj", client);

      expect(result.sessions).toEqual(sessions);
    });

    it("does not touch saved state unless the writeback is requested", async () => {
      const { client } = agentClient([{ id: "t1", agentSessionId: "s1" }]);

      await gracefulTeardownAndJournalProject("proj", client);

      expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
    });

    it("writes captured ids into the matching saved snapshots only", async () => {
      const { client } = agentClient([
        { id: "t1", agentSessionId: "s1" },
        // No id captured — must not blank an existing one.
        { id: "t2", agentSessionId: null },
      ]);

      await gracefulTeardownAndJournalProject("proj", client, undefined, {
        writeBackSessionIds: true,
      });

      expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalledTimes(1);
      const [scopeId, updater] = projectStoreMock.enqueueProjectStateUpdate.mock.calls[0]!;
      expect(scopeId).toBe("proj");

      const state = {
        terminals: [
          { id: "t1", agentSessionId: undefined },
          { id: "t2", agentSessionId: "previous" },
          { id: "unrelated", agentSessionId: "keep" },
        ],
      };
      expect(updater(state)).toBe(state);
      expect(state.terminals).toEqual([
        { id: "t1", agentSessionId: "s1" },
        { id: "t2", agentSessionId: "previous" },
        { id: "unrelated", agentSessionId: "keep" },
      ]);
    });

    it("skips the write entirely when nothing was captured", async () => {
      const { client } = agentClient([{ id: "t1", agentSessionId: null }]);

      await gracefulTeardownAndJournalProject("proj", client, undefined, {
        writeBackSessionIds: true,
      });

      expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
    });

    it("bails out of the updater when the scope has no saved terminals", async () => {
      const { client } = agentClient([{ id: "t1", agentSessionId: "s1" }]);

      await gracefulTeardownAndJournalProject("proj", client, undefined, {
        writeBackSessionIds: true,
      });

      const [, updater] = projectStoreMock.enqueueProjectStateUpdate.mock.calls[0]!;
      expect(updater(null)).toBeNull();
      expect(updater({})).toBeNull();
    });

    it("waits for the writeback to land before journaling", async () => {
      // Comparing invocation order would still pass if the writeback were fired
      // without being awaited, which is the bug worth catching: the snapshot and
      // the journal are the two halves of a resume and must not interleave.
      let releaseWriteback!: () => void;
      projectStoreMock.enqueueProjectStateUpdate.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseWriteback = resolve;
        })
      );
      const { client } = agentClient([{ id: "t1", agentSessionId: "s1" }]);

      const pending = gracefulTeardownAndJournalProject("proj", client, undefined, {
        writeBackSessionIds: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalled();
      expect(journalMock.journalAgentSession).not.toHaveBeenCalled();

      releaseWriteback();
      await pending;

      expect(journalMock.journalAgentSession).toHaveBeenCalledTimes(1);
    });

    it("still journals when the writeback throws", async () => {
      // Best-effort, exactly as shutdown behaves: losing the in-place resume
      // must not also cost the picker's resume record.
      projectStoreMock.enqueueProjectStateUpdate.mockRejectedValue(new Error("disk full"));
      const { client } = agentClient([{ id: "t1", agentSessionId: "s1" }]);

      const result = await gracefulTeardownAndJournalProject("proj", client, undefined, {
        writeBackSessionIds: true,
      });

      expect(result.confirmed).toBe(true);
      expect(journalMock.journalAgentSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("the assistant's overlay terminal", () => {
    it("journals neither the record nor the session-id writeback for it", async () => {
      // #12183: a sleep used to journal the assistant as an ordinary
      // AgentSessionRecord, and after a sleep it is usually the newest one —
      // so the empty-grid resume line offered to reopen the assistant's
      // conversation as a grid pane running the underlying CLI.
      const { client } = makePtyClient({
        terminals: [
          {
            id: "assistant",
            projectId: "proj",
            launchAgentId: "claude",
            isAssistantTerminal: true,
            cwd: "/root",
            spawnedAt: 1,
          },
          { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
        ],
        outcome: {
          confirmed: true,
          sessions: [
            { id: "assistant", agentSessionId: "assistant-session" },
            { id: "t1", agentSessionId: "s1" },
          ],
        },
      });

      await gracefulTeardownAndJournalProject("proj", client, undefined, {
        writeBackSessionIds: true,
      });

      // The ordinary pane beside it still journals — the skip is targeted, not
      // a blanket bail-out of the teardown's journaling.
      expect(journalMock.journalAgentSession).toHaveBeenCalledTimes(1);
      const [record] = journalMock.journalAgentSession.mock.calls[0]!;
      expect(record).toMatchObject({ sessionId: "s1" });

      const [, updater] = projectStoreMock.enqueueProjectStateUpdate.mock.calls[0]!;
      const state = {
        terminals: [
          { id: "assistant", agentSessionId: undefined },
          { id: "t1", agentSessionId: undefined },
        ],
      };
      updater(state);
      expect(state.terminals).toEqual([
        { id: "assistant", agentSessionId: undefined },
        { id: "t1", agentSessionId: "s1" },
      ]);
    });

    it("skips the writeback entirely when the assistant is the only capture", async () => {
      const { client } = makePtyClient({
        terminals: [
          {
            id: "assistant",
            projectId: "proj",
            launchAgentId: "claude",
            isAssistantTerminal: true,
            cwd: "/root",
            spawnedAt: 1,
          },
        ],
        outcome: { confirmed: true, sessions: [{ id: "assistant", agentSessionId: "a1" }] },
      });

      const result = await gracefulTeardownAndJournalProject("proj", client, undefined, {
        writeBackSessionIds: true,
      });

      expect(result.confirmed).toBe(true);
      expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
      expect(journalMock.journalAgentSession).not.toHaveBeenCalled();
    });

    it("still recognises a record marked only through the availability store", async () => {
      // Covers a terminal that predates the spawn-time stamp — adopted across
      // a pty-host restart, say — where the renderer's `help.markTerminal` is
      // the only signal there is.
      const { client } = makePtyClient({
        terminals: [
          {
            id: "marked-help",
            projectId: "proj",
            launchAgentId: "claude",
            cwd: "/r",
            spawnedAt: 1,
          },
        ],
        outcome: { confirmed: true, sessions: [{ id: "marked-help", agentSessionId: "s1" }] },
      });

      await gracefulTeardownAndJournalProject("proj", client);

      expect(journalMock.journalAgentSession).not.toHaveBeenCalled();
    });
  });
});
