import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  persistAgentSession,
  readSessionHistory,
  listAgentSessions,
  clearAgentSessions,
  getSessionHistoryPath,
  MAX_RECORDS_PER_WORKTREE,
  SESSION_HISTORY_TTL_MS,
} from "../agentSessionHistory.js";

describe("agentSessionHistory", () => {
  let userDataDir: string;
  const previousUserData = process.env.CANOPY_USER_DATA;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "canopy-session-history-"));
    process.env.CANOPY_USER_DATA = userDataDir;
  });

  afterEach(async () => {
    process.env.CANOPY_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  it("returns null path when CANOPY_USER_DATA is not set", () => {
    delete process.env.CANOPY_USER_DATA;
    expect(getSessionHistoryPath()).toBeNull();
  });

  it("returns correct path when userData is provided", () => {
    const p = getSessionHistoryPath("/tmp/test");
    expect(p).toBe(path.join("/tmp/test", "agent-session-history.json"));
  });

  it("returns empty array when no history file exists", async () => {
    const records = await readSessionHistory(userDataDir);
    expect(records).toEqual([]);
  });

  it("persists and reads a session record", async () => {
    await persistAgentSession(
      {
        sessionId: "abc-123",
        agentId: "claude",
        worktreeId: "wt-1",
        title: "Claude",
        projectId: "proj-1",
        agentLaunchFlags: ["--flag"],
        agentModelId: "claude-opus-4-6",
      },
      userDataDir
    );

    const records = await readSessionHistory(userDataDir);
    expect(records).toHaveLength(1);
    expect(records[0].sessionId).toBe("abc-123");
    expect(records[0].agentId).toBe("claude");
    expect(records[0].worktreeId).toBe("wt-1");
    expect(records[0].agentLaunchFlags).toEqual(["--flag"]);
    expect(records[0].savedAt).toBeGreaterThan(0);
  });

  it("prepends new records (newest first)", async () => {
    await persistAgentSession(
      { sessionId: "first", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );
    await persistAgentSession(
      { sessionId: "second", agentId: "gemini", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );

    const records = await readSessionHistory(userDataDir);
    expect(records).toHaveLength(2);
    expect(records[0].sessionId).toBe("second");
    expect(records[1].sessionId).toBe("first");
  });

  it("enforces per-worktree cap", async () => {
    for (let i = 0; i < MAX_RECORDS_PER_WORKTREE + 5; i++) {
      await persistAgentSession(
        {
          sessionId: `session-${i}`,
          agentId: "claude",
          worktreeId: "wt-1",
          title: null,
          projectId: null,
        },
        userDataDir
      );
    }

    const records = await readSessionHistory(userDataDir);
    const wt1Records = records.filter((r) => r.worktreeId === "wt-1");
    expect(wt1Records.length).toBeLessThanOrEqual(MAX_RECORDS_PER_WORKTREE);
  });

  it("does not evict records from other worktrees when one hits cap", async () => {
    // Add one record for wt-2
    await persistAgentSession(
      {
        sessionId: "wt2-session",
        agentId: "gemini",
        worktreeId: "wt-2",
        title: null,
        projectId: null,
      },
      userDataDir
    );

    // Fill wt-1 past cap
    for (let i = 0; i < MAX_RECORDS_PER_WORKTREE + 2; i++) {
      await persistAgentSession(
        {
          sessionId: `wt1-session-${i}`,
          agentId: "claude",
          worktreeId: "wt-1",
          title: null,
          projectId: null,
        },
        userDataDir
      );
    }

    const records = await readSessionHistory(userDataDir);
    const wt2Records = records.filter((r) => r.worktreeId === "wt-2");
    expect(wt2Records).toHaveLength(1);
    expect(wt2Records[0].sessionId).toBe("wt2-session");
  });

  it("evicts records older than TTL", async () => {
    // Write a record with an artificially old savedAt
    const filePath = getSessionHistoryPath(userDataDir)!;
    const oldRecord = {
      sessionId: "old",
      agentId: "claude",
      worktreeId: "wt-1",
      title: null,
      projectId: null,
      savedAt: Date.now() - SESSION_HISTORY_TTL_MS - 1000,
    };
    await fsp.writeFile(filePath, JSON.stringify([oldRecord]));

    // Persist a new record — this triggers eviction
    await persistAgentSession(
      { sessionId: "new", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );

    const records = await readSessionHistory(userDataDir);
    expect(records).toHaveLength(1);
    expect(records[0].sessionId).toBe("new");
  });

  it("listAgentSessions filters by worktreeId", async () => {
    await persistAgentSession(
      { sessionId: "s1", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );
    await persistAgentSession(
      { sessionId: "s2", agentId: "gemini", worktreeId: "wt-2", title: null, projectId: null },
      userDataDir
    );

    const wt1 = listAgentSessions("wt-1", userDataDir);
    expect(wt1).toHaveLength(1);
    expect(wt1[0].sessionId).toBe("s1");

    const all = listAgentSessions(undefined, userDataDir);
    expect(all).toHaveLength(2);
  });

  it("clearAgentSessions clears all sessions", async () => {
    await persistAgentSession(
      { sessionId: "s1", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );
    await clearAgentSessions(undefined, userDataDir);

    const records = await readSessionHistory(userDataDir);
    expect(records).toEqual([]);
  });

  it("clearAgentSessions clears only specified worktree", async () => {
    await persistAgentSession(
      { sessionId: "s1", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );
    await persistAgentSession(
      { sessionId: "s2", agentId: "gemini", worktreeId: "wt-2", title: null, projectId: null },
      userDataDir
    );
    await clearAgentSessions("wt-1", userDataDir);

    const records = await readSessionHistory(userDataDir);
    expect(records).toHaveLength(1);
    expect(records[0].worktreeId).toBe("wt-2");
  });

  it("handles corrupt JSON gracefully", async () => {
    const filePath = getSessionHistoryPath(userDataDir)!;
    await fsp.writeFile(filePath, "not json at all");

    const records = await readSessionHistory(userDataDir);
    expect(records).toEqual([]);

    // Can still persist after corruption
    await persistAgentSession(
      { sessionId: "recovery", agentId: "claude", worktreeId: null, title: null, projectId: null },
      userDataDir
    );
    const after = await readSessionHistory(userDataDir);
    expect(after).toHaveLength(1);
  });
});
