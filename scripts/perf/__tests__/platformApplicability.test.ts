import { describe, expect, it } from "vitest";
import { partitionByPlatform, platformApplicabilitySection, scenarioApplicability } from "../run";
import { getScenariosForMode } from "../scenarios";
import type { PerfScenario } from "../types";

function fakeScenario(id: string, platforms?: PerfScenario["platforms"]): PerfScenario {
  return {
    id,
    name: `Fake ${id}`,
    description: "fixture",
    tier: "fast",
    modes: ["smoke"],
    platforms,
    run: () => ({ durationMs: 1 }),
  };
}

describe("scenarioApplicability", () => {
  it("treats an undeclared scenario as supported everywhere", () => {
    expect(scenarioApplicability(fakeScenario("PERF-A"), "win32")).toBe("supported");
    expect(scenarioApplicability(fakeScenario("PERF-A"), "darwin")).toBe("supported");
  });

  it("reads the declaration for the platform asked about, not the one it runs on", () => {
    const scenario = fakeScenario("PERF-A", { win32: "diagnostic", linux: "unsupported" });
    expect(scenarioApplicability(scenario, "win32")).toBe("diagnostic");
    expect(scenarioApplicability(scenario, "linux")).toBe("unsupported");
    expect(scenarioApplicability(scenario, "darwin")).toBe("supported");
  });
});

describe("partitionByPlatform", () => {
  it("leaves an undeclared matrix exactly as it found it", () => {
    // No scenario declares `platforms` yet. The absent case must be today's
    // behaviour to the letter, or this machinery changes numbers by existing.
    const scenarios = getScenariosForMode("smoke");
    const { runnable, skipped, diagnostic } = partitionByPlatform(scenarios, process.platform);
    expect(runnable).toEqual(scenarios);
    expect(skipped).toEqual([]);
    expect(diagnostic.size).toBe(0);
  });

  it("withholds an unsupported scenario from the run and keeps it for reporting", () => {
    // Both halves matter: a scenario the harness silently drops is absent from
    // every table, and an absent scenario reads as a pass.
    const scenario = fakeScenario("PERF-A", { win32: "unsupported" });
    const { runnable, skipped } = partitionByPlatform([scenario], "win32");
    expect(runnable).toEqual([]);
    expect(skipped).toEqual([scenario]);
  });

  it("runs a scenario unsupported somewhere else", () => {
    const scenario = fakeScenario("PERF-A", { win32: "unsupported" });
    const { runnable, skipped, diagnostic } = partitionByPlatform([scenario], "darwin");
    expect(runnable).toEqual([scenario]);
    expect(skipped).toEqual([]);
    expect(diagnostic.size).toBe(0);
  });

  it("runs a diagnostic scenario but marks it as a signal", () => {
    const scenario = fakeScenario("PERF-A", { win32: "diagnostic" });
    const { runnable, skipped, diagnostic } = partitionByPlatform([scenario], "win32");
    expect(runnable).toEqual([scenario]);
    expect(skipped).toEqual([]);
    expect(diagnostic.has("PERF-A")).toBe(true);
  });

  it("sorts a mixed matrix into all three buckets at once", () => {
    const supported = fakeScenario("PERF-A");
    const diagnosticHere = fakeScenario("PERF-B", { win32: "diagnostic" });
    const unsupportedHere = fakeScenario("PERF-C", { win32: "unsupported" });
    const { runnable, skipped, diagnostic } = partitionByPlatform(
      [supported, diagnosticHere, unsupportedHere],
      "win32"
    );
    expect(runnable.map((scenario) => scenario.id)).toEqual(["PERF-A", "PERF-B"]);
    expect(skipped.map((scenario) => scenario.id)).toEqual(["PERF-C"]);
    expect([...diagnostic]).toEqual(["PERF-B"]);
  });
});

describe("platformApplicabilitySection", () => {
  it("adds nothing to the report when nothing is skipped or diagnostic", () => {
    // The absent case must leave the report byte-identical to what it was.
    expect(platformApplicabilitySection([], [], "darwin")).toBe("");
  });

  it("names every skipped scenario and says the absence is not a pass", () => {
    const section = platformApplicabilitySection(
      [fakeScenario("PERF-C"), fakeScenario("PERF-D")],
      [],
      "win32"
    );
    expect(section).toContain("## Platform applicability");
    expect(section).toContain("PERF-C");
    expect(section).toContain("PERF-D");
    expect(section).toContain("were NOT run");
    expect(section).toContain("not a pass");
  });

  it("names every diagnostic scenario and refuses it a cross-platform reading", () => {
    const section = platformApplicabilitySection([], ["PERF-B"], "win32");
    expect(section).toContain("PERF-B");
    expect(section).toContain("signals rather than measurements");
    expect(section).toContain("must not be compared against another platform");
  });

  it("opens with a blank line so it appends cleanly to the generated report", () => {
    expect(platformApplicabilitySection([fakeScenario("PERF-C")], [], "win32")).toMatch(/^\n#{2} /);
  });
});
