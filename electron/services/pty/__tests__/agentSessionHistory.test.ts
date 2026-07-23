import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  persistAgentSession,
  readSessionHistory,
  readSessionHistorySync,
  listAgentSessions,
  clearAgentSessions,
  pruneAgentSessions,
  promoteBookmark,
  renameBookmark,
  deleteBookmark,
  listBookmarks,
  getSessionHistoryPath,
  MAX_RECORDS_PER_WORKTREE,
  SESSION_HISTORY_TTL_MS,
} from "../agentSessionHistory.js";
import type {
  AgentSessionBookmarkMetadata,
  AgentSessionRecord,
} from "../../../../shared/types/ipc/agentSessionHistory.js";

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

  // chmod is a POSIX no-op on Windows, so the mode-bit assertions only run there.
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt("writes the history file owner-only across persist, prune, and clear", async () => {
    const filePath = getSessionHistoryPath(userDataDir)!;
    const base = {
      agentId: "claude",
      worktreeId: "wt-1",
      title: null,
      projectId: null,
    };

    await persistAgentSession({ ...base, sessionId: "s1" }, userDataDir);
    expect((await fsp.stat(filePath)).mode & 0o777).toBe(0o600);

    await pruneAgentSessions(30, userDataDir);
    expect((await fsp.stat(filePath)).mode & 0o777).toBe(0o600);

    // Worktree-filtered clear rewrites the file through a separate branch.
    await persistAgentSession({ ...base, sessionId: "s2", worktreeId: "wt-2" }, userDataDir);
    await clearAgentSessions("wt-1", userDataDir);
    expect((await fsp.stat(filePath)).mode & 0o777).toBe(0o600);

    await clearAgentSessions(undefined, userDataDir);
    expect((await fsp.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  posixIt("tightens a pre-existing world-readable parent directory (upgrade case)", async () => {
    await fsp.chmod(userDataDir, 0o755);

    await persistAgentSession(
      { agentId: "claude", worktreeId: "wt-1", title: null, projectId: null, sessionId: "s1" },
      userDataDir
    );

    expect((await fsp.stat(userDataDir)).mode & 0o777).toBe(0o700);
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

  it("clearAgentSessions rejects an empty-string worktreeId without wiping history", async () => {
    const filePath = getSessionHistoryPath(userDataDir)!;
    await persistAgentSession(
      { sessionId: "s1", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );
    await persistAgentSession(
      { sessionId: "s2", agentId: "gemini", worktreeId: "wt-2", title: null, projectId: null },
      userDataDir
    );
    const before = await fsp.readFile(filePath, "utf8");

    // An empty scope must NOT escalate to clear-all (#7880 fallback-default rule).
    await expect(clearAgentSessions("", userDataDir)).rejects.toThrow(
      /non-empty string or undefined/
    );

    // Both records survive, byte-for-byte.
    expect(await fsp.readFile(filePath, "utf8")).toBe(before);
    expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId).sort()).toEqual([
      "s1",
      "s2",
    ]);
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

  describe("in-memory cache", () => {
    it("reflects a direct on-disk change after a prior read cached it", async () => {
      const filePath = getSessionHistoryPath(userDataDir)!;
      await persistAgentSession(
        {
          sessionId: "cached",
          agentId: "claude",
          worktreeId: "wt-1",
          title: null,
          projectId: null,
        },
        userDataDir
      );
      // Prime the cache.
      expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual(["cached"]);

      // Overwrite the journal directly, bypassing the writers — the stat gate
      // must notice the size/mtime change and re-read rather than serve stale.
      await fsp.writeFile(
        filePath,
        JSON.stringify([
          {
            sessionId: "external",
            agentId: "claude",
            worktreeId: "wt-1",
            title: null,
            projectId: null,
            savedAt: Date.now(),
          },
        ])
      );

      expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual(["external"]);
      expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual([
        "external",
      ]);
    });

    it("serves the same parsed array reference on a cache hit (no re-parse)", async () => {
      await persistAgentSession(
        { sessionId: "hot", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
        userDataDir
      );
      // Two reads with no write between them and an unchanged file: a cache hit
      // returns the exact same array reference, proving the journal wasn't
      // re-read and re-parsed (a fresh parse would allocate a new array).
      const first = readSessionHistorySync(userDataDir);
      const second = readSessionHistorySync(userDataDir);
      expect(second).toBe(first);
      expect(second.map((r) => r.sessionId)).toEqual(["hot"]);
    });

    it("a writer refreshes the cache so the next sync read sees new data", async () => {
      // Prime the cache with an empty-journal read.
      expect(listAgentSessions(undefined, userDataDir)).toEqual([]);
      await persistAgentSession(
        { sessionId: "fresh", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
        userDataDir
      );
      // No direct read between persist and this list — only the writer's cache
      // refresh makes the new record visible to the sync path.
      expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual(["fresh"]);
    });
  });

  async function quarantineSidecars(dir: string): Promise<string[]> {
    const entries = await fsp.readdir(dir);
    return entries.filter((f) => f.includes(".corrupted."));
  }

  it("quarantines corrupt JSON instead of silently dropping it, then recovers", async () => {
    const filePath = getSessionHistoryPath(userDataDir)!;
    await fsp.writeFile(filePath, "not json at all");

    const records = await readSessionHistory(userDataDir);
    expect(records).toEqual([]);

    // The corrupt bytes are preserved to a `.corrupted.<ts>` sidecar, not lost.
    const sidecars = await quarantineSidecars(userDataDir);
    expect(sidecars).toHaveLength(1);
    expect(await fsp.readFile(path.join(userDataDir, sidecars[0]), "utf8")).toBe("not json at all");
    // The original path was moved aside, so a fresh journal can be written.
    await expect(fsp.access(filePath)).rejects.toThrow();

    // Can still persist after corruption — a fresh single-record journal.
    await persistAgentSession(
      { sessionId: "recovery", agentId: "claude", worktreeId: null, title: null, projectId: null },
      userDataDir
    );
    const after = await readSessionHistory(userDataDir);
    expect(after).toHaveLength(1);
    expect(after[0].sessionId).toBe("recovery");
  });

  it.each(["{}", "null", '{"records":[]}', '"a string"'])(
    "quarantines a well-formed but non-array journal root: %s",
    async (rootJson) => {
      const filePath = getSessionHistoryPath(userDataDir)!;
      await fsp.writeFile(filePath, rootJson);

      expect(await readSessionHistory(userDataDir)).toEqual([]);
      expect(await quarantineSidecars(userDataDir)).toHaveLength(1);
      // Sync read path quarantines identically (the sidecar already exists, so a
      // second read simply sees ENOENT and returns []).
      expect(readSessionHistorySync(userDataDir)).toEqual([]);
    }
  );

  it("returns [] for an absent journal without creating a quarantine sidecar (ENOENT)", async () => {
    // No file written — a genuinely-empty history must never be quarantined.
    expect(await readSessionHistory(userDataDir)).toEqual([]);
    expect(readSessionHistorySync(userDataDir)).toEqual([]);
    expect(await quarantineSidecars(userDataDir)).toEqual([]);
  });

  it.each(["sync not json", "{}", "null"])(
    "readSessionHistorySync quarantines a corrupt/non-array journal (sync path): %s",
    async (badContent) => {
      // Drives the SYNC reader (readFileSync/normalizeRecords/resilientRenameSync)
      // directly — no prior async read moves the file first.
      const filePath = getSessionHistoryPath(userDataDir)!;
      await fsp.writeFile(filePath, badContent);

      expect(readSessionHistorySync(userDataDir)).toEqual([]);

      const sidecars = await quarantineSidecars(userDataDir);
      expect(sidecars).toHaveLength(1);
      expect(await fsp.readFile(path.join(userDataDir, sidecars[0]), "utf8")).toBe(badContent);
      await expect(fsp.access(filePath)).rejects.toThrow();
    }
  );

  it("persistAgentSession quarantines a corrupt journal, then writes a fresh one", async () => {
    const filePath = getSessionHistoryPath(userDataDir)!;
    await fsp.writeFile(filePath, "}{ not json");

    await persistAgentSession(
      { sessionId: "fresh", agentId: "claude", worktreeId: "wt-1", title: null, projectId: null },
      userDataDir
    );

    // Corrupt bytes preserved to a sidecar; the live journal holds only the new record.
    expect(await quarantineSidecars(userDataDir)).toHaveLength(1);
    const after = await readSessionHistory(userDataDir);
    expect(after.map((r) => r.sessionId)).toEqual(["fresh"]);
  });
});

describe("agentSessionHistory bookmarks", () => {
  let userDataDir: string;
  const previousUserData = process.env.DAINTREE_USER_DATA;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-bookmarks-"));
    process.env.DAINTREE_USER_DATA = userDataDir;
  });

  afterEach(async () => {
    process.env.DAINTREE_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  const DAY = 24 * 60 * 60 * 1000;

  function bm(overrides: Partial<AgentSessionBookmarkMetadata> = {}): AgentSessionBookmarkMetadata {
    return { bookmarkedAt: 1_000, label: "Pinned", ...overrides };
  }

  function record(
    sessionId: string,
    overrides: Partial<AgentSessionRecord> = {}
  ): AgentSessionRecord {
    return {
      sessionId,
      agentId: "claude",
      worktreeId: "wt-1",
      title: null,
      projectId: "proj-1",
      savedAt: Date.now(),
      ...overrides,
    };
  }

  // Seed the journal on disk directly so age/cap/bookmark mixes can be controlled
  // exactly (persistAgentSession would stamp savedAt=now and evict on the way in).
  async function seed(records: AgentSessionRecord[]): Promise<void> {
    const filePath = getSessionHistoryPath(userDataDir)!;
    await fsp.writeFile(filePath, JSON.stringify(records));
  }

  // Fresh temp dir per retention value (the beforeEach one is reused across the
  // it.each rows) so the stat-gated read cache can't serve a prior row's records.
  it.each([7, 30, 90, 0] as const)(
    "keeps bookmarks across retention=%s while ordinary records age out",
    async (days) => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-bookmarks-ret-"));
      try {
        const ttlDays = days === 0 ? 3650 : days;
        const filePath = getSessionHistoryPath(dir)!;
        await fsp.writeFile(
          filePath,
          JSON.stringify([
            record("pinned", { savedAt: Date.now() - (ttlDays + 10) * DAY, bookmark: bm() }),
            record("stale", { savedAt: Date.now() - (ttlDays + 10) * DAY }),
            record("fresh", { savedAt: Date.now() }),
          ])
        );
        const ids = listAgentSessions(undefined, dir, days)
          .map((r) => r.sessionId)
          .sort();
        // The pinned record survives regardless of retention; the stale ordinary
        // one ages out for finite windows and is kept for "forever" (0).
        const expected = days === 0 ? ["fresh", "pinned", "stale"] : ["fresh", "pinned"];
        expect(ids).toEqual(expected);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    }
  );

  it("exempts bookmarks from the per-worktree cap while ordinary records are capped", async () => {
    const ordinary = Array.from({ length: MAX_RECORDS_PER_WORKTREE + 5 }, (_, i) =>
      record(`ord-${i}`, { savedAt: Date.now() - i * 1000 })
    );
    const pinned = [
      record("pin-a", { savedAt: Date.now() - 10_000, bookmark: bm({ bookmarkedAt: 1 }) }),
      record("pin-b", { savedAt: Date.now() - 20_000, bookmark: bm({ bookmarkedAt: 2 }) }),
      record("pin-c", { savedAt: Date.now() - 30_000, bookmark: bm({ bookmarkedAt: 3 }) }),
    ];
    await seed([...ordinary, ...pinned]);

    const kept = listAgentSessions("wt-1", userDataDir);
    const bookmarked = kept.filter((r) => r.bookmark);
    const plain = kept.filter((r) => !r.bookmark);
    expect(plain).toHaveLength(MAX_RECORDS_PER_WORKTREE);
    expect(bookmarked.map((r) => r.sessionId).sort()).toEqual(["pin-a", "pin-b", "pin-c"]);
  });

  it("carries an existing bookmark forward when a resumed session is re-journaled", async () => {
    await seed([
      record("sess-x", { savedAt: Date.now() - 5 * DAY, bookmark: bm({ bookmarkedAt: 42 }) }),
    ]);

    // Resume + re-close writes a fresh ORDINARY record for the same sessionId.
    const persisted = await persistAgentSession(
      {
        sessionId: "sess-x",
        agentId: "claude",
        worktreeId: "wt-1",
        title: "newer",
        projectId: "proj-1",
      },
      userDataDir
    );

    const all = await readSessionHistory(userDataDir);
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("newer"); // fresh resume data won the position
    expect(all[0].bookmark).toEqual(bm({ bookmarkedAt: 42 })); // pin (and its time) preserved
    expect(persisted?.bookmark?.bookmarkedAt).toBe(42);
  });

  it("does not carry a bookmark across a cross-agent sessionId collision", async () => {
    const now = Date.now();
    // Two DIFFERENT agents happen to share a sessionId. The newer ordinary record
    // must NOT inherit the older, differently-agented record's pin.
    await seed([
      record("dup", { agentId: "codex", savedAt: now }),
      record("dup", { agentId: "claude", savedAt: now - 1000, bookmark: bm() }),
    ]);
    const kept = listAgentSessions(undefined, userDataDir);
    expect(kept).toHaveLength(1);
    expect(kept[0].agentId).toBe("codex");
    expect(kept[0].bookmark).toBeUndefined();
  });

  it("lets a deliberate re-bookmark replace the timestamp", async () => {
    await seed([record("sess-x", { bookmark: bm({ bookmarkedAt: 42, label: "old" }) })]);
    await persistAgentSession(
      {
        sessionId: "sess-x",
        agentId: "claude",
        worktreeId: "wt-1",
        title: null,
        projectId: "proj-1",
        bookmark: bm({ bookmarkedAt: 99, label: "new" }),
      },
      userDataDir
    );
    const all = await readSessionHistory(userDataDir);
    expect(all).toHaveLength(1);
    expect(all[0].bookmark).toEqual(bm({ bookmarkedAt: 99, label: "new" }));
  });

  it("clear-all retains bookmarks and drops ordinary history", async () => {
    await seed([record("keep", { bookmark: bm() }), record("drop", { worktreeId: "wt-2" })]);
    await clearAgentSessions(undefined, userDataDir);
    const ids = (await readSessionHistory(userDataDir)).map((r) => r.sessionId);
    expect(ids).toEqual(["keep"]);
  });

  it("scoped clear retains bookmarks in the target worktree and spares other worktrees", async () => {
    await seed([
      record("wt1-pin", { worktreeId: "wt-1", bookmark: bm() }),
      record("wt1-ord", { worktreeId: "wt-1" }),
      record("wt2-ord", { worktreeId: "wt-2" }),
    ]);
    await clearAgentSessions("wt-1", userDataDir);
    const ids = (await readSessionHistory(userDataDir)).map((r) => r.sessionId).sort();
    expect(ids).toEqual(["wt1-pin", "wt2-ord"]);
  });

  it("promoteBookmark pins an existing record, updating label but preserving bookmarkedAt", async () => {
    await seed([
      record("sess-x", { bookmark: bm({ bookmarkedAt: 7, label: "first" }) }),
      record("sess-y"),
    ]);

    const promotedY = await promoteBookmark("sess-y", "Y label", userDataDir);
    expect(promotedY?.bookmark?.label).toBe("Y label");
    expect(typeof promotedY?.bookmark?.bookmarkedAt).toBe("number");

    // Re-promoting an already-bookmarked session updates the label in place.
    const repromoted = await promoteBookmark("sess-x", "second", userDataDir);
    expect(repromoted?.bookmark).toEqual(bm({ bookmarkedAt: 7, label: "second" }));

    expect(await promoteBookmark("missing", "x", userDataDir)).toBeNull();
  });

  it("renameBookmark changes only the label of a bookmarked record", async () => {
    await seed([
      record("sess-x", { bookmark: bm({ bookmarkedAt: 7, label: "old" }) }),
      record("plain"),
    ]);

    const renamed = await renameBookmark("sess-x", "new", userDataDir);
    expect(renamed?.bookmark).toEqual(bm({ bookmarkedAt: 7, label: "new" }));

    // A non-bookmarked or unknown record cannot be renamed.
    expect(await renameBookmark("plain", "x", userDataDir)).toBeNull();
    expect(await renameBookmark("missing", "x", userDataDir)).toBeNull();
  });

  it("deleteBookmark demotes a record to ordinary history and re-evicts it", async () => {
    // A fresh bookmark demotes back to visible ordinary history.
    await seed([record("fresh", { bookmark: bm() })]);
    expect(await deleteBookmark("fresh", userDataDir)).toBe(true);
    const afterFresh = await readSessionHistory(userDataDir);
    expect(afterFresh).toHaveLength(1);
    expect(afterFresh[0].bookmark).toBeUndefined();

    // A record that survived ONLY because it was pinned ages out on demotion.
    await seed([record("stale", { savedAt: Date.now() - 200 * DAY, bookmark: bm() })]);
    expect(await deleteBookmark("stale", userDataDir, 30)).toBe(true);
    expect(await readSessionHistory(userDataDir)).toHaveLength(0);

    // Deleting a missing/non-bookmarked record reports not-found.
    await seed([record("plain")]);
    expect(await deleteBookmark("plain", userDataDir)).toBe(false);
    expect(await deleteBookmark("missing", userDataDir)).toBe(false);
  });

  it("deleteBookmark re-applies the per-worktree cap after demotion", async () => {
    // A full cap of ordinary records plus one pin that only survives via its
    // exemption. Deleting the pin demotes it into the full bucket, where — being
    // the oldest — it loses the cap contest and disappears. Seed newest-first
    // (the on-disk invariant the cap relies on): the old pin is positionally last.
    const ordinary = Array.from({ length: MAX_RECORDS_PER_WORKTREE }, (_, i) =>
      record(`ord-${i}`, { savedAt: Date.now() - i * 1000 })
    );
    await seed([...ordinary, record("pinned", { savedAt: Date.now() - 10 * DAY, bookmark: bm() })]);
    expect(listAgentSessions("wt-1", userDataDir)).toHaveLength(MAX_RECORDS_PER_WORKTREE + 1);

    expect(await deleteBookmark("pinned", userDataDir)).toBe(true);
    const after = listAgentSessions("wt-1", userDataDir);
    expect(after).toHaveLength(MAX_RECORDS_PER_WORKTREE);
    expect(after.find((r) => r.sessionId === "pinned")).toBeUndefined();
  });

  it("bookmark reads ignore malformed journal elements (never errors)", async () => {
    const filePath = getSessionHistoryPath(userDataDir)!;
    await fsp.writeFile(
      filePath,
      JSON.stringify([null, "garbage", { no: "sessionId" }, record("ok", { bookmark: bm() })])
    );
    expect(() => listBookmarks(undefined, userDataDir)).not.toThrow();
    expect(listBookmarks(undefined, userDataDir).map((r) => r.sessionId)).toEqual(["ok"]);
    expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual(["ok"]);
  });

  it("listBookmarks returns only bookmarks, newest-first, project-scoped", async () => {
    await seed([
      record("a", { projectId: "p1", bookmark: bm({ bookmarkedAt: 100 }) }),
      record("b", { projectId: "p1", bookmark: bm({ bookmarkedAt: 300 }) }),
      record("c", { projectId: "p2", bookmark: bm({ bookmarkedAt: 200 }) }),
      record("d", { projectId: "p1" }), // ordinary
    ]);

    expect(listBookmarks(undefined, userDataDir).map((r) => r.sessionId)).toEqual(["b", "c", "a"]);
    expect(listBookmarks("p1", userDataDir).map((r) => r.sessionId)).toEqual(["b", "a"]);
    expect(listBookmarks("nope", userDataDir)).toEqual([]);
  });

  it("serialized bookmark mutations never lose unrelated records", async () => {
    await seed([
      record("promote-me"),
      record("rename-me", { bookmark: bm({ bookmarkedAt: 1, label: "r" }) }),
      record("delete-me", { bookmark: bm({ bookmarkedAt: 2 }) }),
      record("bystander", { bookmark: bm({ bookmarkedAt: 3 }) }),
    ]);

    await Promise.all([
      promoteBookmark("promote-me", "P", userDataDir),
      renameBookmark("rename-me", "R2", userDataDir),
      deleteBookmark("delete-me", userDataDir),
      persistAgentSession(
        {
          sessionId: "new-close",
          agentId: "claude",
          worktreeId: "wt-1",
          title: null,
          projectId: "proj-1",
        },
        userDataDir
      ),
    ]);

    const byId = new Map((await readSessionHistory(userDataDir)).map((r) => [r.sessionId, r]));
    expect(byId.get("promote-me")?.bookmark?.label).toBe("P");
    expect(byId.get("rename-me")?.bookmark?.label).toBe("R2");
    expect(byId.get("delete-me")?.bookmark).toBeUndefined();
    expect(byId.get("bystander")?.bookmark?.bookmarkedAt).toBe(3);
    expect(byId.has("new-close")).toBe(true);
  });
});
