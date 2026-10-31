import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_CALIBRATION_PAIRS } from "../turnOutcomeLib.js";
import { runTurnOutcomeEval, type RunDeps } from "../turnOutcomeRun.js";
import { TURN_OUTCOME_RING } from "../turnOutcomeSource.js";
import type { AssistantTurnRecord } from "../../../shared/types/ipc/mcpServer.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const REPORT_FILE = "turnOutcome-eval-report.json";

let tmp: string;
let profile: string;
let outDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turn-outcome-run-"));
  profile = path.join(tmp, "profile");
  outDir = path.join(tmp, "out");
  fs.mkdirSync(profile);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeProfile(rows: unknown[], otherRings = true): void {
  const db = new DatabaseSync(path.join(profile, "daintree.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE audit_rings (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      ring text NOT NULL,
      record text NOT NULL,
      created_at integer NOT NULL,
      record_id text
    );
  `);
  const insert = db.prepare(
    "INSERT INTO audit_rings (ring, record_id, record, created_at) VALUES (?, ?, ?, ?)"
  );
  if (otherRings) insert.run("mcpAuditLog", "audit-1", JSON.stringify({ id: "audit-1" }), 1);
  for (const row of rows) {
    insert.run(TURN_OUTCOME_RING, null, JSON.stringify(row), 1);
  }
  db.close();
}

function turns(count: number, outcomes: string[]): AssistantTurnRecord[] {
  const base = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => ({
    id: `turn-${i}`,
    timestamp: base + i * 60_000,
    terminalId: "t1",
    sessionId: "s1",
    outcome: outcomes[i % outcomes.length] as AssistantTurnRecord["outcome"],
  }));
}

function harness(env: NodeJS.ProcessEnv = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const judge = vi.fn<RunDeps["judge"]>(async (records) => ({
    // A judge that always agrees with the labels, so kappa is 1 and only the
    // pair count decides readiness.
    predictions: records.map((r) => r.outcome),
    failures: 0,
  }));
  const deps: RunDeps = {
    judge,
    env,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  };
  return { deps, logs, errors, judge };
}

function readReport(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(outDir, REPORT_FILE), "utf8"));
}

describe("runTurnOutcomeEval", () => {
  it("loads the profile's records in a dry run and writes the report", async () => {
    const records = turns(30, ["answered", "reasoning-loop", "tool-error"]);
    writeProfile([...records, { ...records[0], id: "alien", outcome: "not-a-class" }]);
    const { deps, logs, errors, judge } = harness({ DAINTREE_USER_DATA: profile });

    const code = await runTurnOutcomeEval(["--dry-run", "--out-dir", outDir], deps);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
    expect(logs).toContain("Loaded 30 valid records from store");
    const report = readReport();
    expect(report.source).toBe(path.join(profile, "daintree.db"));
    expect(report.ready).toBe(false);
    expect(report).toMatchObject({
      sampleMetadata: { sampled: 30, classCountsBefore: { "reasoning-loop": 10 } },
      distribution: { total: 30, counts: { answered: 10, "reasoning-loop": 10, "tool-error": 10 } },
    });
    expect(report.warnings).toContainEqual(expect.stringContaining('unknown outcome "not-a-class"'));
  });

  it("fails non-zero, naming the path, when the profile has no database", async () => {
    const { deps, errors } = harness();
    const code = await runTurnOutcomeEval(["--store-path", profile, "--out-dir", outDir], deps);
    expect(code).toBe(1);
    expect(errors[0]).toContain(path.join(profile, "daintree.db"));
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("fails non-zero on an old config.json source", async () => {
    const configPath = path.join(profile, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ turnOutcomeLog: turns(3, ["answered"]) }));
    const { deps, errors } = harness();
    const code = await runTurnOutcomeEval(["--store-path", configPath, "--dry-run"], deps);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(configPath);
    expect(errors.join("\n")).toContain("not a SQLite database");
  });

  it("says plainly that an empty ring holds no records and exits 0", async () => {
    writeProfile([]);
    const { deps, logs, errors } = harness();
    const code = await runTurnOutcomeEval(
      ["--store-path", profile, "--dry-run", "--out-dir", outDir],
      deps
    );
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toContain(`No turn-outcome records: the "${TURN_OUTCOME_RING}" ring is empty.`);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("agrees on not-ready when store-wide matches reach the floor but judged pairs do not", async () => {
    const records = turns(25, ["answered", "reasoning-loop"]);
    writeProfile(records);
    const calibrationPath = path.join(tmp, "calibration.json");
    fs.writeFileSync(
      calibrationPath,
      JSON.stringify(records.map((r) => ({ recordId: r.id, expected: r.outcome })))
    );
    const { deps, logs } = harness({ OPENAI_API_KEY: "test-key" });

    const code = await runTurnOutcomeEval(
      [
        "--store-path",
        profile,
        "--budget",
        "10",
        "--calibration-path",
        calibrationPath,
        "--out-dir",
        outDir,
      ],
      deps
    );

    const report = readReport();
    expect(report.calibrationMatched).toBe(25);
    expect(report.calibrationPairs).toBe(10);
    expect(report.kappa).toBe(1);
    expect(report.ready).toBe(false);
    expect(code).toBe(1);
    expect(logs).toContainEqual(expect.stringMatching(/^NOT READY: 10 judge-calibration pairs/));
    expect(report.warnings).toContainEqual(
      expect.stringContaining("Only 10 calibration labels joined to judge predictions")
    );
  });

  it("agrees on ready at the pair floor", async () => {
    const records = turns(30, ["answered", "reasoning-loop"]);
    writeProfile(records);
    const calibrationPath = path.join(tmp, "calibration.json");
    fs.writeFileSync(
      calibrationPath,
      JSON.stringify(records.map((r) => ({ recordId: r.id, expected: r.outcome })))
    );
    const { deps, logs } = harness({ OPENAI_API_KEY: "test-key" });

    const code = await runTurnOutcomeEval(
      [
        "--store-path",
        path.join(profile, "daintree.db"),
        "--budget",
        String(MIN_CALIBRATION_PAIRS),
        "--calibration-path",
        calibrationPath,
        "--out-dir",
        outDir,
      ],
      deps
    );

    const report = readReport();
    expect(report.calibrationPairs).toBe(MIN_CALIBRATION_PAIRS);
    expect(report.ready).toBe(true);
    expect(code).toBe(0);
    expect(logs).toContainEqual(expect.stringMatching(/^READY: kappa 1\.000/));
    expect(report.warnings).not.toContainEqual(expect.stringContaining("calibration labels joined"));
  });

  it("fails a judged run whose calibration set misses the sample", async () => {
    writeProfile(turns(12, ["answered", "hedged"]));
    const calibrationPath = path.join(tmp, "calibration.json");
    fs.writeFileSync(calibrationPath, JSON.stringify([{ recordId: "elsewhere", expected: "hedged" }]));
    const { deps, logs } = harness({ OPENAI_API_KEY: "test-key" });

    const code = await runTurnOutcomeEval(
      ["--store-path", profile, "--calibration-path", calibrationPath, "--out-dir", outDir],
      deps
    );

    expect(code).toBe(1);
    expect(readReport()).toMatchObject({ ready: false, calibrationPairs: 0, calibrationMatched: 0 });
    expect(logs).toContain("NOT READY: no calibration label matches a judged record");
  });
});
