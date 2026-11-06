import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { load } from "js-yaml";

// Structural guard for #16267. stabilize.yml only runs on a manual dispatch, so
// a PR never exercises it. The perf liveness guard spawns a child per scenario,
// one at a time on Windows, and inside a unit shard it pushed that shard to the
// edge of its timeout. It runs as its own job instead, and that job only counts
// while the `only` selection expects it and stabilize-ok waits on it: a job the
// expected map never names is skipped, and the gate reads that skip as green.

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows/stabilize.yml"
);
const workflow = load(readFileSync(workflowPath, "utf8"));
const { jobs } = workflow;
const liveness = jobs["perf-liveness"];

const LIVENESS_FILE = "scripts/perf/__tests__/scenarioLiveness.test.ts";
const FILE = LIVENESS_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RUNS_LIVENESS = new RegExp(`(?:npx vitest run|npm run test --) ${FILE}(?=\\s|$)`, "m");
const EXCLUDES_LIVENESS = new RegExp(`--exclude[= ]${FILE}(?=\\s|$)`);
const PLATFORM_MATRIX = "${{ fromJSON(needs.matrix-setup.outputs.matrix) }}";
const SELECTION = "needs.matrix-setup.outputs.expected";

// Shell with comments dropped, so a commented-out command never counts.
const code = (step) =>
  typeof step?.run === "string"
    ? step.run
        .split("\n")
        .map((line) => line.replace(/(^|\s)#.*$/, ""))
        .join("\n")
    : "";
const select = code(jobs["matrix-setup"].steps.find((s) => s.id === "select"));

describe("stabilize perf liveness (#16267)", () => {
  it("keeps the liveness file out of every unit shard but not out of a focused run", () => {
    const shards = jobs.test.steps.filter((s) => code(s).includes("--shard="));
    expect(shards.length).toBeGreaterThan(0);
    for (const shard of shards) expect(code(shard)).toMatch(EXCLUDES_LIVENESS);

    const focused = code(jobs.test.steps.find((s) => s.if === "inputs.test_files != ''"));
    expect(focused).toContain("npm run test --");
    expect(focused).not.toMatch(EXCLUDES_LIVENESS);
  });

  it("runs the liveness file in its own job on every selected platform", () => {
    expect(liveness.strategy.matrix).toBe(PLATFORM_MATRIX);
    expect(liveness.strategy["fail-fast"]).toBe(false);
    expect(liveness["runs-on"]).toBe("${{ matrix.os }}");

    const runners = liveness.steps.filter((s) => RUNS_LIVENESS.test(code(s)));
    expect(runners).toHaveLength(1);
    expect(runners[0].if).toBeUndefined();
    expect(runners[0]["continue-on-error"]).toBeUndefined();
  });

  it("is an `only` piece the selection resolves into its expected map", () => {
    expect(liveness.if).toBe(`fromJSON(${SELECTION})['perf-liveness']`);
    expect(select.match(/^\s*ALL="([^"]*)"/m)?.[1].split(/\s+/)).toContain("perf-liveness");

    // The map entry has to carry the piece's own selection, not a constant.
    const jqVar = select.match(/"perf-liveness":\s*\$(\w+)/)?.[1];
    expect(jqVar).toBeDefined();
    const shellVar = select.match(new RegExp(`--argjson ${jqVar} "\\$\\{?(\\w+)\\}?"`))?.[1];
    expect(shellVar).toBeDefined();
    expect(select).toMatch(new RegExp(`^\\s*${shellVar}=\\$\\(has "?perf-liveness"?\\)`, "m"));
  });

  it("holds stabilize-ok to every job the selection can expect", () => {
    const selectable = Object.entries(jobs)
      .filter(([, job]) => String(job.if ?? "").includes(SELECTION))
      .map(([id]) => id);
    expect(selectable).toContain("perf-liveness");
    expect(jobs["stabilize-ok"].needs).toEqual(
      expect.arrayContaining(["matrix-setup", ...selectable])
    );
  });
});
