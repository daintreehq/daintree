import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => userDataDir) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn(() => ({ retentionDays: 30 })) },
}));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { journalAgentSession, journalAgentSessionRecord } from "../agentSessionJournal.js";
import { readSessionHistory } from "../agentSessionHistory.js";
import { getLifecycleLedger, disposeLifecycleLedger } from "../lifecycleLedger.js";
import { events } from "../../events.js";

function makeRecord(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    agentId: "claude",
    worktreeId: "wt-1" as string | null,
    title: "Claude: fix auth" as string | null,
    projectId: "proj-1" as string | null,
    ...overrides,
  };
}

describe("journalAgentSession", () => {
  const previousUserData = process.env.DAINTREE_USER_DATA;
  let recordedEvents: Array<{ sessionId: string }>;
  let unsubscribe: () => void;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-session-journal-"));
    process.env.DAINTREE_USER_DATA = userDataDir;
    disposeLifecycleLedger();
    recordedEvents = [];
    unsubscribe = events.on("agent-session:recorded", (payload) => {
      recordedEvents.push({ sessionId: payload.sessionId });
    });
  });

  afterEach(async () => {
    unsubscribe();
    disposeLifecycleLedger();
    process.env.DAINTREE_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  it("persists a record and emits agent-session:recorded after the write", async () => {
    const ledger = getLifecycleLedger();
    const generation = ledger.recordLaunch("term-1", { launchAgentId: "claude" });

    const written = await journalAgentSession(makeRecord("sess-1"), {
      terminalId: "term-1",
      generation,
    });

    expect(written).toBe(true);
    const records = await readSessionHistory(userDataDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sessionId: "sess-1", agentId: "claude" });
    expect(recordedEvents).toEqual([{ sessionId: "sess-1" }]);
  });

  it("journals exactly once per terminal generation across overlapping close paths", async () => {
    const ledger = getLifecycleLedger();
    const generation = ledger.recordLaunch("term-1", { launchAgentId: "claude" });

    // Kill path and trash-expiry capture race for the same incarnation.
    const first = await journalAgentSession(makeRecord("sess-1"), {
      terminalId: "term-1",
      generation,
    });
    const second = await journalAgentSession(makeRecord("sess-1"), {
      terminalId: "term-1",
      generation,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await readSessionHistory(userDataDir)).toHaveLength(1);
    expect(recordedEvents).toHaveLength(1);
  });

  it("dedupes even when the duplicate capture carries a different sessionId", async () => {
    const ledger = getLifecycleLedger();
    const generation = ledger.recordLaunch("term-1", { launchAgentId: "claude" });

    await journalAgentSession(makeRecord("sess-1"), { terminalId: "term-1", generation });
    const dup = await journalAgentSession(makeRecord("sess-1b"), {
      terminalId: "term-1",
      generation,
    });

    expect(dup).toBe(false);
    const records = await readSessionHistory(userDataDir);
    expect(records.map((r) => r.sessionId)).toEqual(["sess-1"]);
  });

  it("journals a past generation's record after the terminal id respawned", async () => {
    const ledger = getLifecycleLedger();
    const oldGeneration = ledger.recordLaunch("term-1", { launchAgentId: "claude" });
    // Restart respawns the same id while the kill's journal write is in flight.
    ledger.recordLaunch("term-1", { launchAgentId: "claude" });

    const written = await journalAgentSession(makeRecord("sess-old"), {
      terminalId: "term-1",
      generation: oldGeneration,
    });

    expect(written).toBe(true);
    expect(await readSessionHistory(userDataDir)).toHaveLength(1);
  });

  it("fails open for terminals the ledger never saw", async () => {
    const written = await journalAgentSession(makeRecord("sess-unknown"), {
      terminalId: "term-unseen",
    });
    expect(written).toBe(true);
    expect(await readSessionHistory(userDataDir)).toHaveLength(1);
    // No anomaly for the fail-open path — it is not an invariant violation.
    expect(getLifecycleLedger().getAnomalies()).toEqual([]);
  });

  it("falls back to the current ledger generation when none is supplied", async () => {
    const ledger = getLifecycleLedger();
    ledger.recordLaunch("term-1", { launchAgentId: "claude" });

    expect(await journalAgentSession(makeRecord("sess-1"), { terminalId: "term-1" })).toBe(true);
    expect(await journalAgentSession(makeRecord("sess-1"), { terminalId: "term-1" })).toBe(false);
    expect(await readSessionHistory(userDataDir)).toHaveLength(1);
  });

  it("null generation journals fail-open and never reserves a respawned slot (#11340)", async () => {
    const ledger = getLifecycleLedger();
    // The same terminal id has respawned; the current generation belongs to the
    // successor incarnation. (Simulates an evicted predecessor whose captured
    // generation was frozen as null by a project-teardown journal.)
    const successorGen = ledger.recordLaunch("term-1", { launchAgentId: "claude" });

    // Journaling the predecessor's session with an explicit null must NOT gate
    // on the successor's current generation...
    expect(
      await journalAgentSession(makeRecord("sess-old"), { terminalId: "term-1", generation: null })
    ).toBe(true);

    // ...so the successor's own record at its real generation still lands. With
    // the old `?? currentGeneration` fallback the predecessor would have
    // consumed this slot and this write would be dropped.
    expect(
      await journalAgentSession(makeRecord("sess-new"), {
        terminalId: "term-1",
        generation: successorGen,
      })
    ).toBe(true);
    expect(await readSessionHistory(userDataDir)).toHaveLength(2);
  });

  it("releases the journal reservation when persistence fails, so a retry still lands", async () => {
    const ledger = getLifecycleLedger();
    const generation = ledger.recordLaunch("term-1", { launchAgentId: "claude" });

    // Force the first persist to fail: point the journal at a directory. The
    // read-modify-write now rejects while reading (EISDIR ⇒ unreadable), before
    // it would ever overwrite — proving the abort path propagates the failure.
    const filePath = path.join(userDataDir, "agent-session-history.json");
    await fsp.mkdir(filePath, { recursive: true });

    await expect(
      journalAgentSession(makeRecord("sess-1"), { terminalId: "term-1", generation })
      // Assert the specific unreadable-read abort (not just any throw): with the
      // fix reverted, the failure would come from the atomic write, not the read.
    ).rejects.toThrow(/could not be read/);

    // A failed persist must NOT emit the "recorded" signal — the reservation is
    // rescinded, not consumed, so the retry below is not gated out as a duplicate.
    expect(recordedEvents).toEqual([]);

    await fsp.rm(filePath, { recursive: true, force: true });

    // The failed attempt must not have consumed the generation's journal slot.
    const retried = await journalAgentSession(makeRecord("sess-1"), {
      terminalId: "term-1",
      generation,
    });
    expect(retried).toBe(true);
    expect(await readSessionHistory(userDataDir)).toHaveLength(1);
    // Exactly one "recorded" event overall — only the successful retry emitted.
    expect(recordedEvents).toEqual([{ sessionId: "sess-1" }]);
  });

  it("applies retention on the main-side write", async () => {
    const ledger = getLifecycleLedger();

    // Seed a record far older than the mocked 30-day retention window.
    const stale = {
      sessionId: "sess-stale",
      agentId: "claude",
      worktreeId: "wt-1",
      title: null,
      projectId: null,
      savedAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    };
    const filePath = path.join(userDataDir, "agent-session-history.json");
    await fsp.writeFile(filePath, JSON.stringify([stale]));

    const generation = ledger.recordLaunch("term-1", { launchAgentId: "claude" });
    await journalAgentSession(makeRecord("sess-fresh"), { terminalId: "term-1", generation });

    const records = await readSessionHistory(userDataDir);
    expect(records.map((r) => r.sessionId)).toEqual(["sess-fresh"]);
  });

  it("journalAgentSessionRecord persists bookmark intent and returns the durable record", async () => {
    const ledger = getLifecycleLedger();
    const generation = ledger.recordLaunch("term-1", { launchAgentId: "claude" });

    const record = await journalAgentSessionRecord(
      makeRecord("sess-1", { bookmark: { bookmarkedAt: 5, label: "Pin" } }),
      { terminalId: "term-1", generation }
    );

    expect(record?.sessionId).toBe("sess-1");
    expect(record?.bookmark).toEqual({ bookmarkedAt: 5, label: "Pin" });
    const onDisk = await readSessionHistory(userDataDir);
    expect(onDisk[0].bookmark).toEqual({ bookmarkedAt: 5, label: "Pin" });
    expect(recordedEvents).toEqual([{ sessionId: "sess-1" }]);
  });

  it("journalAgentSessionRecord returns null and emits nothing on a duplicate generation", async () => {
    const ledger = getLifecycleLedger();
    const generation = ledger.recordLaunch("term-1", { launchAgentId: "claude" });
    await journalAgentSessionRecord(makeRecord("sess-1"), { terminalId: "term-1", generation });
    recordedEvents.length = 0;

    const dup = await journalAgentSessionRecord(
      makeRecord("sess-1", { bookmark: { bookmarkedAt: 1, label: "x" } }),
      { terminalId: "term-1", generation }
    );

    expect(dup).toBeNull();
    expect(recordedEvents).toEqual([]);
  });
});
