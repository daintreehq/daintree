import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";

import { CATALOG_FILE } from "./check-plugin-catalog.ts";

// The catalog check is what holds a pull request's new entries to their
// assets, so a job that quietly stops running it, or diffs against the wrong
// base, would let an unchecked listing merge (#16778).

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
  it("runs on pull requests and gates ci-ok", () => {
    expect(job.if).toBe("github.event_name == 'pull_request'");
    expect(workflow.jobs["ci-ok"].needs).toContain("plugin-catalog");
  });

  it("diffs the catalog against the merge commit's first parent", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.with["fetch-depth"]).toBeGreaterThanOrEqual(2);
    expect(checkout.with["persist-credentials"]).toBe(false);

    const diff = step("Find catalog changes");
    expect(diff.id).toBe("diff");
    expect(diff.run).toContain("base=$(git rev-parse HEAD^1)");
    expect(diff.run).toContain(`git diff --quiet "\${base}" HEAD -- ${CATALOG_FILE}`);
  });

  it("checks the changed entries against that base whenever the catalog changed", () => {
    const changed = "steps.diff.outputs.changed == 'true'";
    expect(step("Install dependencies").if).toBe(changed);
    const check = step("Check added and changed entries");
    expect(check.if).toBe(changed);
    expect(check.env.BASE_SHA).toBe("${{ steps.diff.outputs.base }}");
    expect(check.run).toBe('npx tsx scripts/ci/check-plugin-catalog.ts --base "${BASE_SHA}"');
  });

  it("can't pass on a failed check, and holds no secrets", () => {
    for (const s of steps) expect(s["continue-on-error"], s.name).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });
});
