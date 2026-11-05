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
const PLATFORM_MATRIX = "${{ fromJSON(needs.matrix-setup.outputs.matrix) }}";
const SELECTION = "needs.matrix-setup.outputs.expected";

// Shell with comments dropped, so a commented-out command never counts.
const code = (step) =>
  typeof step.run === "string"
    ? step.run
        .split("\n")
        .map((line) => line.replace(/(^|\s)#.*$/, ""))
        .join("\n")
    : "";
const select = code(jobs["matrix-setup"].steps.find((s) => s.id === "select"));

describe("stabilize perf liveness (#16267)", () => {
  it("keeps the liveness file out of the unit shards but not out of a focused run", () => {
    const shard = jobs.test.steps.find((s) => code(s).includes("--shard="));
    expect(code(shard)).toContain(`--exclude ${LIVENESS_FILE}`);
    const focused = jobs.test.steps.find((s) => s.if === "inputs.test_files != ''");
    expect(code(focused)).not.toContain("--exclude");
  });

  it("runs the liveness file in its own job on every selected platform", () => {
    expect(liveness.strategy.matrix).toBe(PLATFORM_MATRIX);
    expect(liveness.strategy["fail-fast"]).toBe(false);
    expect(liveness["runs-on"]).toBe("${{ matrix.os }}");
    expect(liveness.steps.some((s) => code(s).includes(`vitest run ${LIVENESS_FILE}`))).toBe(true);
  });

  it("is an `only` piece the selection resolves into its expected map", () => {
    expect(liveness.if).toBe(`fromJSON(${SELECTION})['perf-liveness']`);
    expect(select).toMatch(/^\s*ALL="[^"]*\bperf-liveness\b/m);
    expect(select).toContain('"perf-liveness": $liveness');
    expect(workflow.on.workflow_dispatch.inputs.only.description).toContain("perf-liveness");
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
