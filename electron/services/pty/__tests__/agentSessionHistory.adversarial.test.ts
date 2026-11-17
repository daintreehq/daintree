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
    // Real fs errors name the path in their message; a fault can say so too.
    message?: string;
  }
  const armed: {
    read: Fault | null;
    renameFault: string | null;
    writeFault: string | null;
    writeHold: { until: Promise<void>; reached: () => void } | null;
  } = {
    read: null,
    renameFault: null,
    writeFault: null,
    writeHold: null,
  };
  // Every read or stat of the journal itself, by call name.
  const touches: string[] = [];
  const isJournalPath = (p: unknown): boolean =>
    typeof p === "string" && p.endsWith("agent-session-history.json");
  const makeError = (code: string, message: string = code): Error =>
    Object.assign(new Error(message), { code });
  const touch = (call: string, p: unknown): void => {
    if (isJournalPath(p)) touches.push(call);
  };
  const takeFault = (p: unknown): Error | null => {
    const fault = armed.read;
    if (!fault || !isJournalPath(p)) return null;
    armed.read = null; // one-shot: the next call to the same path succeeds
    return makeError(fault.code, fault.message);
  };
  // One-shot: a journal write that lands on disk and then throws, the way a
  // failed parent-directory sync does after its rename.
  const takeWriteFault = (p: unknown): Error | null => {
    const code = armed.writeFault;
    if (!code || !isJournalPath(p)) return null;
    armed.writeFault = null;
    return makeError(code);
  };
  // The quarantine-rename fault is one-shot and journal-path-scoped too, so it
  // can only fail the rename of the corrupt journal it's meant to simulate.
  const takeRenameFault = (src: unknown): Error | null => {
    const code = armed.renameFault;
    if (!code || !isJournalPath(src)) return null;
    armed.renameFault = null; // one-shot
    return makeError(code);
  };
  const reset = (): void => {
    armed.read = null;
    armed.renameFault = null;
    armed.writeFault = null;
    armed.writeHold = null;
    touches.length = 0;
  };
  return { armed, touches, touch, takeFault, takeRenameFault, takeWriteFault, reset };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      h.touch("readFile", args[0]);
      const fault = h.takeFault(args[0]);
      return fault ? Promise.reject(fault) : actual.readFile(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      h.touch("stat", args[0]);
      return actual.stat(...args);
    },
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      h.touch("readFileSync", args[0]);
      const fault = h.takeFault(args[0]);
      if (fault) throw fault;
      return actual.readFileSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      h.touch("statSync", args[0]);
      return actual.statSync(...args);
    },
  };
});

vi.mock("../../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/fs.js")>();
  return {
    ...actual,
    resilientRename: (...args: Parameters<typeof actual.resilientRename>) => {
      const fault = h.takeRenameFault(args[0]);
      return fault ? Promise.reject(fault) : actual.resilientRename(...args);
    },
    resilientRenameSync: (...args: Parameters<typeof actual.resilientRenameSync>) => {
      const fault = h.takeRenameFault(args[0]);
      if (fault) throw fault;
      return actual.resilientRenameSync(...args);
    },
    resilientAtomicWriteFile: async (
      ...args: Parameters<typeof actual.resilientAtomicWriteFile>
    ) => {
      h.touch("write", args[0]);
      // One-shot: holds the next journal write before it touches the disk.
      const hold = h.armed.writeHold;
      if (hold && String(args[0]).endsWith("agent-session-history.json")) {
        h.armed.writeHold = null;
        hold.reached();
        await hold.until;
      }
      await actual.resilientAtomicWriteFile(...args);
      const fault = h.takeWriteFault(args[0]);
      if (fault) throw fault;
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
  listAgentSessionsOrThrow,
  getSessionHistoryPath,
  resetSessionHistoryCacheForTesting,
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
    // Direct write, read back as a restart would, so the reader under test
    // must hit disk — the fault then classifies against real on-disk content.
    await fsp.writeFile(getSessionHistoryPath(userDataDir)!, JSON.stringify(records));
    resetSessionHistoryCacheForTesting();
  }

  async function rawOnDisk(): Promise<string> {
    return fsp.readFile(getSessionHistoryPath(userDataDir)!, "utf8");
  }

  it("async read returns [] on a transient EACCES without quarantining, then recovers", async () => {
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    h.armed.read = { code: "EACCES" };

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
    h.armed.read = { code: "EMFILE" };
    expect(readSessionHistorySync(userDataDir)).toEqual([]);
    h.armed.read = { code: "EMFILE" };
    expect(listAgentSessions(undefined, userDataDir)).toEqual([]);
    expect(await quarantineSidecars()).toEqual([]);

    // Fault cleared: the file was never touched, so the next read returns it.
    expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual(["a"]);
  });

  // #17483 — the resume UI reads through the strict list so an unreadable
  // journal shows its error state and Retry instead of "nothing closed".
  it.each(["EACCES", "EIO", "EMFILE"])(
    "strict list throws on a transient %s, leaves the journal intact, then recovers",
    async (code) => {
      const now = Date.now();
      await seedJournal([
        { ...rec("a", "wt-1", "p1"), savedAt: now },
        { ...rec("b", "wt-2", "p2"), savedAt: now - 1000 },
      ]);
      const before = await rawOnDisk();
      h.touches.length = 0;
      h.armed.read = { code };

      expect(() => listAgentSessionsOrThrow(undefined, userDataDir)).toThrow(
        /session history couldn't be read/
      );
      expect(await rawOnDisk()).toBe(before);
      expect(await quarantineSidecars()).toEqual([]);

      // The failure was never cached: the retry reads the file and scopes it.
      expect(listAgentSessionsOrThrow(undefined, userDataDir).map((r) => r.sessionId)).toEqual([
        "a",
        "b",
      ]);
      expect(
        listAgentSessionsOrThrow(undefined, userDataDir, undefined, "p2").map((r) => r.sessionId)
      ).toEqual(["b"]);
      expect(await rawOnDisk()).toBe(before);
      // Neither the failed read nor the retry wrote the journal, even byte-for-byte.
      expect(h.touches.filter((call) => call === "write")).toEqual([]);
    }
  );

  it("strict list keeps the filesystem error as its cause and names no path", async () => {
    await seedJournal([rec("a", "wt-1")]);
    const journalPath = getSessionHistoryPath(userDataDir)!;
    h.armed.read = {
      code: "EACCES",
      message: `EACCES: permission denied, open '${journalPath}'`,
    };

    let thrown: unknown;
    try {
      listAgentSessionsOrThrow(undefined, userDataDir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const cause = (thrown as Error).cause as Error & { code?: string };
    expect(cause.code).toBe("EACCES");
    expect(cause.message).toContain(journalPath);
    expect((thrown as Error).message).not.toContain(userDataDir);
  });

  it("strict list reads an absent journal as an ordinary empty list", () => {
    expect(listAgentSessionsOrThrow(undefined, userDataDir)).toEqual([]);
  });

  it("strict list reads a quarantined corrupt journal as empty, and throws when the quarantine fails", async () => {
    await fsp.writeFile(getSessionHistoryPath(userDataDir)!, "corrupt bytes");
    h.armed.renameFault = "EACCES";

    expect(() => listAgentSessionsOrThrow(undefined, userDataDir)).toThrow(
      /session history couldn't be read/
    );
    expect(await rawOnDisk()).toBe("corrupt bytes");
    expect(await quarantineSidecars()).toEqual([]);

    // Rename works again: the corrupt file is moved aside and the list is empty.
    expect(listAgentSessionsOrThrow(undefined, userDataDir)).toEqual([]);
    const sidecars = await quarantineSidecars();
    expect(sidecars).toHaveLength(1);
    expect(await fsp.readFile(path.join(userDataDir, sidecars[0]!), "utf8")).toBe("corrupt bytes");
    await expect(fsp.access(getSessionHistoryPath(userDataDir)!)).rejects.toThrow();
  });

  it("persistAgentSession aborts on an unreadable journal, preserving existing records", async () => {
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2"), rec("c", "wt-3")]);
    const before = await rawOnDisk();
    h.armed.read = { code: "EACCES" }; // fail the content read specifically

    await expect(persistAgentSession(rec("new", "wt-4"), userDataDir)).rejects.toThrow(
      /could not be read/
    );

    // Byte-for-byte unchanged: no overwrite, no quarantine.
    expect(await rawOnDisk()).toBe(before);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("pruneAgentSessions aborts on an unreadable journal rather than writing []", async () => {
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    const before = await rawOnDisk();
    h.armed.read = { code: "EMFILE" };

    await expect(pruneAgentSessions(7, userDataDir)).rejects.toThrow(/could not be read/);

    expect(await rawOnDisk()).toBe(before);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("clearAgentSessions(worktree) aborts on an unreadable journal, sparing other worktrees", async () => {
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    const before = await rawOnDisk();
    h.armed.read = { code: "EIO" };

    await expect(clearAgentSessions("wt-1", userDataDir)).rejects.toThrow(/could not be read/);

    // wt-2 (and even wt-1) survive: a failed read must never wipe the journal.
    expect(await rawOnDisk()).toBe(before);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("rewriteAgentSessionPathsForProject aborts on an unreadable journal", async () => {
    await seedJournal([rec("a", "/old/wt-1", "proj-1")]);
    const before = await rawOnDisk();
    h.armed.read = { code: "EBUSY" };

    await expect(
      rewriteAgentSessionPathsForProject("proj-1", "/old", "/new", userDataDir)
    ).rejects.toThrow(/could not be read/);

    expect(await rawOnDisk()).toBe(before);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("recovers to on-disk truth after a transient read failure (no [] poisoning)", async () => {
    // A failed read is never cached, so the reader can't get stuck serving [].
    await seedJournal([rec("second", "wt-1")]);
    h.armed.read = { code: "EIO" };

    // The failed read reports [] once...
    expect(await readSessionHistory(userDataDir)).toEqual([]);
    // ...so the following read reflects the real on-disk journal.
    expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual(["second"]);
    expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual(["second"]);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("stops serving the old journal when a write lands and then throws", async () => {
    await persistAgentSession(rec("first", "wt-1"), userDataDir);
    h.armed.writeFault = "EIO";

    await expect(persistAgentSession(rec("second", "wt-1"), userDataDir)).rejects.toThrow("EIO");

    // The rename landed before the throw, so the disk is the journal now.
    expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual([
      "second",
      "first",
    ]);
  });

  it("serves warm reads without reading or statting the journal", async () => {
    await persistAgentSession(rec("held", "wt-1"), userDataDir);
    h.touches.length = 0;

    expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual(["held"]);
    expect(readSessionHistorySync(userDataDir).map((r) => r.sessionId)).toEqual(["held"]);
    expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual(["held"]);
    expect(h.touches).toEqual([]);
  });

  it("queues an async read behind the write in flight, so it can't cache what that write replaced", async () => {
    await seedJournal([rec("old", "wt-1")]);
    let release!: () => void;
    let reached!: () => void;
    const writerHeld = new Promise<void>((resolve) => (reached = resolve));
    h.armed.writeHold = { until: new Promise<void>((resolve) => (release = resolve)), reached };

    const writing = persistAgentSession(rec("new", "wt-1"), userDataDir);
    await writerHeld; // the writer has read ["old"] and holds before writing
    let settled = false;
    const reading = readSessionHistory(userDataDir).then((records) => {
      settled = true;
      return records;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await writing;
    expect((await reading).map((r) => r.sessionId)).toEqual(["new", "old"]);
    expect(listAgentSessions(undefined, userDataDir).map((r) => r.sessionId)).toEqual([
      "new",
      "old",
    ]);
  });

  it("treats a failed quarantine as unreadable: the corrupt file is left intact, not overwritten", async () => {
    await fsp.writeFile(getSessionHistoryPath(userDataDir)!, "totally not json");
    h.armed.renameFault = "EACCES"; // the quarantine rename will reject (non-ENOENT)

    await expect(persistAgentSession(rec("recovery", "wt-1"), userDataDir)).rejects.toThrow(
      /could not be read/
    );

    // Because quarantine failed, the original corrupt bytes must remain in place
    // (never clobbered by a fresh write) and no sidecar was produced.
    expect(await rawOnDisk()).toBe("totally not json");
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("proceeds when the corrupt file was already quarantined concurrently (rename ENOENT)", async () => {
    // Simulates the un-queued sync quarantine (listAgentSessions) winning the race:
    // by the time this persist tries to quarantine, the corrupt file is already
    // gone (rename → ENOENT). That must NOT abort — the source is handled, so a
    // fresh journal is written rather than the just-closed record being lost.
    await fsp.writeFile(getSessionHistoryPath(userDataDir)!, "already being quarantined");
    h.armed.renameFault = "ENOENT";

    await expect(persistAgentSession(rec("survivor", "wt-1"), userDataDir)).resolves.toBeTruthy(); // persist now echoes the durable record

    expect((await readSessionHistory(userDataDir)).map((r) => r.sessionId)).toEqual(["survivor"]);
  });

  it("sync read leaves a corrupt file intact when its quarantine rename fails", async () => {
    // Exercises the SYNC corrupt→quarantine→failed-rename→unreadable branch.
    await fsp.writeFile(getSessionHistoryPath(userDataDir)!, "sync corrupt bytes");
    h.armed.renameFault = "EACCES";

    expect(readSessionHistorySync(userDataDir)).toEqual([]);
    expect(await rawOnDisk()).toBe("sync corrupt bytes");
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("clear-all aborts on an unreadable journal rather than wiping bookmarks it can't see", async () => {
    // Clear-all now reads first so it can retain bookmarks (#11288). An
    // unreadable journal must therefore abort — overwriting with the retained
    // set would silently drop any bookmark the failed read couldn't surface.
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    const before = await rawOnDisk();
    h.armed.read = { code: "EIO" };

    await expect(clearAgentSessions(undefined, userDataDir)).rejects.toThrow(/could not be read/);

    expect(await rawOnDisk()).toBe(before);
    expect(await quarantineSidecars()).toEqual([]);
  });

  it("recovers on the write queue: a follow-up persist lands after one aborts", async () => {
    // Scoped to rejection recovery — an aborting predecessor must not wedge the
    // queue or block its follower. Serialization itself is covered by the
    // "preserves all records under concurrent writes" test in the sibling suite.
    await seedJournal([rec("a", "wt-1"), rec("b", "wt-2")]);
    h.armed.read = { code: "EACCES" }; // one-shot: only the first read fails

    // Enqueue both without awaiting so they share the serial write queue.
    const first = persistAgentSession(rec("blocked", "wt-3"), userDataDir);
    const second = persistAgentSession(rec("landed", "wt-4"), userDataDir);

    await expect(first).rejects.toThrow(/could not be read/);
    await expect(second).resolves.toBeTruthy(); // persist now echoes the durable record

    const after = (await readSessionHistory(userDataDir)).map((r) => r.sessionId).sort();
    expect(after).toEqual(["a", "b", "landed"]); // "blocked" never landed; seeds survived
    expect(await quarantineSidecars()).toEqual([]);
  });
});
