import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkBaselineFreshness,
  describeForeignReference,
  findStaleBaselineEntries,
  readBaselineEntries,
} from "../lib/baselineCoverage";
import { classifyMetric, isMachineIndependent } from "../lib/comparability";
import { mergeBaselineEntries } from "../run";
import type { BaselineEntry, BaselineMachine, BaselineSummary, RunEnvironment } from "../types";

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
