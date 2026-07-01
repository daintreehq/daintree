import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  persistAgentSession,
  readSessionHistory,
  listAgentSessions,
  clearAgentSessions,
  pruneAgentSessions,
  getSessionHistoryPath,
  MAX_RECORDS_PER_WORKTREE,
  SESSION_HISTORY_TTL_MS,
} from "../agentSessionHistory.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedRecordAged(
  userDataDir: string,
  sessionId: string,
  ageMs: number
): Promise<void> {
  const filePath = getSessionHistoryPath(userDataDir)!;
  const existing = await readSessionHistory(userDataDir);
  const record = {
    sessionId,
    agentId: "claude",
    worktreeId: "wt-1",
    title: null,
    projectId: null,
    savedAt: Date.now() - ageMs,
  };
  await import("node:fs/promises").then((fsp) =>
    fsp.writeFile(filePath, JSON.stringify([record, ...existing]))
  );
}

describe("agentSessionHistory", () => {
  let userDataDir: string;
  const previousUserData = process.env.DAINTREE_USER_DATA;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-session-history-"));
    process.env.DAINTREE_USER_DATA = userDataDir;
  });

  afterEach(async () => {
    process.env.DAINTREE_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  it("returns null path when DAINTREE_USER_DATA is not set", () => {
    delete process.env.DAINTREE_USER_DATA;
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

  it("strips a legacy snapshot key on read and purges it on the next rewrite", async () => {
    // A journal written while the removed exit-snapshot feature was enabled
    // still carries a `snapshot` tail on disk (#10850/#10855). It must never
    // reach a consumer, and must self-heal off disk on the next write.
    const filePath = getSessionHistoryPath(userDataDir)!;
    const legacy = {
      sessionId: "legacy",
      agentId: "claude",
      worktreeId: "wt-1",
      title: null,
      projectId: null,
      savedAt: Date.now(),
      snapshot: "verbatim scrollback that must not resurface",
    };
    await fsp.writeFile(filePath, JSON.stringify([legacy]));

    // Read strips it (guards the MCP list bulk-leak path)...
    const afterRead = await readSessionHistory(userDataDir);
    expect(afterRead).toHaveLength(1);
    expect(afterRead[0]).not.toHaveProperty("snapshot");
    expect(afterRead[0].sessionId).toBe("legacy");

    // ...and a subsequent persist rewrites the file without the key.
    await persistAgentSession(
      { sessionId: "fresh", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );
    const onDisk = JSON.parse(await fsp.readFile(filePath, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(onDisk.some((r) => "snapshot" in r)).toBe(false);
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

  it("round-trips cwd and branch", async () => {
    await persistAgentSession(
      {
        sessionId: "with-meta",
        agentId: "claude",
        worktreeId: "wt-1",
        title: null,
        projectId: null,
        cwd: "/repo/worktrees/feature",
        branch: "feature/foo",
      },
      userDataDir
    );

    const records = await readSessionHistory(userDataDir);
    expect(records).toHaveLength(1);
    expect(records[0].cwd).toBe("/repo/worktrees/feature");
    expect(records[0].branch).toBe("feature/foo");
  });

  it("preserves all records under concurrent writes (no lost update)", async () => {
    const N = 25;
    // Fire all writes without awaiting between them — the serial queue must
    // prevent the read-modify-write from dropping records.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        persistAgentSession(
          {
            sessionId: `concurrent-${i}`,
            agentId: "claude",
            // Spread across worktrees so the per-worktree cap can't evict any.
            worktreeId: `wt-${i}`,
            title: null,
            projectId: null,
          },
          userDataDir
        )
      )
    );

    const records = await readSessionHistory(userDataDir);
    const ids = new Set(records.map((r) => r.sessionId));
    expect(ids.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(ids.has(`concurrent-${i}`)).toBe(true);
    }
  });

  it("deduplicates on sessionId, keeping the newest record", async () => {
    await persistAgentSession(
      {
        sessionId: "dup",
        agentId: "claude",
        worktreeId: "wt-1",
        title: "old title",
        projectId: null,
        branch: "old-branch",
      },
      userDataDir
    );
    await persistAgentSession(
      {
        sessionId: "dup",
        agentId: "claude",
        worktreeId: "wt-1",
        title: "new title",
        projectId: null,
        branch: "new-branch",
      },
      userDataDir
    );

    const records = await readSessionHistory(userDataDir);
    const dups = records.filter((r) => r.sessionId === "dup");
    expect(dups).toHaveLength(1);
    expect(dups[0].title).toBe("new title");
    expect(dups[0].branch).toBe("new-branch");
  });

  it("keeps old records that predate the cwd/branch fields", async () => {
    const filePath = getSessionHistoryPath(userDataDir)!;
    const legacyRecord = {
      sessionId: "legacy",
      agentId: "claude",
      worktreeId: "wt-1",
      title: null,
      projectId: null,
      savedAt: Date.now() - 1000,
    };
    await fsp.writeFile(filePath, JSON.stringify([legacyRecord]));

    await persistAgentSession(
      {
        sessionId: "fresh",
        agentId: "claude",
        worktreeId: "wt-1",
        title: null,
        projectId: null,
        cwd: "/repo",
        branch: "main",
      },
      userDataDir
    );

    const records = await readSessionHistory(userDataDir);
    const legacy = records.find((r) => r.sessionId === "legacy");
    expect(legacy).toBeDefined();
    expect(legacy?.cwd).toBeUndefined();
    expect(legacy?.branch).toBeUndefined();
  });

  describe("configurable retention", () => {
    it("persist evicts records older than the given retention window", async () => {
      // 20-day-old record; a 7-day retention window on the next persist drops it.
      await seedRecordAged(userDataDir, "aged-20d", 20 * DAY_MS);
      await persistAgentSession(
        { sessionId: "fresh", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
        userDataDir,
        7
      );

      const records = await readSessionHistory(userDataDir);
      expect(records.map((r) => r.sessionId)).toEqual(["fresh"]);
    });

    it("persist with a longer window keeps records the default would evict", async () => {
      // 45-day-old record survives a 90-day window (would be dropped by the 30-day default).
      await seedRecordAged(userDataDir, "aged-45d", 45 * DAY_MS);
      await persistAgentSession(
        { sessionId: "fresh", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
        userDataDir,
        90
      );

      const ids = new Set((await readSessionHistory(userDataDir)).map((r) => r.sessionId));
      expect(ids.has("aged-45d")).toBe(true);
      expect(ids.has("fresh")).toBe(true);
    });

    it("retention 0 (keep forever) never evicts by age", async () => {
      await seedRecordAged(userDataDir, "ancient", 500 * DAY_MS);
      await persistAgentSession(
        { sessionId: "fresh", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
        userDataDir,
        0
      );

      const ids = new Set((await readSessionHistory(userDataDir)).map((r) => r.sessionId));
      expect(ids.has("ancient")).toBe(true);
    });

    it("listAgentSessions honors the retention window", async () => {
      await seedRecordAged(userDataDir, "aged-20d", 20 * DAY_MS);
      await persistAgentSession(
        { sessionId: "fresh", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
        userDataDir,
        0 // keep-forever on write so the read path is what does the filtering
      );

      expect(listAgentSessions(undefined, userDataDir, 7).map((r) => r.sessionId)).toEqual([
        "fresh",
      ]);
      expect(
        new Set(listAgentSessions(undefined, userDataDir, 90).map((r) => r.sessionId))
      ).toEqual(new Set(["fresh", "aged-20d"]));
    });

    it("pruneAgentSessions immediately drops records past the window", async () => {
      await seedRecordAged(userDataDir, "aged-20d", 20 * DAY_MS);
      await seedRecordAged(userDataDir, "aged-3d", 3 * DAY_MS);

      await pruneAgentSessions(7, userDataDir);

      const records = await readSessionHistory(userDataDir);
      expect(records.map((r) => r.sessionId)).toEqual(["aged-3d"]);
    });

    it("pruneAgentSessions with 0 keeps everything", async () => {
      await seedRecordAged(userDataDir, "ancient", 500 * DAY_MS);
      await pruneAgentSessions(0, userDataDir);
      const records = await readSessionHistory(userDataDir);
      expect(records.map((r) => r.sessionId)).toEqual(["ancient"]);
    });

    it("keep-forever (0) still enforces the per-worktree cap", async () => {
      // The pty-host trash-expiry path persists with retentionDays=0 (no store
      // access). This proves that even without age-eviction, growth is bounded
      // at MAX_RECORDS_PER_WORKTREE — the guarantee that makes that safe.
      for (let i = 0; i < MAX_RECORDS_PER_WORKTREE + 10; i++) {
        await persistAgentSession(
          {
            sessionId: `session-${i}`,
            agentId: "claude",
            worktreeId: "wt-1",
            title: null,
            projectId: null,
          },
          userDataDir,
          0
        );
      }
      const records = await readSessionHistory(userDataDir);
      expect(records).toHaveLength(MAX_RECORDS_PER_WORKTREE);
      // Newest survive: the last-written session must be present.
      expect(records.some((r) => r.sessionId === `session-${MAX_RECORDS_PER_WORKTREE + 9}`)).toBe(
        true
      );
    });
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
