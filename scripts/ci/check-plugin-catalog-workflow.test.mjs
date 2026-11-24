import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";

import { CATALOG_FILE } from "./check-plugin-catalog.ts";

// The catalog check is what holds a pull request's new entries to their
// assets, so a job that quietly stops running it, or diffs against the wrong
// base, would let an unchecked listing merge (#16778). The `changes` job reads
// the diff (ci-changes-workflow.test.mjs runs its script); this job checks the
// entries whenever it reports a catalog change.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = load(readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
const job = workflow.jobs["plugin-catalog"];
const steps = job.steps;
const step = (name) => {
  const found = steps.find((s) => s.name === name);
  expect(found, name).toBeDefined();
  return found;
};

describe("ci.yml plugin-catalog job", () => {
  it("runs whenever the diff changes the catalog, and gates ci-ok", () => {
    expect(job.needs).toBe("changes");
    expect(job.if).toBe("needs.changes.outputs.catalog == 'true'");
    expect(workflow.jobs["ci-ok"].needs).toContain("plugin-catalog");
    const classify = workflow.jobs.changes.steps.find((s) => s.name === "Classify changed files");
    expect(classify.run).toContain(CATALOG_FILE.replace(".", "\\."));
  });

  it("checks the changed entries against the merge commit's first parent", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.with["fetch-depth"]).toBeGreaterThanOrEqual(2);
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(step("Install dependencies").uses).toBe("./.github/actions/install");
    const check = step("Check added and changed entries");
    expect(check.if).toBeUndefined();
    expect(check.env.BASE_SHA).toBe("${{ needs.changes.outputs.base }}");
    expect(check.run).toBe('npx tsx scripts/ci/check-plugin-catalog.ts --base "${BASE_SHA}"');
  });

  it("can't pass on a failed check, and holds no secrets", () => {
    expect(job["continue-on-error"]).toBeUndefined();
    for (const s of steps) {
      expect(s.if, s.name).toBeUndefined();
      expect(s["continue-on-error"], s.name).toBeUndefined();
    }
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });
});
