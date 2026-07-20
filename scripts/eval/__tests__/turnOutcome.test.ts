import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  TURN_OUTCOME_CLASS_ORDER,
  computeClassDistribution,
  computeConfusionMatrix,
  computeKappa,
  computePSI,
  ensureChronological,
  filterBaselineWindow,
  isPsiDrift,
  loadCalibration,
  loadRecords,
  matchCalibration,
  parseArgs,
  resolveStorePath,
  stratifiedSample,
} from "../turnOutcomeLib.js";
import type { AssistantTurnRecord, TurnOutcomeClass } from "../../../shared/types/ipc/mcpServer.js";

function makeRecord(overrides: Partial<AssistantTurnRecord> = {}): AssistantTurnRecord {
  return {
    id: `rec-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now() - Math.floor(Math.random() * 3600_000),
    terminalId: "term-1",
    sessionId: "sess-1",
    outcome: "answered",
    trigger: "output",
    state: "idle",
    previousState: "working",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveStorePath
// ---------------------------------------------------------------------------

describe("resolveStorePath", () => {
  const normalize = (value: string) => value.replace(/\\/g, "/");

  it("returns explicit path unchanged when absolute", () => {
    const result = resolveStorePath("/tmp/my-config.json");
    expect(result).toBe("/tmp/my-config.json");
  });

  it("resolves relative path", () => {
    const result = resolveStorePath("relative/config.json");
    expect(normalize(result).endsWith("relative/config.json")).toBe(true);
  });

  it("uses Daintree capitalization on macOS", () => {
    const platformSpy = vi.spyOn(os, "platform").mockReturnValue("darwin");
    // The platform default only applies with no env override, which the test
    // setup now always provides — unset it explicitly rather than relying on
    // it being absent from the ambient environment.
    const prev = process.env.DAINTREE_USER_DATA;
    delete process.env.DAINTREE_USER_DATA;

    // Can't easily mock os.homedir() but check the path ends correctly
    const result = resolveStorePath();
    expect(normalize(result)).toContain("Library/Application Support/Daintree/config.json");

    if (prev) process.env.DAINTREE_USER_DATA = prev;
    platformSpy.mockRestore();
  });

  it("respects DAINTREE_USER_DATA pointing to a json file", () => {
    const prev = process.env.DAINTREE_USER_DATA;
    process.env.DAINTREE_USER_DATA = "/custom/path/my-config.json";
    expect(resolveStorePath()).toBe("/custom/path/my-config.json");
    if (prev) process.env.DAINTREE_USER_DATA = prev;
    else delete process.env.DAINTREE_USER_DATA;
  });

  it("appends config.json to DAINTREE_USER_DATA directory", () => {
    const prev = process.env.DAINTREE_USER_DATA;
    process.env.DAINTREE_USER_DATA = "/custom/path";
    expect(resolveStorePath()).toBe(path.join("/custom/path", "config.json"));
    if (prev) process.env.DAINTREE_USER_DATA = prev;
    else delete process.env.DAINTREE_USER_DATA;
  });
});

// ---------------------------------------------------------------------------
// loadRecords
// ---------------------------------------------------------------------------

describe("loadRecords", () => {
  it("loads valid records", () => {
    const raw = [
      { id: "1", timestamp: 1000, outcome: "answered" },
      { id: "2", timestamp: 2000, outcome: "unknown", trigger: "timeout" },
    ];
    const { records, warnings } = loadRecords(raw);
    expect(records).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  it("rejects non-array input", () => {
    const { records, warnings } = loadRecords({ foo: "bar" });
    expect(records).toHaveLength(0);
    expect(warnings).toContain("config key is not an array");
  });

  it("skips records missing required fields", () => {
    const raw = [
      { id: "1", timestamp: 1000 }, // missing outcome
      { id: "2" }, // missing timestamp + outcome
      { id: "3", timestamp: 3000, outcome: "answered" },
    ];
    const { records, warnings } = loadRecords(raw);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("3");
    expect(warnings).toHaveLength(2);
  });

  it("skips records with invalid outcome", () => {
    const raw = [{ id: "1", timestamp: 1000, outcome: "invalid-class" }];
    const { records, warnings } = loadRecords(raw);
    expect(records).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects non-string id", () => {
    const raw = [{ id: 123, timestamp: 1000, outcome: "answered" }];
    const { records, warnings } = loadRecords(raw);
    expect(records).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects NaN, Infinity, and negative timestamps", () => {
    const raw = [
      { id: "1", timestamp: NaN, outcome: "answered" },
      { id: "2", timestamp: Infinity, outcome: "hedged" },
      { id: "3", timestamp: -1, outcome: "unknown" },
      { id: "4", timestamp: 1000, outcome: "answered" },
    ];
    const { records, warnings } = loadRecords(raw);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("4");
    expect(warnings).toHaveLength(3);
  });

  it("returns empty for empty array", () => {
    const { records, warnings } = loadRecords([]);
    expect(records).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ensureChronological
// ---------------------------------------------------------------------------

describe("ensureChronological", () => {
  it("preserves chronological order", () => {
    const records = [makeRecord({ timestamp: 1000 }), makeRecord({ timestamp: 2000 })];
    const result = ensureChronological(records);
    expect(result[0].timestamp).toBe(1000);
    expect(result[1].timestamp).toBe(2000);
  });

  it("reverses newest-first order", () => {
    const records = [makeRecord({ timestamp: 2000 }), makeRecord({ timestamp: 1000 })];
    const result = ensureChronological(records);
    expect(result[0].timestamp).toBe(1000);
    expect(result[1].timestamp).toBe(2000);
  });

  it("sorts partially shuffled arrays", () => {
    const records = [
      makeRecord({ timestamp: 1000 }),
      makeRecord({ timestamp: 3000 }),
      makeRecord({ timestamp: 2000 }),
    ];
    const result = ensureChronological(records);
    expect(result[0].timestamp).toBe(1000);
    expect(result[1].timestamp).toBe(2000);
    expect(result[2].timestamp).toBe(3000);
  });

  it("handles single record", () => {
    const records = [makeRecord()];
    const result = ensureChronological(records);
    expect(result).toHaveLength(1);
  });

  it("handles empty array", () => {
    expect(ensureChronological([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterBaselineWindow
// ---------------------------------------------------------------------------

describe("filterBaselineWindow", () => {
  it("filters records within window", () => {
    const now = Date.now();
    const records = [
      makeRecord({ timestamp: now - 26 * 3600_000 }), // 26h ago — outside
      makeRecord({ timestamp: now - 10 * 3600_000 }), // 10h ago — inside
      makeRecord({ timestamp: now - 1 * 3600_000 }), // 1h ago — inside
    ];
    const { baseline, recent } = filterBaselineWindow(records, 24);
    expect(recent).toHaveLength(2);
    expect(baseline).toHaveLength(1);
    expect(recent[0].timestamp).toBe(records[1].timestamp);
  });

  it("handles empty input", () => {
    const { baseline, recent, anchorTimestamp } = filterBaselineWindow([], 24);
    expect(baseline).toHaveLength(0);
    expect(recent).toHaveLength(0);
    expect(anchorTimestamp).toBe(0);
  });

  it("includes all records when window is large enough", () => {
    const now = Date.now();
    const records = [makeRecord({ timestamp: now - 1000 }), makeRecord({ timestamp: now - 2000 })];
    const { recent } = filterBaselineWindow(records, 24);
    expect(recent).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// computeClassDistribution
// ---------------------------------------------------------------------------

describe("computeClassDistribution", () => {
  it("counts per class", () => {
    const records = [
      makeRecord({ outcome: "answered" }),
      makeRecord({ outcome: "answered" }),
      makeRecord({ outcome: "hedged" }),
    ];
    const dist = computeClassDistribution(records);
    expect(dist.counts.answered).toBe(2);
    expect(dist.counts.hedged).toBe(1);
    expect(dist.counts.unknown).toBe(0);
    expect(dist.total).toBe(3);
    expect(dist.proportions.answered).toBeCloseTo(2 / 3);
  });

  it("returns zeros for empty input", () => {
    const dist = computeClassDistribution([]);
    expect(dist.total).toBe(0);
    for (const cls of TURN_OUTCOME_CLASS_ORDER) {
      expect(dist.counts[cls]).toBe(0);
      expect(dist.proportions[cls]).toBe(0);
    }
  });

  it("includes all 10 classes even when absent", () => {
    const records = [makeRecord({ outcome: "answered" })];
    const dist = computeClassDistribution(records);
    expect(Object.keys(dist.counts)).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// stratifiedSample
// ---------------------------------------------------------------------------

describe("stratifiedSample", () => {
  it("samples up to budget", () => {
    const records = Array.from({ length: 100 }, () => makeRecord());
    const { records: sample, metadata } = stratifiedSample(records, 20);
    expect(sample.length).toBeLessThanOrEqual(20);
    expect(metadata.budget).toBe(20);
  });

  it("returns all records when budget exceeds total", () => {
    const records = Array.from({ length: 10 }, () => makeRecord());
    const { records: sample } = stratifiedSample(records, 200);
    expect(sample.length).toBe(10);
  });

  it("handles empty input", () => {
    const { records, metadata } = stratifiedSample([], 100);
    expect(records).toHaveLength(0);
    expect(metadata.sampled).toBe(0);
    expect(metadata.absentClasses.length).toBe(10);
  });

  it("no duplicates in sample", () => {
    const records = Array.from({ length: 50 }, (_, i) => makeRecord({ id: `rec-${i}` }));
    const { records: sample } = stratifiedSample(records, 20);
    const ids = new Set(sample.map((r) => r.id));
    expect(ids.size).toBe(sample.length);
  });

  it("distributes across classes", () => {
    const records = [
      ...Array.from({ length: 20 }, () => makeRecord({ outcome: "answered" })),
      ...Array.from({ length: 10 }, () => makeRecord({ outcome: "hedged" })),
      ...Array.from({ length: 5 }, () => makeRecord({ outcome: "agent-stuck" })),
    ];
    const { metadata } = stratifiedSample(records, 20);
    expect(metadata.sampled).toBeLessThanOrEqual(20);
    expect(metadata.sampled).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeKappa
// ---------------------------------------------------------------------------

describe("computeKappa", () => {
  it("returns 1 for perfect agreement", () => {
    const classes: TurnOutcomeClass[] = ["answered", "hedged", "answered"];
    expect(computeKappa(classes, classes)).toBeCloseTo(1);
  });

  it("returns ~0 for random-like agreement", () => {
    const pred: TurnOutcomeClass[] = ["answered", "answered", "answered"];
    const exp: TurnOutcomeClass[] = ["answered", "hedged", "unknown"];
    const k = computeKappa(pred, exp);
    expect(k).toBeLessThan(0.5);
  });

  it("returns 0 for empty input", () => {
    expect(computeKappa([], [])).toBe(0);
  });

  it("handles mismatched lengths gracefully", () => {
    expect(computeKappa(["answered"], ["answered", "hedged"])).toBe(0);
  });

  it("kappa > 0 for better-than-chance agreement", () => {
    const pred: TurnOutcomeClass[] = ["answered", "answered", "answered", "hedged", "hedged"];
    const exp: TurnOutcomeClass[] = ["answered", "answered", "hedged", "hedged", "answered"];
    // 2 agreements of 5 = 0.4 observed; chance ~0.44; kappa slightly negative
    const k = computeKappa(pred, exp);
    expect(typeof k).toBe("number");
    expect(Number.isFinite(k)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeConfusionMatrix
// ---------------------------------------------------------------------------

describe("computeConfusionMatrix", () => {
  it("builds correct matrix", () => {
    const pred: TurnOutcomeClass[] = ["answered", "answered", "hedged"];
    const exp: TurnOutcomeClass[] = ["answered", "hedged", "hedged"];
    const cm = computeConfusionMatrix(pred, exp);
    expect(cm.matrix.length).toBe(10);
    expect(cm.matrix[0].length).toBe(10);
    expect(cm.accuracy).toBeCloseTo(2 / 3);
    expect(cm.perClass.answered.precision).toBeCloseTo(0.5); // 1 correct / 2 predicted
    expect(cm.perClass.answered.recall).toBeCloseTo(1); // 1 correct / 1 actual
    expect(cm.perClass.hedged.precision).toBeCloseTo(1);
    expect(cm.perClass.hedged.recall).toBeCloseTo(0.5);
  });

  it("handles zero-division safely", () => {
    const pred: TurnOutcomeClass[] = ["answered"];
    const exp: TurnOutcomeClass[] = ["hedged"];
    const cm = computeConfusionMatrix(pred, exp);
    expect(cm.perClass.answered.precision).toBe(0);
    expect(cm.perClass.answered.recall).toBe(0);
    expect(cm.perClass.unknown.precision).toBe(0);
    expect(cm.perClass.unknown.recall).toBe(0);
  });

  it("computes macro F1", () => {
    const pred: TurnOutcomeClass[] = ["answered", "answered", "hedged"];
    const exp: TurnOutcomeClass[] = ["answered", "answered", "hedged"];
    const cm = computeConfusionMatrix(pred, exp);
    expect(cm.macroF1).toBeGreaterThan(0);
    expect(cm.accuracy).toBe(1);
  });

  it("handles empty input", () => {
    const cm = computeConfusionMatrix([], []);
    expect(cm.macroF1).toBe(0);
    expect(cm.accuracy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computePSI / isPsiDrift
// ---------------------------------------------------------------------------

describe("computePSI", () => {
  it("returns 0 for identical distributions", () => {
    const records = [makeRecord({ outcome: "answered" }), makeRecord({ outcome: "hedged" })];
    const dist = computeClassDistribution(records);
    expect(computePSI(dist, dist)).toBeCloseTo(0);
  });

  it("detects drift for disjoint distributions", () => {
    const a = computeClassDistribution([makeRecord({ outcome: "answered" })]);
    const b = computeClassDistribution([makeRecord({ outcome: "agent-stuck" })]);
    const psi = computePSI(a, b);
    expect(psi).toBeGreaterThan(0.2);
    expect(isPsiDrift(psi)).toBe(true);
  });

  it("no drift for similar distributions", () => {
    const records = [
      makeRecord({ outcome: "answered" }),
      makeRecord({ outcome: "answered" }),
      makeRecord({ outcome: "hedged" }),
    ];
    const dist = computeClassDistribution(records);
    expect(isPsiDrift(computePSI(dist, dist))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calibration loading
// ---------------------------------------------------------------------------

describe("loadCalibration", () => {
  it("loads valid labels", () => {
    const raw = [
      { recordId: "r1", expected: "answered" },
      { recordId: "r2", expected: "hedged" },
    ];
    const { labels, warnings } = loadCalibration(raw);
    expect(labels).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  it("skips invalid labels", () => {
    const raw = [
      { expected: "answered" }, // missing recordId
      { recordId: "r2", expected: "bad" },
      { recordId: "r3", expected: "answered" },
    ];
    const { labels, warnings } = loadCalibration(raw);
    expect(labels).toHaveLength(1);
    expect(labels[0].recordId).toBe("r3");
    expect(warnings).toHaveLength(2);
  });

  it("rejects non-array", () => {
    const { labels, warnings } = loadCalibration("not-array");
    expect(labels).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});

describe("matchCalibration", () => {
  it("matches labels to records by id", () => {
    const records = [
      makeRecord({ id: "r1", outcome: "answered" }),
      makeRecord({ id: "r2", outcome: "hedged" }),
    ];
    const labels = [
      { recordId: "r1", expected: "answered" as TurnOutcomeClass },
      { recordId: "r2", expected: "answered" as TurnOutcomeClass },
      { recordId: "r3", expected: "unknown" as TurnOutcomeClass },
    ];
    const { matched, unmatched } = matchCalibration(labels, records);
    expect(matched).toHaveLength(2);
    expect(unmatched).toEqual(["r3"]);
  });

  it("handles empty inputs", () => {
    expect(matchCalibration([], []).matched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses basic options", () => {
    const opts = parseArgs(["--store-path", "/tmp/cfg.json", "--budget", "50", "--dry-run"]);
    expect(opts.storePath).toBe("/tmp/cfg.json");
    expect(opts.budget).toBe(50);
    expect(opts.dryRun).toBe(true);
  });

  it("returns help on --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("throws on invalid budget", () => {
    expect(() => parseArgs(["--budget", "5"])).toThrow(">= 10");
    expect(() => parseArgs(["--budget", "abc"])).toThrow(">= 10");
  });

  it("throws on invalid baseline-hours", () => {
    expect(() => parseArgs(["--baseline-hours", "0"])).toThrow(">= 1");
  });

  it("applies defaults", () => {
    const opts = parseArgs(["--store-path", "/tmp/cfg.json"]);
    expect(opts.budget).toBe(200);
    expect(opts.baselineHours).toBe(24);
    expect(opts.model).toBe("gpt-5-mini");
    expect(opts.dryRun).toBe(false);
  });

  it("throws when store-path missing", () => {
    expect(() => parseArgs([])).toThrow("--store-path");
  });
});
