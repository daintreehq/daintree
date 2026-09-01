import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyMetric, isMachineIndependent } from "../lib/comparability";

/**
 * `.agents/skills/optimize/metric-class.mjs` is a hand copy of this module's
 * classifier, kept because `check-pair.mjs` is plain Node run by an agent with
 * no build step while the authority is TypeScript inside the app's project
 * graph. A copy that drifts is worse than no copy: the optimize skill's
 * cross-machine leg uses it to decide whether one number may be claimed for
 * every operating system, so a duration the mirror reads as a count would
 * license exactly the false claim `comparability.ts` exists to refuse.
 *
 * This test is what makes the copy safe. It classifies every metric name the
 * matrix emits — read out of the scenario sources, so it grows with the matrix
 * rather than with anyone remembering to update a list — plus the traps that
 * caught real misfires, and asserts the two classifiers agree on all of them.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCENARIO_DIR = join(HERE, "..", "scenarios");
const MIRROR_URL = pathToFileURL(
  join(HERE, "..", "..", "..", ".agents", "skills", "optimize", "metric-class.mjs")
).href;

type Mirror = {
  classifyMetric: (name: string) => string;
  isMachineIndependent: (cls: string) => boolean;
  classifyTarget: (path: string) => string;
};

async function loadMirror(): Promise<Mirror> {
  return (await import(/* @vite-ignore */ MIRROR_URL)) as Mirror;
}

/**
 * Object keys inside every scenario's `metrics:` block. Deliberately loose — a
 * few non-metric identifiers slipping into the corpus only makes the agreement
 * assertion cover more names, and a missed one is the case that matters.
 */
function metricNamesFromScenarios(): string[] {
  const names = new Set<string>();
  for (const entry of readdirSync(SCENARIO_DIR)) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(join(SCENARIO_DIR, entry), "utf8");
    for (const match of source.matchAll(/^\s{2,}([a-z][A-Za-z0-9]{2,60}):/gm)) {
      names.add(match[1] as string);
    }
  }
  return [...names].sort();
}

// The three that a case-insensitive or suffix-only rule set gets wrong, plus the
// pairs whose ORDER is load-bearing. If the mirror ever reorders its rules these
// are the names that catch it.
const TRAPS = [
  "items",
  "statusPasses",
  "decorations",
  "heapDeltaMb",
  "memoryGrowthPct",
  "spawnsPerWorktreeN50",
  "detectionToIntervalRatio",
  "echoDegradationX",
  "eluUtilization",
  "idleEluPct",
  "payloadBytesPerMessage",
  "msPerKFile",
  "cpuMsPerMb30",
  "coldToWarmRatio",
  "batchSpeedupRatio",
  "prettyToCompactByteRatio",
  "gitSpawns",
  "totalBytes",
  "p50Ms",
  "p95Ms",
  "durationMs",
];

describe("optimize metric-class mirror", () => {
  it("classifies every metric name the matrix emits exactly as the harness does", async () => {
    const mirror = await loadMirror();
    const corpus = [...new Set([...metricNamesFromScenarios(), ...TRAPS])];

    expect(corpus.length).toBeGreaterThan(200);

    const disagreements = corpus
      .map((name) => ({
        name,
        authority: classifyMetric(name),
        mirror: mirror.classifyMetric(name),
      }))
      .filter((row) => row.authority !== row.mirror);

    expect(disagreements).toEqual([]);
  });

  it("agrees on which classes survive a cross-machine comparison", async () => {
    const mirror = await loadMirror();
    for (const cls of [
      "count",
      "size",
      "ratio",
      "memory",
      "duration",
      "derived-ratio",
      "unknown",
    ]) {
      expect(mirror.isMachineIndependent(cls)).toBe(
        isMachineIndependent(cls as Parameters<typeof isMachineIndependent>[0])
      );
    }
  });

  it("reads the metric name out of a check-pair target path", async () => {
    const mirror = await loadMirror();
    expect(mirror.classifyTarget("metricStats.gitSpawns.max")).toBe("count");
    expect(mirror.classifyTarget("metricStats.sweepAckUsAt48.mean")).toBe("duration");
    expect(mirror.classifyTarget("p50Ms")).toBe("duration");
  });
});
