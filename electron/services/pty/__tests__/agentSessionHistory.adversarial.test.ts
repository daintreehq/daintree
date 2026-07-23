import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Fault-injection control shared with the hoisted module mocks below. Faults are
// one-shot and scoped to the journal path, so fixture setup (writeFile/mkdtemp)
// and post-condition reads still hit the real filesystem. This lets us force the
// exact failure classes #11348 is about — a transient read error (EACCES/EIO/
// EMFILE/EBUSY) on an EXISTING journal — which no portable real-fs trick or
// chmod can produce reliably (chmod is bypassed by root and is a Windows no-op).
const h = vi.hoisted(() => {
  interface Fault {
    code: string;
  }
  const armed: { read: Fault | null; stat: Fault | null; renameFail: boolean } = {
    read: null,
    stat: null,
    renameFail: false,
  };
  const isJournalPath = (p: unknown): boolean =>
    typeof p === "string" && p.endsWith("agent-session-history.json");
  const takeFault = (slot: "read" | "stat", p: unknown): Error | null => {
    const fault = armed[slot];
    if (!fault || !isJournalPath(p)) return null;
    armed[slot] = null; // one-shot: the next call to the same path succeeds
    return Object.assign(new Error(fault.code), { code: fault.code });
  };
  const reset = (): void => {
    armed.read = null;
    armed.stat = null;
    armed.renameFail = false;
  };
  return { armed, takeFault, reset };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const fault = h.takeFault("read", args[0]);
      return fault ? Promise.reject(fault) : actual.readFile(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      const fault = h.takeFault("stat", args[0]);
      return fault ? Promise.reject(fault) : actual.stat(...args);
    },
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const fault = h.takeFault("read", args[0]);
      if (fault) throw fault;
      return actual.readFileSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const fault = h.takeFault("stat", args[0]);
      if (fault) throw fault;
      return actual.statSync(...args);
    },
  };
});

vi.mock("../../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/fs.js")>();
  return {
    ...actual,
    resilientRename: (...args: Parameters<typeof actual.resilientRename>) =>
      h.armed.renameFail
        ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
        : actual.resilientRename(...args),
    resilientRenameSync: (...args: Parameters<typeof actual.resilientRenameSync>) => {
      if (h.armed.renameFail) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return actual.resilientRenameSync(...args);
    },
  };
});

import {
  persistAgentSession,
  pruneAgentSessions,
  clearAgentSessions,
  rewriteAgentSessionPathsForProject,
  readSessionHistory,
  readSessionHistorySync,
  listAgentSessions,
  getSessionHistoryPath,
  type AgentSessionRecord,
} from "../agentSessionHistory.js";

function rec(sessionId: string, worktreeId: string | null, projectId: string | null = null) {
  return {
    sessionId,
    agentId: "claude",
    worktreeId,
    title: null,
    projectId,
    savedAt: Date.now(),
  } satisfies AgentSessionRecord;
}

describe("agentSessionHistory — transient read faults (adversarial)", () => {
  let userDataDir: string;
  const previousUserData = process.env.DAINTREE_USER_DATA;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-session-adv-"));
    process.env.DAINTREE_USER_DATA = userDataDir;
    h.reset();
  });

  afterEach(async () => {
    h.reset();
    vi.clearAllMocks();
    process.env.DAINTREE_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  async function quarantineSidecars(): Promise<string[]> {
    return (await fsp.readdir(userDataDir)).filter((f) => f.includes(".corrupted."));
  }

  async function seedJournal(records: AgentSessionRecord[]): Promise<void> {
    // Direct write (bypasses the writers' cache refresh) so the reader under test
    // must hit disk — the fault then classifies against real on-disk content.
    await fsp.writeFile(getSessionHistoryPath(userDataDir)!, JSON.stringify(records));
  }

  async function readOnDisk(): Promise<AgentSessionRecord[]> {
    const raw = await fsp.readFile(getSessionHistoryPath(userDataDir)!, "utf8");
    return JSON.parse(raw) as AgentSessionRecord[];
  }

  it("async read returns [] on a transient EACCES without quarantining, then recovers", async () => {
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    h.armed.stat = { code: "EACCES" };

    // The transient failure degrades this one read to [] — but must NOT quarantine.
    expect(await readSessionHistory(userDataDir)).toEqual([]);
    expect(await quarantineSidecars()).toEqual([]);

    // Fault was one-shot: the file is intact and the next read returns it.
    expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual(["a", "b"]);
  });

  it("sync read returns [] on a transient EMFILE without quarantining, then recovers", async () => {
    await seedJournal([rec("a", "wt-1")]);

    // Both sync entry points degrade to [] on the transient failure (faults are
    // one-shot, so each read re-arms) — and neither quarantines.
    h.armed.stat = { code: "EMFILE" };
    expect(readSessionHistorySync(userDataDir)).toEqual([]);
    h.armed.stat = { code: "EMFILE" };
    expect(listAgentSessions(undefined, userDataDir)).toEqual([]);
    expect(await quarantineSidecars()).toEqual([]);

    // Fault cleared: the file was never touched, so the next read returns it.
    expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual(["a"]);
  });

  it("persistAgentSession aborts on an unreadable journal, preserving existing records", async () => {
    const seed = [rec("a", "wt-1"), rec("b", "wt-2"), rec("c", "wt-3")];
    await seedJournal(seed);
    h.armed.read = { code: "EACCES" }; // fail the content read specifically

    await expect(persistAgentSession(rec("new", "wt-4"), userDataDir)).rejects.toThrow(
      /could not be read/
    );

    // The on-disk journal is byte-for-byte unchanged: no overwrite, no quarantine.
    expect((await readOnDisk()).map((r) => r.sessionId)).toEqual(["a", "b", "c"]);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("pruneAgentSessions aborts on an unreadable journal rather than writing []", async () => {
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    h.armed.stat = { code: "EMFILE" };

    await expect(pruneAgentSessions(7, userDataDir)).rejects.toThrow(/could not be read/);

    expect((await readOnDisk()).map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("clearAgentSessions(worktree) aborts on an unreadable journal, sparing other worktrees", async () => {
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    h.armed.stat = { code: "EIO" };

    await expect(clearAgentSessions("wt-1", userDataDir)).rejects.toThrow(/could not be read/);

    // wt-2 (and even wt-1) survive: a failed read must never wipe the journal.
    expect((await readOnDisk()).map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("rewriteAgentSessionPathsForProject aborts on an unreadable journal", async () => {
    await seedJournal([rec("a", "/old/wt-1", "proj-1")]);
    h.armed.stat = { code: "EBUSY" };

    await expect(
      rewriteAgentSessionPathsForProject("proj-1", "/old", "/new", userDataDir)
    ).rejects.toThrow(/could not be read/);

    expect((await readOnDisk()).map((r) => r.sessionId)).toEqual(["a"]);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("does not poison the cache with [] after a transient failure between two reads", async () => {
    await persistAgentSession(rec("first", "wt-1"), userDataDir); // primes the cache
    expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual(["first"]);

    // Change the file out-of-band, then fail the very next stat (transient).
    await seedJournal([rec("second", "wt-1")]);
    h.armed.stat = { code: "EIO" };

    // The failed read reports [] once and evicts the stale cache entry...
    expect(await readSessionHistory(userDataDir)).toEqual([]);
    // ...so the following read reflects the real on-disk change (not [] or "first").
    expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual(["second"]);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("treats a failed quarantine as unreadable: the corrupt file is left intact, not overwritten", async () => {
    await fsp.writeFile(getSessionHistoryPath(userDataDir)!, "totally not json");
    h.armed.renameFail = true; // the quarantine rename will reject

    await expect(persistAgentSession(rec("recovery", "wt-1"), userDataDir)).rejects.toThrow(
      /could not be read/
    );

    // Because quarantine failed, the original corrupt bytes must remain in place
    // (never clobbered by a fresh write) and no sidecar was produced.
    expect(await fsp.readFile(getSessionHistoryPath(userDataDir)!, "utf8")).toBe(
      "totally not json"
    );
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("does not wedge the write queue: a follow-up persist lands after one aborts", async () => {
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    h.armed.stat = { code: "EACCES" }; // one-shot: only the first read fails

    // Enqueue both without awaiting so they share the serial write queue.
    const first = persistAgentSession(rec("blocked", "wt-3"), userDataDir);
    const second = persistAgentSession(rec("landed", "wt-4"), userDataDir);

    await expect(first).rejects.toThrow(/could not be read/);
    await expect(second).resolves.toBeUndefined();

    const after = (await readSessionHistory(userDataDir)).map((r) => r.sessionId).sort();
    expect(after).toEqual(["a", "b", "landed"]); // "blocked" never landed; seeds survived
    expect(await quarantineSidecars()).toEqual([]);
  });
});
