import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  MIN_CALIBRATION_PAIRS,
  TURN_OUTCOME_CLASS_ORDER,
  assessReadiness,
  computeClassDistribution,
  computeConfusionMatrix,
  computeKappa,
  computePSI,
  defaultProfileDir,
  ensureChronological,
  filterBaselineWindow,
  isPsiDrift,
  joinCalibrationPairs,
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

const normalize = (value: string) => value.replace(/\\/g, "/");

// scripts/eval is in no typecheck project, so the union is read from source.
function readTurnOutcomeUnion(): string[] {
  const file = path.resolve(__dirname, "../../../shared/types/ipc/mcpServer.ts");
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  let members: string[] | null = null;
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== "TurnOutcomeClass") return;
    if (!ts.isUnionTypeNode(node.type)) throw new Error("TurnOutcomeClass is no longer a union");
    members = node.type.types.map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
        throw new Error(`TurnOutcomeClass member is not a string literal: ${member.getText(source)}`);
      }
      return member.literal.text;
    });
  });
  if (!members) throw new Error("TurnOutcomeClass not found in shared/types/ipc/mcpServer.ts");
  return members;
}

describe("TURN_OUTCOME_CLASS_ORDER", () => {
  it("covers every TurnOutcomeClass member exactly once", () => {
    const union = readTurnOutcomeUnion();
    expect(union.length).toBeGreaterThan(0);
    expect(new Set(TURN_OUTCOME_CLASS_ORDER).size).toBe(TURN_OUTCOME_CLASS_ORDER.length);
    expect([...TURN_OUTCOME_CLASS_ORDER].sort()).toEqual([...union].sort());
  });
});

// ---------------------------------------------------------------------------
// resolveStorePath
// ---------------------------------------------------------------------------

describe("resolveStorePath", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turn-outcome-resolve-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("appends daintree.db to an explicit profile directory", () => {
    expect(resolveStorePath(tmp, {})).toBe(path.join(tmp, "daintree.db"));
  });

  it("returns an explicit file path as given, resolved against cwd", () => {
    const db = path.join(tmp, "copy.db");
    fs.writeFileSync(db, "");
    expect(resolveStorePath(db, {})).toBe(db);
    expect(resolveStorePath("relative/daintree.db", {})).toBe(path.resolve("relative/daintree.db"));
  });

  it("keeps a config.json path so the loader can reject it, even beside a database", () => {
    const config = path.join(tmp, "config.json");
    fs.writeFileSync(config, "{}");
    fs.writeFileSync(path.join(tmp, "daintree.db"), "");
    expect(resolveStorePath(config, {})).toBe(config);
  });

  it("prefers --store-path over DAINTREE_USER_DATA", () => {
    const other = path.join(tmp, "other");
    fs.mkdirSync(other);
    expect(resolveStorePath(other, { DAINTREE_USER_DATA: tmp })).toBe(
      path.join(other, "daintree.db")
    );
  });

  it("treats DAINTREE_USER_DATA as a profile directory, existing or not", () => {
    expect(resolveStorePath(undefined, { DAINTREE_USER_DATA: tmp })).toBe(
      path.join(tmp, "daintree.db")
    );
    const missing = path.join(tmp, "not-created-yet");
    expect(resolveStorePath(undefined, { DAINTREE_USER_DATA: missing })).toBe(
      path.join(missing, "daintree.db")
    );
  });

  it("keeps a DAINTREE_USER_DATA that names a file so the loader can reject it", () => {
    const config = path.join(tmp, "config.json");
    fs.writeFileSync(config, "{}");
    expect(resolveStorePath(undefined, { DAINTREE_USER_DATA: config })).toBe(config);
  });

  it("falls back to the packaged profile with no flag and no env", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    expect(normalize(resolveStorePath(undefined, {}))).toMatch(
      /Library\/Application Support\/Daintree\/daintree\.db$/
    );
  });
});

describe("defaultProfileDir", () => {
  const home = path.join(path.sep, "home", "user");

  it("uses Application Support on macOS", () => {
    expect(defaultProfileDir("darwin", {}, home)).toBe(
      path.join(home, "Library", "Application Support", "Daintree")
    );
  });

  it("uses APPDATA on Windows, with the roaming profile as fallback", () => {
    const appData = path.join(path.sep, "roaming");
    expect(defaultProfileDir("win32", { APPDATA: appData }, home)).toBe(
      path.join(appData, "Daintree")
    );
    expect(defaultProfileDir("win32", {}, home)).toBe(
      path.join(home, "AppData", "Roaming", "Daintree")
    );
  });

  it("uses XDG_CONFIG_HOME on Linux, with ~/.config as fallback", () => {
    const xdg = path.join(path.sep, "xdg");
    expect(defaultProfileDir("linux", { XDG_CONFIG_HOME: xdg }, home)).toBe(
      path.join(xdg, "Daintree")
    );
    expect(defaultProfileDir("linux", {}, home)).toBe(path.join(home, ".config", "Daintree"));
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
    expect(warnings).toEqual(["turn-outcome records are not an array"]);
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
    expect(warnings).toEqual([expect.stringContaining('unknown outcome "invalid-class"')]);
  });

  it("loads reasoning-loop records and counts them in the distribution and sample", () => {
    const raw = [
      { id: "1", timestamp: 1000, outcome: "reasoning-loop" },
      { id: "2", timestamp: 2000, outcome: "answered" },
    ];
    const { records, warnings } = loadRecords(raw);
    expect(warnings).toEqual([]);
    expect(records.map((r) => r.id)).toEqual(["1", "2"]);
    expect(computeClassDistribution(records).counts["reasoning-loop"]).toBe(1);
    const sample = stratifiedSample(records, 10);
    expect(sample.metadata.classCountsBefore["reasoning-loop"]).toBe(1);
    expect(sample.metadata.absentClasses).not.toContain("reasoning-loop");
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
    expect(metadata.absentClasses).toEqual([...TURN_OUTCOME_CLASS_ORDER]);
  });

  it("no duplicates in sample", () => {
    const records = Array.from({ length: 50 }, (_, i) => makeRecord({ id: `rec-${i}` }));
    const { records: sample } = stratifiedSample(records, 20);
    const ids = new Set(sample.map((r) => r.id));
    expect(ids.size).toBe(sample.length);
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
});

// ---------------------------------------------------------------------------
// computeConfusionMatrix
// ---------------------------------------------------------------------------

describe("computeConfusionMatrix", () => {
  it("builds correct matrix", () => {
    const pred: TurnOutcomeClass[] = ["answered", "answered", "hedged"];
    const exp: TurnOutcomeClass[] = ["answered", "hedged", "hedged"];
    const cm = computeConfusionMatrix(pred, exp);
    expect(cm.matrix.length).toBe(TURN_OUTCOME_CLASS_ORDER.length);
    expect(cm.matrix[0].length).toBe(TURN_OUTCOME_CLASS_ORDER.length);
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

  it("accepts a reasoning-loop label", () => {
    const { labels, warnings } = loadCalibration([{ recordId: "r1", expected: "reasoning-loop" }]);
    expect(warnings).toEqual([]);
    expect(labels).toEqual([{ recordId: "r1", expected: "reasoning-loop" }]);
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
// joinCalibrationPairs + assessReadiness
// ---------------------------------------------------------------------------

describe("joinCalibrationPairs", () => {
  it("pairs only labels whose record was judged", () => {
    const judged = [makeRecord({ id: "a" }), makeRecord({ id: "b" })];
    const calibration = [
      { record: makeRecord({ id: "a" }), expected: "answered" as TurnOutcomeClass },
      { record: makeRecord({ id: "z" }), expected: "hedged" as TurnOutcomeClass },
      { record: makeRecord({ id: "b" }), expected: "reasoning-loop" as TurnOutcomeClass },
    ];
    expect(joinCalibrationPairs(judged, ["refused", "reasoning-loop"], calibration)).toEqual([
      { predicted: "refused", expected: "answered" },
      { predicted: "reasoning-loop", expected: "reasoning-loop" },
    ]);
  });
});

describe("assessReadiness", () => {
  const judged = { dryRun: false, calibrationLoaded: true };

  it("is ready at the pair floor with a passing kappa", () => {
    const r = assessReadiness({ ...judged, pairs: MIN_CALIBRATION_PAIRS, kappa: 0.7 });
    expect(r).toMatchObject({ ready: true, exitCode: 0 });
    expect(r.warning).toBeUndefined();
    expect(r.verdict).toMatch(/^READY/);
  });

  it("blames the pair count, not kappa, when kappa passes but pairs fall short", () => {
    const r = assessReadiness({ ...judged, pairs: MIN_CALIBRATION_PAIRS - 1, kappa: 1 });
    expect(r).toMatchObject({ ready: false, exitCode: 1 });
    expect(r.verdict).toContain(`${MIN_CALIBRATION_PAIRS - 1} judge-calibration pairs`);
    expect(r.verdict).not.toContain("threshold");
    expect(r.warning).toContain(`Only ${MIN_CALIBRATION_PAIRS - 1} calibration labels joined`);
  });

  it("fails a low kappa over enough pairs", () => {
    const r = assessReadiness({ ...judged, pairs: 40, kappa: 0.69 });
    expect(r).toMatchObject({ ready: false, exitCode: 1 });
    expect(r.warning).toBeUndefined();
    expect(r.verdict).toContain("below the 0.70 threshold");
  });

  it("fails a judged run whose calibration set does not overlap the sample", () => {
    const r = assessReadiness({ ...judged, pairs: 0 });
    expect(r).toMatchObject({ ready: false, exitCode: 1 });
    expect(r.verdict).toContain("no calibration label matches a judged record");
    expect(r.warning).toBeDefined();
  });

  it("fails a judged run with no calibration set", () => {
    const r = assessReadiness({ dryRun: false, calibrationLoaded: false, pairs: 0 });
    expect(r).toMatchObject({ ready: false, exitCode: 1 });
    expect(r.verdict).toContain("--calibration-path");
  });

  it("keeps a dry run exiting 0 without a small-sample warning", () => {
    const r = assessReadiness({ dryRun: true, calibrationLoaded: true, pairs: 0 });
    expect(r).toMatchObject({ ready: false, exitCode: 0 });
    expect(r.warning).toBeUndefined();
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

  it("leaves storePath unset when the flag is absent so the default profile applies", () => {
    const opts = parseArgs([]);
    expect(opts.help).toBe(false);
    expect(opts.storePath).toBeUndefined();
  });
});
