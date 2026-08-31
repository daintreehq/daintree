import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allScenarios } from "../scenarios";
import {
  BASELINE_FRESHNESS_DAYS,
  checkBaselineCoverage,
  checkBaselineFreshness,
} from "../lib/baselineCoverage";
import type { BaselineSummary, PerfBudgetConfig, PerfScenario } from "../types";

function scenario(id: string): PerfScenario {
  return {
    id,
    name: id,
    description: id,
    tier: "fast",
    modes: ["ci"],
    run: () => ({ durationMs: 1 }),
  };
}

const budgetConfig: PerfBudgetConfig = {
  defaultBudget: { p95Ms: 5000, maxRegressionPct: 15 },
  scenarios: {
    "PERF-001": { p95Ms: 3500, maxRegressionPct: 15 },
    "PERF-070": { p95Ms: 1200, maxRegressionPct: 15 },
  },
};

// A config whose defaultBudget has no regression gate, so a scenario without an
// override is genuinely not regression-gated (the merge can't reintroduce it).
const noRegressionConfig: PerfBudgetConfig = {
  defaultBudget: { p95Ms: 5000 },
  scenarios: {
    "PERF-200": { p95Ms: 1000 },
  },
};

function baseline(
  p95ByScenario: Record<string, number>,
  generatedAt = "2026-06-01T00:00:00.000Z"
): BaselineSummary {
  return { generatedAt, mode: "ci", p95ByScenario };
}

describe("checkBaselineFreshness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when an entry is older than the threshold", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date("2026-06-07T00:00:00.000Z");
    const old = baseline({ "PERF-001": 1 }, "2026-01-01T00:00:00.000Z"); // ~157 days
    checkBaselineFreshness(old, "ci", BASELINE_FRESHNESS_DAYS, now);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not warn when every entry is within the threshold", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date("2026-06-07T00:00:00.000Z");
    const fresh = baseline({ "PERF-001": 1 }, "2026-06-01T00:00:00.000Z"); // 6 days
    checkBaselineFreshness(fresh, "ci", BASELINE_FRESHNESS_DAYS, now);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn exactly at the threshold boundary", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date("2026-02-01T00:00:00.000Z");
    const atBoundary = baseline({ "PERF-001": 1 }, "2026-01-02T00:00:00.000Z"); // exactly 30 days
    checkBaselineFreshness(atBoundary, "ci", 30, now);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips when no baseline is loaded", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkBaselineFreshness(null, "ci");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not throw or warn on an unparseable timestamp", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = baseline({ "PERF-001": 1 }, "not-a-date");
    expect(() => checkBaselineFreshness(bad, "ci")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("checkBaselineCoverage", () => {
  it("flags a budgeted scenario absent from the baseline", () => {
    const gaps = checkBaselineCoverage(baseline({ "PERF-001": 1 }), budgetConfig, [
      scenario("PERF-070"),
    ]);
    expect(gaps).toEqual([{ scenarioId: "PERF-070" }]);
  });

  it("does not flag a scenario present in the baseline", () => {
    const gaps = checkBaselineCoverage(baseline({ "PERF-070": 900 }), budgetConfig, [
      scenario("PERF-070"),
    ]);
    expect(gaps).toEqual([]);
  });

  it("reports every scenario with a reference but no baseline entry, with no exemptions", () => {
    // PERF-001 was formerly exempt as a "critical" scenario, on the theory that
    // gate.ts failed closed for it at run time. Nothing fails closed now, so the
    // exemption only hid the warning for the scenarios it was meant to protect.
    const gaps = checkBaselineCoverage(baseline({}), budgetConfig, [scenario("PERF-001")]);
    expect(gaps).toEqual([{ scenarioId: "PERF-001" }]);
  });

  it("ignores scenarios without a regression budget", () => {
    const gaps = checkBaselineCoverage(baseline({}), noRegressionConfig, [scenario("PERF-200")]);
    expect(gaps).toEqual([]);
  });

  it("flags scenarios that fall back to the default regression budget", () => {
    // PERF-063 has no explicit budget entry but defaultBudget carries maxRegressionPct.
    const gaps = checkBaselineCoverage(baseline({}), budgetConfig, [scenario("PERF-063")]);
    expect(gaps).toEqual([{ scenarioId: "PERF-063" }]);
  });

  it("flags a non-finite baseline entry as a gap", () => {
    const gaps = checkBaselineCoverage(baseline({ "PERF-070": Number.NaN }), budgetConfig, [
      scenario("PERF-070"),
    ]);
    expect(gaps).toEqual([{ scenarioId: "PERF-070" }]);
  });

  it("returns no gaps when no baseline file is loaded", () => {
    const gaps = checkBaselineCoverage(null, budgetConfig, [scenario("PERF-070")]);
    expect(gaps).toEqual([]);
  });

  it("only reports scenarios scheduled for this run", () => {
    const gaps = checkBaselineCoverage(baseline({ "PERF-070": 900 }), budgetConfig, [
      scenario("PERF-070"),
    ]);
    // PERF-072 is missing from the baseline but is not in this run's scenario set.
    expect(gaps).toEqual([]);
  });
});

/**
 * The direction `checkBaselineCoverage` does not cover.
 *
 * It answers "which scenario has a budget but no reference". The inverse —
 * a reference naming a scenario that no longer exists — has no reader at all:
 * nothing prunes `config/baseline.*.json` when an id is retired, so the entry
 * survives every future run, is never compared against anything, and reads to
 * the next person as a measurement rather than as litter. Four such entries
 * (PERF-040/041/050/051, dated 2026-08-04) outlived their scenarios and were
 * only found by counting a live baseline against a live run.
 *
 * This drives the REAL committed files rather than a fixture, because the
 * defect is rot in those files specifically; a fixture would pass forever
 * while the shipped baselines drifted.
 */
describe("committed baselines name only live scenarios", () => {
  const CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config");

  const liveIds = new Set(allScenarios.map((entry) => entry.id));

  const baselineFiles = readdirSync(CONFIG_DIR)
    .filter((name) => name.startsWith("baseline.") && name.endsWith(".json"))
    .sort();

  it("finds baseline files to check", () => {
    // A rename that emptied this list would turn every assertion below into a
    // vacuous pass, which is the failure mode this whole file exists to catch.
    expect(baselineFiles.length).toBeGreaterThan(0);
  });

  it.each(baselineFiles)("%s references no retired scenario", (name) => {
    const parsed: unknown = JSON.parse(readFileSync(path.join(CONFIG_DIR, name), "utf8"));
    const entries =
      typeof parsed === "object" && parsed !== null
        ? ((parsed as Record<string, unknown>).scenarios ??
          (parsed as Record<string, unknown>).p95ByScenario)
        : undefined;
    const ids = typeof entries === "object" && entries !== null ? Object.keys(entries) : [];

    const orphans = ids.filter((id) => !liveIds.has(id));
    expect(
      orphans,
      `${name} carries references for scenarios that no longer exist: ${orphans.join(", ")}. ` +
        "A reference that can never be compared is litter — delete the entries."
    ).toEqual([]);
  });
});
