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

    expect(result).toEqual({ confirmed: true, terminalsKilled: 3 });
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

    await expect(gracefulTeardownAndJournalProject("proj", client)).resolves.toEqual({
      confirmed: true,
      terminalsKilled: 2,
    });
    expect(journalMock.journalAgentSession).toHaveBeenCalledTimes(2);
  });

  it("passes an unconfirmed outcome through without journaling", async () => {
    const { client } = makePtyClient({
      terminals: [
        { id: "t1", projectId: "proj", launchAgentId: "claude", cwd: "/a", spawnedAt: 1 },
      ],
      outcome: { confirmed: false, sessions: [] },
    });

    const result = await gracefulTeardownAndJournalProject("proj", client);

    expect(result).toEqual({ confirmed: false, terminalsKilled: 0 });
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

    expect(result).toEqual({ confirmed: true, terminalsKilled: 0 });
    expect(journalMock.journalAgentSession).not.toHaveBeenCalled();
  });

  it("survives a failed terminal snapshot (best-effort) and still reports the kill", async () => {
    const { client } = makePtyClient({
      terminals: () => Promise.reject(new Error("host unreachable")),
      outcome: { confirmed: true, sessions: [{ id: "t1", agentSessionId: "s1" }] },
    });

    const result = await gracefulTeardownAndJournalProject("proj", client);

    // Info is absent, so nothing is journaled — but the kill outcome is honored.
    expect(result).toEqual({ confirmed: true, terminalsKilled: 1 });
    expect(journalMock.journalAgentSession).not.toHaveBeenCalled();
  });
});
