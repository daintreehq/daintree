import { describe, expect, it } from "vitest";
import {
  parseVanillaPanelCount,
  totalProcessMetrics,
  vanillaFixtureProblems,
  vanillaPluginPolicy,
} from "../lib/vanillaPluginFixture";

describe("vanilla plugin fixture", () => {
  it("takes its disabled set from the shipped defaults and leaves forge plugins enabled", () => {
    const { defaultDisabledPluginIds, installedPluginIds, projectPluginIds } =
      vanillaPluginPolicy();
    expect(defaultDisabledPluginIds.length).toBeGreaterThan(0);
    expect(defaultDisabledPluginIds.some((id) => /github|gitlab/.test(id))).toBe(false);
    expect(installedPluginIds).toEqual([]);
    expect(projectPluginIds).toEqual([]);
  });

  it("accepts only the 20 and 100 panel sizes", () => {
    expect(parseVanillaPanelCount("20")).toBe(20);
    expect(parseVanillaPanelCount("100")).toBe(100);
    expect(() => parseVanillaPanelCount("50")).toThrow(/--panels/);
    expect(() => parseVanillaPanelCount(undefined)).toThrow(/--panels/);
  });

  it("passes a run that matches vanilla", () => {
    expect(
      vanillaFixtureProblems({
        panelCount: 20,
        livePanelCount: 20,
        installedPluginIds: [],
        projectPluginIds: [],
      })
    ).toEqual([]);
  });

  it("rejects a run with the wrong panel count, or an installed or project plugin", () => {
    const problems = vanillaFixtureProblems({
      panelCount: 100,
      livePanelCount: 99,
      installedPluginIds: ["acme.dash"],
      projectPluginIds: ["project__p__x"],
    });
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/expected 100 panels, found 99/);
    expect(problems.join("\n")).toMatch(/acme\.dash/);
    expect(problems.join("\n")).toMatch(/project__p__x/);
  });

  it("totals process metrics and counts utility processes", () => {
    const totals = totalProcessMetrics([
      { type: "Browser", cpuCumulativeSeconds: 1, workingSetKb: 100, idleWakeupsPerSecond: 2 },
      { type: "Utility", cpuCumulativeSeconds: 0.5, workingSetKb: 50, idleWakeupsPerSecond: 1 },
    ]);
    expect(totals).toEqual({
      processCount: 2,
      utilityProcessCount: 1,
      cpuSeconds: 1.5,
      workingSetKb: 150,
      idleWakeupsPerSecond: 3,
    });
  });
});
