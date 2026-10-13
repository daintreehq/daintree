import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allScenarios } from "../scenarios";
import {
  BASELINE_FRESHNESS_DAYS,
  checkBaselineCoverage,
  checkBaselineFreshness,
  describeForeignReference,
  findStaleBaselineEntries,
  isUsableTimestamp,
  readBaselineEntries,
} from "../lib/baselineCoverage";
import { classifyMetric, isMachineIndependent } from "../lib/comparability";
import { mergeBaselineEntries } from "../run";
import type {
  BaselineEntry,
  BaselineMachine,
  BaselineSummary,
  PerfBudgetConfig,
  PerfScenario,
  RunEnvironment,
} from "../types";

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

  const baselineFiles = readdirSync(CONFIG_DIR)
    .filter((name) => name.startsWith("baseline.") && name.endsWith(".json"))
    .sort();

  /**
   * Ids a given mode can actually compare against.
   *
   * Scoped per mode, not to the whole matrix: `baseline.soak.json` holding a
   * reference for a smoke-only scenario is exactly as uncomparable as one for a
   * scenario that was deleted, because no soak run will ever produce a number
   * to put beside it.
   */
  function liveIdsForMode(mode: string): Set<string> {
    return new Set(
      allScenarios
        .filter((entry) => (entry.modes as readonly string[]).includes(mode))
        .map((entry) => entry.id)
    );
  }

  /**
   * Both supported shapes, merged rather than preferred.
   *
   * `scenarios ?? p95ByScenario` silently ignores legacy entries in a file
   * carrying both, which is the state a partly-migrated baseline is in — and a
   * partly-migrated baseline is precisely where an orphan hides.
   */
  function referencedIds(parsed: unknown): { ids: string[]; keysFound: string[] } {
    if (typeof parsed !== "object" || parsed === null) return { ids: [], keysFound: [] };
    const record = parsed as Record<string, unknown>;
    const ids: string[] = [];
    const keysFound: string[] = [];
    for (const key of ["scenarios", "p95ByScenario"] as const) {
      const map = record[key];
      if (typeof map === "object" && map !== null) {
        keysFound.push(key);
        ids.push(...Object.keys(map));
      }
    }
    return { ids: [...new Set(ids)], keysFound };
  }

  it("finds baseline files to check", () => {
    // A rename that emptied this list would turn every assertion below into a
    // vacuous pass, which is the failure mode this whole file exists to catch.
    expect(baselineFiles.length).toBeGreaterThan(0);
  });

  it.each(baselineFiles)("%s is readable and carries references", (name) => {
    // Asserted separately from the orphan check below, because every way this
    // can go wrong — a renamed key, an empty map, a shape nobody recognises —
    // yields ZERO ids, and zero ids pass an orphan check trivially. A guard
    // whose silent-failure mode is a green tick is not a guard.
    const parsed: unknown = JSON.parse(readFileSync(path.join(CONFIG_DIR, name), "utf8"));
    const { ids, keysFound } = referencedIds(parsed);
    expect(keysFound, `${name} has neither a "scenarios" nor a "p95ByScenario" map`).not.toEqual(
      []
    );
    expect(ids.length, `${name} carries no references at all`).toBeGreaterThan(0);
  });

  it.each(baselineFiles)("%s references no scenario its mode cannot run", (name) => {
    const parsed: unknown = JSON.parse(readFileSync(path.join(CONFIG_DIR, name), "utf8"));
    const mode = name.replace(/^baseline\./, "").replace(/\.json$/, "");
    const live = liveIdsForMode(mode);
    expect(
      live.size,
      `no scenario declares mode "${mode}" — is the filename right?`
    ).toBeGreaterThan(0);

    const { ids } = referencedIds(parsed);
    const orphans = ids.filter((id) => !live.has(id));
    expect(
      orphans,
      `${name} carries references for scenarios ${mode} cannot run: ${orphans.join(", ")}. ` +
        "A reference that can never be compared is litter — delete the entries."
    ).toEqual([]);
  });
});

const MAC: BaselineMachine = { machineLabel: "greg-macbook", platform: "darwin", arch: "arm64" };
const WINDOWS: BaselineMachine = { machineLabel: "greg-thinkpad", platform: "win32", arch: "x64" };

function environment(machine: BaselineMachine): RunEnvironment {
  return {
    ...machine,
    cpuModel: "test-cpu",
    cpuCount: 8,
    totalMemoryMb: 16384,
    osRelease: "test",
    nodeVersion: "v22.13.0",
    electronVersion: null,
    gitVersion: null,
    sourceSha: null,
  };
}

function entry(p95Ms: number, measuredAt: string, machine: BaselineMachine | null): BaselineEntry {
  return { p95Ms, measuredAt, machine };
}

describe("isUsableTimestamp", () => {
  it.each([
    ["what the writer emits", new Date("2026-08-04T12:30:15.204Z").toISOString()],
    ["the committed baselines' own date", "2026-08-04T12:30:15.204Z"],
  ])("accepts %s", (_label, value) => {
    expect(isUsableTimestamp(value, Date.parse("2026-08-31T00:00:00.000Z"))).toBe(true);
  });

  it.each([
    // Date.parse normalises this to 2 March without complaint, so a corrupted
    // stamp becomes a plausible one.
    ["an impossible date it would silently normalise", "2026-02-30T00:00:00.000Z"],
    // Never older than the threshold, so it reads as freshly measured forever.
    ["a far-future date", "9999-01-01T00:00:00.000Z"],
    ["a parseable non-ISO form", "Aug 4 2026"],
    ["an ISO form the writer does not emit", "2026-08-04T12:30:15Z"],
    ["nonsense", "not-a-date"],
  ])("rejects %s", (_label, value) => {
    expect(isUsableTimestamp(value, Date.parse("2026-08-31T00:00:00.000Z"))).toBe(false);
  });

  it("allows a day of clock skew but not a week", () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    expect(isUsableTimestamp("2026-08-31T06:00:00.000Z", now)).toBe(true);
    expect(isUsableTimestamp("2026-09-07T00:00:00.000Z", now)).toBe(false);
  });
});

describe("readBaselineEntries — malformed provenance", () => {
  function withEntry(value: unknown): BaselineSummary {
    return {
      generatedAt: "2026-08-31T00:00:00.000Z",
      mode: "smoke",
      scenarios: { "PERF-100": value },
    } as unknown as BaselineSummary;
  }

  it("drops an entry that cannot say when it was measured", () => {
    // Freshness skips an unparseable date silently, so keeping the value would
    // let an undateable reference behave exactly like a freshly measured one.
    const baseline = withEntry({ p95Ms: 5.5, measuredAt: "not-a-date", machine: MAC });
    expect(readBaselineEntries(baseline)["PERF-100"]).toBeUndefined();
    expect(findStaleBaselineEntries(baseline)).toEqual([]);
  });

  it.each([
    ["label only", { machineLabel: "greg-macbook" }],
    ["no arch", { machineLabel: "greg-macbook", platform: "darwin" }],
    ["empty strings", { machineLabel: "", platform: "", arch: "" }],
    ["not an object", "greg-macbook"],
    ["omitted", undefined],
  ])("nulls a machine that is %s, so it reads as foreign", (_label, machine) => {
    // The defect this exists for: the comparison used to spread the stored
    // machine over the CURRENT environment, so an identity carrying only a
    // matching `machineLabel` had its platform and arch supplied by the machine
    // asking the question, and came out local.
    const baseline = withEntry({ p95Ms: 5.5, measuredAt: "2026-08-31T00:00:00.000Z", machine });
    const stored = readBaselineEntries(baseline)["PERF-100"];
    expect(stored?.machine).toBeNull();
    expect(describeForeignReference(stored!, environment(MAC))).toContain("no usable machine");
  });

  it("still compares a complete identity that really is this machine", () => {
    const baseline = withEntry({
      p95Ms: 5.5,
      measuredAt: "2026-08-31T00:00:00.000Z",
      machine: MAC,
    });
    const stored = readBaselineEntries(baseline)["PERF-100"];
    expect(describeForeignReference(stored!, environment(MAC))).toBeNull();
    expect(describeForeignReference(stored!, environment(WINDOWS))).toContain("different machines");
  });
});

describe("readBaselineEntries", () => {
  it("lifts a legacy file's entries with the file date and no machine", () => {
    // The pre-provenance writer wrote every entry in one pass, so the file date
    // IS each entry's measurement date. The machine was never recorded, and
    // guessing "this one" is the defect the format exists to remove.
    const legacy: BaselineSummary = {
      generatedAt: "2026-02-11T00:00:00.000Z",
      mode: "smoke",
      p95ByScenario: { "PERF-001": 1.77 },
    };
    expect(readBaselineEntries(legacy)).toEqual({
      "PERF-001": entry(1.77, "2026-02-11T00:00:00.000Z", null),
    });
  });

  it("prefers a provenanced entry over a legacy one with the same id", () => {
    const mixed: BaselineSummary = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      mode: "smoke",
      p95ByScenario: { "PERF-001": 1.77 },
      scenarios: { "PERF-001": entry(2.5, "2026-08-30T00:00:00.000Z", MAC) },
    };
    expect(readBaselineEntries(mixed)["PERF-001"]).toEqual(
      entry(2.5, "2026-08-30T00:00:00.000Z", MAC)
    );
  });

  it("drops a non-finite reference instead of carrying it into a comparison", () => {
    const corrupt = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      mode: "smoke",
      p95ByScenario: { "PERF-001": Number.NaN },
      scenarios: {
        "PERF-002": { p95Ms: Number.POSITIVE_INFINITY, measuredAt: "x", machine: null },
      },
    } as unknown as BaselineSummary;
    expect(readBaselineEntries(corrupt)).toEqual({});
  });

  it("returns nothing for a missing file", () => {
    expect(readBaselineEntries(null)).toEqual({});
  });
});

describe("findStaleBaselineEntries", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");

  it("names the stale entry in a file whose other entry was measured today", () => {
    // The exact defect: a merge stamps the FILE with today, so a file-wide
    // freshness check calls the six-month-old reference current.
    const merged: BaselineSummary = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      mode: "smoke",
      scenarios: {
        "PERF-201": entry(3.1, "2026-08-30T00:00:00.000Z", MAC),
        "PERF-001": entry(1.77, "2026-02-28T00:00:00.000Z", MAC),
      },
    };
    expect(findStaleBaselineEntries(merged, 30, now)).toEqual([
      { scenarioId: "PERF-001", ageDays: 183, machineLabel: "greg-macbook" },
    ]);
  });

  it("orders oldest first", () => {
    const file: BaselineSummary = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      mode: "smoke",
      scenarios: {
        "PERF-002": entry(1, "2026-06-30T00:00:00.000Z", MAC),
        "PERF-001": entry(1, "2026-01-30T00:00:00.000Z", MAC),
      },
    };
    expect(findStaleBaselineEntries(file, 30, now).map((stale) => stale.scenarioId)).toEqual([
      "PERF-001",
      "PERF-002",
    ]);
  });

  it("skips an entry whose date cannot be parsed rather than throwing", () => {
    const file: BaselineSummary = {
      generatedAt: "2026-08-30T00:00:00.000Z",
      mode: "smoke",
      scenarios: { "PERF-001": entry(1, "not-a-date", MAC) },
    };
    expect(findStaleBaselineEntries(file, 30, now)).toEqual([]);
  });
});

describe("checkBaselineFreshness — per entry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const now = new Date("2026-08-30T00:00:00.000Z");
  const merged: BaselineSummary = {
    generatedAt: "2026-08-30T00:00:00.000Z",
    mode: "smoke",
    scenarios: {
      "PERF-201": entry(3.1, "2026-08-30T00:00:00.000Z", MAC),
      "PERF-001": entry(1.77, "2026-02-28T00:00:00.000Z", MAC),
    },
  };

  it("does not call a merged file fresh just because it was written today", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkBaselineFreshness(merged, "smoke", 30, now);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("PERF-001");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("PERF-201");
  });

  it("names a stale reference belonging to this run on its own line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkBaselineFreshness(merged, "smoke", 30, now, ["PERF-001"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("the reference for PERF-001 was measured");
  });
});

describe("describeForeignReference", () => {
  it("agrees with comparability.ts that a p95 is machine-dependent", () => {
    // The rule this whole annotation rests on, sourced rather than restated.
    expect(classifyMetric("p95Ms")).toBe("duration");
    expect(isMachineIndependent("duration")).toBe(false);
  });

  it("passes a reference measured on this machine", () => {
    expect(
      describeForeignReference(entry(1, "2026-08-30T00:00:00.000Z", MAC), environment(MAC))
    ).toBeNull();
  });

  it("names the other machine when the reference came from one", () => {
    expect(
      describeForeignReference(entry(1, "2026-08-30T00:00:00.000Z", WINDOWS), environment(MAC))
    ).toContain("greg-thinkpad");
  });

  it("treats an unrecorded machine as foreign rather than as local", () => {
    expect(
      describeForeignReference(entry(1, "2026-08-30T00:00:00.000Z", null), environment(MAC))
    ).toContain("no usable machine");
  });

  it("refuses a same-label reference from another architecture", () => {
    const rosetta: BaselineMachine = { ...MAC, arch: "x64" };
    expect(
      describeForeignReference(entry(1, "2026-08-30T00:00:00.000Z", rosetta), environment(MAC))
    ).toContain("architectures");
  });
});

describe("mergeBaselineEntries", () => {
  const existing = {
    "PERF-001": entry(1.77, "2026-02-11T00:00:00.000Z", null),
    "PERF-104": entry(517.1, "2026-05-01T00:00:00.000Z", WINDOWS),
    "PERF-201": entry(2.9, "2026-05-01T00:00:00.000Z", MAC),
  };

  it("re-dates only the scenario this run measured", () => {
    const merged = mergeBaselineEntries({
      existing,
      measured: [{ id: "PERF-201", p95Ms: 3.4 }],
      measuredAt: "2026-08-30T12:00:00.000Z",
      machine: MAC,
    });

    expect(merged["PERF-201"]).toEqual(entry(3.4, "2026-08-30T12:00:00.000Z", MAC));
    // The defect, pinned: an untouched entry keeps its own date AND its own
    // machine, so a Windows reference cannot come back looking Mac-measured.
    expect(merged["PERF-104"]).toEqual(existing["PERF-104"]);
    expect(merged["PERF-001"]).toEqual(existing["PERF-001"]);
  });

  it("carries an inherited entry through when the run measured nothing", () => {
    // What a diagnostic or unsupported scenario produces: nothing in `measured`,
    // so the prior reference survives untouched rather than being re-dated.
    const merged = mergeBaselineEntries({
      existing,
      measured: [],
      measuredAt: "2026-08-30T12:00:00.000Z",
      machine: MAC,
    });
    expect(merged).toEqual(existing);
  });

  it("sorts entries so a regeneration diff shows only what moved", () => {
    const merged = mergeBaselineEntries({
      existing,
      measured: [{ id: "PERF-002", p95Ms: 1 }],
      measuredAt: "2026-08-30T12:00:00.000Z",
      machine: MAC,
    });
    expect(Object.keys(merged)).toEqual(["PERF-001", "PERF-002", "PERF-104", "PERF-201"]);
  });
});
