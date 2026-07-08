import { describe, it, expect, vi } from "vitest";
import {
  AgentTerminalLifecycleLedger,
  computeEnvProvenance,
  type LedgerAnomaly,
} from "../agentLifecycleLedger.js";

function makeLedger(overrides: ConstructorParameters<typeof AgentTerminalLifecycleLedger>[0] = {}) {
  let tick = 1000;
  return new AgentTerminalLifecycleLedger({ now: () => tick++, ...overrides });
}

describe("computeEnvProvenance", () => {
  it("returns undefined for missing env", () => {
    expect(computeEnvProvenance(undefined)).toBeUndefined();
  });

  it("captures sorted key names and never values", () => {
    const provenance = computeEnvProvenance({
      ZED_TOKEN: "secret-value",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    });
    expect(provenance?.keys).toEqual(["ANTHROPIC_BASE_URL", "ZED_TOKEN"]);
    expect(JSON.stringify(provenance)).not.toContain("secret-value");
  });

  it("hashes independently of key insertion order", () => {
    const a = computeEnvProvenance({ A: "1", B: "2" });
    const b = computeEnvProvenance({ B: "2", A: "1" });
    expect(a?.hash).toBe(b?.hash);
  });

  it("changes hash when a value changes", () => {
    const a = computeEnvProvenance({ A: "1" });
    const b = computeEnvProvenance({ A: "2" });
    expect(a?.hash).not.toBe(b?.hash);
  });
});

describe("recordLaunch / generations", () => {
  it("mints monotonic generations per terminal id", () => {
    const ledger = makeLedger();
    expect(ledger.recordLaunch("t1", {})).toBe(1);
    expect(ledger.recordLaunch("t1", {})).toBe(2);
    expect(ledger.recordLaunch("t2", {})).toBe(1);
    expect(ledger.currentGeneration("t1")).toBe(2);
  });

  it("adopts an externally minted generation", () => {
    const ledger = makeLedger();
    expect(ledger.recordLaunch("t1", {}, { generation: 7 })).toBe(7);
    expect(ledger.currentGeneration("t1")).toBe(7);
  });

  it("resets per-generation state on relaunch", () => {
    const ledger = makeLedger();
    const gen1 = ledger.recordLaunch("t1", { agentModelId: "opus" });
    ledger.recordFirstAttach("t1", gen1, 120, 40);
    const gen2 = ledger.recordLaunch("t1", { agentModelId: "sonnet" });
    const entry = ledger.getEntry("t1");
    expect(entry?.generation).toBe(gen2);
    expect(entry?.facts.agentModelId).toBe("sonnet");
    expect(entry?.firstAttachCols).toBeUndefined();
  });
});

describe("live-state generation gating", () => {
  it("rejects operations for unknown terminals", () => {
    const ledger = makeLedger();
    const verdict = ledger.recordResize("nope", 1, 80, 24);
    expect(verdict).toMatchObject({ accepted: false, reason: "unknown-terminal" });
  });

  it("rejects stale-generation completions after a relaunch", () => {
    const ledger = makeLedger();
    const gen1 = ledger.recordLaunch("t1", {});
    ledger.recordLaunch("t1", {});
    expect(ledger.recordResize("t1", gen1, 100, 30)).toMatchObject({
      accepted: false,
      reason: "stale-generation",
    });
    expect(ledger.recordRestoreApplied("t1", gen1)).toMatchObject({
      accepted: false,
      reason: "stale-generation",
    });
    expect(ledger.recordSpawnResolved("t1", gen1, true)).toMatchObject({
      accepted: false,
      reason: "stale-generation",
    });
  });

  it("rejects future generations", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {});
    expect(ledger.recordResize("t1", gen + 1, 80, 24)).toMatchObject({
      accepted: false,
      reason: "future-generation",
    });
  });

  it("accepts current-generation operations", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {});
    expect(ledger.recordResize("t1", gen, 120, 40).accepted).toBe(true);
    expect(ledger.recordSpawnResolved("t1", gen, true).accepted).toBe(true);
    expect(ledger.recordRestoreApplied("t1", gen).accepted).toBe(true);
    const entry = ledger.getEntry("t1");
    expect(entry?.spawnOk).toBe(true);
    expect(entry?.restoredAt).toBeDefined();
  });
});

describe("first attach", () => {
  it("records only the first attach geometry", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", { initialCols: 80, initialRows: 24 });
    expect(ledger.recordFirstAttach("t1", gen, 132, 43).accepted).toBe(true);
    expect(ledger.recordFirstAttach("t1", gen, 200, 50).accepted).toBe(true);
    const entry = ledger.getEntry("t1");
    expect(entry?.firstAttachCols).toBe(132);
    expect(entry?.firstAttachRows).toBe(43);
  });
});

describe("detected-agent evolution", () => {
  it("tracks evolution, deduping consecutive repeats and bounding length", () => {
    const ledger = makeLedger({ maxDetectedAgents: 3 });
    const gen = ledger.recordLaunch("t1", { launchAgentId: "claude" });
    ledger.recordDetectedAgent("t1", gen, "claude");
    ledger.recordDetectedAgent("t1", gen, "claude");
    ledger.recordDetectedAgent("t1", gen, "codex");
    ledger.recordDetectedAgent("t1", gen, "claude");
    ledger.recordDetectedAgent("t1", gen, "gemini");
    expect(ledger.getEntry("t1")?.detectedAgentIds).toEqual(["codex", "claude", "gemini"]);
  });
});

describe("worktree attribution", () => {
  it("lets explicit attribution move the terminal", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", { worktreeId: "wt-a", worktreeSource: "explicit" });
    expect(ledger.recordWorktreeAttribution("t1", gen, "wt-b", "explicit").accepted).toBe(true);
    expect(ledger.getEntry("t1")?.facts.worktreeId).toBe("wt-b");
  });

  it("never lets cwd inference overwrite a differing explicit worktree", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", { worktreeId: "wt-a", worktreeSource: "explicit" });
    const verdict = ledger.recordWorktreeAttribution("t1", gen, "wt-b", "inferred");
    expect(verdict).toMatchObject({ accepted: false, reason: "inferred-worktree-overwrite" });
    expect(ledger.getEntry("t1")?.facts.worktreeId).toBe("wt-a");
    expect(ledger.getEntry("t1")?.facts.worktreeSource).toBe("explicit");
  });

  it("accepts inference when it agrees with the explicit id or none exists", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {});
    expect(ledger.recordWorktreeAttribution("t1", gen, "wt-a", "inferred").accepted).toBe(true);
    expect(ledger.getEntry("t1")?.facts.worktreeSource).toBe("inferred");
    const gen2 = ledger.recordLaunch("t2", { worktreeId: "wt-a", worktreeSource: "explicit" });
    expect(ledger.recordWorktreeAttribution("t2", gen2, "wt-a", "inferred").accepted).toBe(true);
  });
});

describe("close: exactly-once per generation", () => {
  it("accepts one close per generation and rejects duplicates", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {});
    expect(ledger.recordClose("t1", gen, "exit", 0).accepted).toBe(true);
    expect(ledger.recordClose("t1", gen, "exit", 0)).toMatchObject({
      accepted: false,
      reason: "duplicate-close",
    });
    expect(ledger.getEntry("t1")?.exitCode).toBe(0);
  });

  it("accepts a close for a PAST generation after the id respawned", () => {
    const ledger = makeLedger();
    const gen1 = ledger.recordLaunch("t1", {});
    const gen2 = ledger.recordLaunch("t1", {});
    // Stale exit from the killed incarnation arrives after the restart.
    expect(ledger.recordClose("t1", gen1, "exit", 137).accepted).toBe(true);
    // It must not touch the live successor's entry.
    expect(ledger.getEntry("t1")?.closedAt).toBeUndefined();
    expect(ledger.getEntry("t1")?.generation).toBe(gen2);
    // And the successor's own close still lands.
    expect(ledger.recordClose("t1", gen2, "exit", 0).accepted).toBe(true);
    expect(ledger.getEntry("t1")?.exitCode).toBe(0);
  });

  it("rejects closes for future generations and unknown terminals", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {});
    expect(ledger.recordClose("t1", gen + 5, "exit")).toMatchObject({
      accepted: false,
      reason: "future-generation",
    });
    expect(ledger.recordClose("ghost", 1, "exit")).toMatchObject({
      accepted: false,
      reason: "unknown-terminal",
    });
  });
});

describe("journal: exactly-once per generation", () => {
  it("accepts one journal per generation and rejects duplicates", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {});
    expect(ledger.recordJournal("t1", gen, "sess-1").accepted).toBe(true);
    expect(ledger.recordJournal("t1", gen, "sess-1")).toMatchObject({
      accepted: false,
      reason: "duplicate-journal",
    });
    // A different sessionId for the same generation is still a duplicate —
    // the incarnation was already journaled.
    expect(ledger.recordJournal("t1", gen, "sess-2")).toMatchObject({
      accepted: false,
      reason: "duplicate-journal",
    });
  });

  it("rescindJournal releases the reservation so a retry can journal", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {});
    expect(ledger.recordJournal("t1", gen, "sess-1").accepted).toBe(true);
    ledger.rescindJournal("t1", gen);
    expect(ledger.getEntry("t1")?.journaledSessionId).toBeUndefined();
    expect(ledger.recordJournal("t1", gen, "sess-1").accepted).toBe(true);
    // Rescinding an unreserved generation is a no-op.
    ledger.rescindJournal("t1", gen + 10);
    ledger.rescindJournal("ghost", 1);
  });

  it("journals each generation independently across respawns", () => {
    const ledger = makeLedger();
    const gen1 = ledger.recordLaunch("t1", {});
    const gen2 = ledger.recordLaunch("t1", {});
    // Kill-path journal for the old incarnation lands after the respawn.
    expect(ledger.recordJournal("t1", gen1, "sess-old").accepted).toBe(true);
    expect(ledger.recordJournal("t1", gen2, "sess-new").accepted).toBe(true);
    expect(ledger.recordJournal("t1", gen1, "sess-old")).toMatchObject({
      accepted: false,
      reason: "duplicate-journal",
    });
    expect(ledger.getEntry("t1")?.journaledSessionId).toBe("sess-new");
  });
});

describe("anomalies", () => {
  it("records rejections in a bounded ring buffer and invokes onAnomaly", () => {
    const seen: LedgerAnomaly[] = [];
    const ledger = makeLedger({ maxAnomalies: 3, onAnomaly: (a) => seen.push(a) });
    const gen1 = ledger.recordLaunch("t1", {});
    ledger.recordLaunch("t1", {});
    for (let i = 0; i < 5; i++) {
      ledger.recordResize("t1", gen1, 80 + i, 24);
    }
    expect(seen).toHaveLength(5);
    const anomalies = ledger.getAnomalies();
    expect(anomalies).toHaveLength(3);
    expect(anomalies[0]).toMatchObject({
      terminalId: "t1",
      op: "resize",
      reason: "stale-generation",
      generation: gen1,
      currentGeneration: 2,
    });
    // Ring keeps the newest entries.
    expect(anomalies[2]?.detail).toBe("84x24");
  });
});

describe("bounds and eviction", () => {
  it("evicts closed entries first, then oldest live", () => {
    const ledger = makeLedger({ maxTerminals: 2 });
    const gen1 = ledger.recordLaunch("t1", {});
    ledger.recordClose("t1", gen1, "exit");
    ledger.recordLaunch("t2", {});
    ledger.recordLaunch("t3", {});
    expect(ledger.getEntry("t1")).toBeUndefined();
    expect(ledger.getEntry("t2")).toBeDefined();
    expect(ledger.getEntry("t3")).toBeDefined();

    ledger.recordLaunch("t4", {});
    // No closed entries — oldest live (t2) goes.
    expect(ledger.getEntry("t2")).toBeUndefined();
    expect(ledger.getEntry("t3")).toBeDefined();
    expect(ledger.getEntry("t4")).toBeDefined();
  });

  it("bounds the generation-mark map", () => {
    const ledger = makeLedger({ maxGenerationMarks: 2 });
    const genA = ledger.recordLaunch("a", {});
    const genB = ledger.recordLaunch("b", {});
    const genC = ledger.recordLaunch("c", {});
    ledger.recordJournal("a", genA, "s-a");
    ledger.recordJournal("b", genB, "s-b");
    ledger.recordJournal("c", genC, "s-c");
    // "a"'s mark was evicted (FIFO), so a re-journal is accepted again —
    // bounded memory trades away dedupe only for the oldest marks.
    expect(ledger.recordJournal("a", genA, "s-a").accepted).toBe(true);
  });
});

describe("diagnostics", () => {
  it("returns a defensive snapshot without env values", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {
      launchAgentId: "claude",
      env: computeEnvProvenance({ SECRET_KEY: "hunter2" }),
    });
    ledger.recordDetectedAgent("t1", gen, "claude");
    const diagnostics = ledger.getDiagnostics();
    expect(diagnostics.terminals).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain("hunter2");
    expect(JSON.stringify(diagnostics)).toContain("SECRET_KEY");

    // Mutating the snapshot must not affect ledger state.
    diagnostics.terminals[0]!.detectedAgentIds.push("evil");
    diagnostics.terminals[0]!.facts.worktreeId = "evil";
    expect(ledger.getEntry("t1")?.detectedAgentIds).toEqual(["claude"]);
    expect(ledger.getEntry("t1")?.facts.worktreeId).toBeUndefined();
  });

  it("clear() resets entries, marks, and anomalies", () => {
    const ledger = makeLedger();
    const gen = ledger.recordLaunch("t1", {});
    ledger.recordJournal("t1", gen, "s");
    ledger.recordResize("ghost", 1, 80, 24);
    ledger.clear();
    expect(ledger.getDiagnostics()).toEqual({ terminals: [], anomalies: [] });
    // Marks cleared too: the same journal is accepted again after clear+relaunch.
    const gen2 = ledger.recordLaunch("t1", {}, { generation: gen });
    expect(ledger.recordJournal("t1", gen2, "s").accepted).toBe(true);
  });
});

describe("uses injected clock", () => {
  it("stamps launchedAt/closedAt from the injected now()", () => {
    const now = vi.fn(() => 42);
    const ledger = new AgentTerminalLifecycleLedger({ now });
    const gen = ledger.recordLaunch("t1", {});
    ledger.recordClose("t1", gen, "exit");
    const entry = ledger.getEntry("t1");
    expect(entry?.launchedAt).toBe(42);
    expect(entry?.closedAt).toBe(42);
  });
});
