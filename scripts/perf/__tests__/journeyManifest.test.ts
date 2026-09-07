import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyBenchmark } from "../config/benchmarkClasses";
import { journeysForFiles, pathMatches } from "../journeys/affected";
import { JOURNEYS } from "../journeys/manifest";
import { REGISTRY } from "../registry";
import { EXPECTED_SCENARIO_IDS } from "../scenarios";

/**
 * Does the user-outcome manifest still point at real things?
 *
 * A manifest is worth exactly as much as its worst stale row. A linked scenario
 * id that no longer exists, a command that was renamed, or an owner path left
 * behind by a directory move all fail the same way: silently, by sending
 * somebody to a benchmark that is not there and letting them conclude the
 * outcome is covered.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

function globMatchesSomething(pattern: string): boolean {
  if (!pattern.endsWith("/**")) return existsSync(path.join(REPO_ROOT, pattern));
  const dir = path.join(REPO_ROOT, pattern.slice(0, -3));
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

describe("journey manifest", () => {
  it("has unique ids", () => {
    const ids = JOURNEYS.map((journey) => journey.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("links only to scenarios that exist", () => {
    const dangling: string[] = [];
    for (const journey of JOURNEYS) {
      for (const id of journey.linkedScenarios) {
        if (!EXPECTED_SCENARIO_IDS.has(id)) dangling.push(`${journey.id} → ${id}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("names only registry commands that exist", () => {
    const dangling: string[] = [];
    for (const journey of JOURNEYS) {
      for (const command of journey.commands) {
        if (!(command in REGISTRY)) dangling.push(`${journey.id} → ${command}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("gives every outcome owner paths that still exist", () => {
    const stale: string[] = [];
    for (const journey of JOURNEYS) {
      expect(journey.ownerPaths.length).toBeGreaterThan(0);
      for (const pattern of journey.ownerPaths) {
        if (!globMatchesSomething(pattern)) stale.push(`${journey.id} → ${pattern}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("uses only the two glob shapes the matcher implements", () => {
    // `pathMatches` handles a literal path and a `dir/**` prefix. Anything else
    // would match nothing and quietly drop the outcome from `perf affected`.
    const unsupported: string[] = [];
    for (const journey of JOURNEYS) {
      for (const pattern of journey.ownerPaths) {
        const stars = (pattern.match(/\*/g) ?? []).length;
        const ok = stars === 0 || (stars === 2 && pattern.endsWith("/**"));
        if (!ok) unsupported.push(`${journey.id} → ${pattern}`);
      }
    }
    expect(unsupported).toEqual([]);
  });

  it("links at least one mechanism scenario to every outcome", () => {
    // The link is what turns "the product got worse" into "look here". An
    // outcome with no mechanism behind it can only ever report the first half.
    const bare: string[] = [];
    for (const journey of JOURNEYS) {
      const mechanisms = journey.linkedScenarios.filter(
        (id) => classifyBenchmark(id)?.kind === "mechanism"
      );
      if (mechanisms.length === 0) bare.push(journey.id);
    }
    expect(bare).toEqual([]);
  });

  it("requires a command for anything claiming full coverage", () => {
    const overclaimed = JOURNEYS.filter(
      (journey) => journey.coverage === "full" && journey.commands.length === 0
    ).map((journey) => journey.id);
    expect(overclaimed).toEqual([]);
  });

  it("requires a gap to name no command, and a covered row to name one", () => {
    const inconsistent = JOURNEYS.filter(
      (journey) =>
        (journey.coverage === "gap" && journey.commands.length > 0) ||
        (journey.coverage !== "gap" && journey.commands.length === 0)
    ).map((journey) => `${journey.id}:${journey.coverage}`);
    expect(inconsistent).toEqual([]);
  });

  it("explains every shortfall", () => {
    const unexplained = JOURNEYS.filter(
      (journey) => journey.coverage !== "full" && journey.coverageNote.trim().length < 40
    ).map((journey) => journey.id);
    expect(unexplained).toEqual([]);
  });

  it("maps a changed file onto the outcomes downstream of it", () => {
    const hits = journeysForFiles(["src/services/terminal/TerminalWriteController.ts"]);
    const ids = [...hits.keys()].map((journey) => journey.id);
    expect(ids).toContain("JOURNEY-003");
    // Additive, not cheapest: terminal code is downstream of launch and switch
    // too, and selecting only one of them is how the wrong benchmark gets run.
    expect(ids).toContain("JOURNEY-001");
    expect(ids).toContain("JOURNEY-002");
  });

  it("matches a prefix glob only at a path boundary", () => {
    expect(pathMatches("src/store/**", "src/store/panelStore.ts")).toBe(true);
    expect(pathMatches("src/store/**", "src/storeAccessors.ts")).toBe(false);
    expect(pathMatches("electron/main.ts", "electron/main.ts")).toBe(true);
    expect(pathMatches("electron/main.ts", "electron/main.test.ts")).toBe(false);
  });

  it("claims nothing for an unrelated change", () => {
    expect(journeysForFiles(["README.md"]).size).toBe(0);
  });
});
