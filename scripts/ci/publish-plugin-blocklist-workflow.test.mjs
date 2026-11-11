import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";

import { PLUGIN_BLOCKLIST_URL } from "../../shared/config/pluginBlocklist.ts";

// The publish workflow never runs on a pull request, so these structural
// assertions are the only check in CI that it publishes the right file to the
// URL the client fetches, only from develop, and only after validation (#16774).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = load(
  readFileSync(path.join(repoRoot, ".github/workflows/publish-plugin-blocklist.yml"), "utf8")
);
const job = workflow.jobs.publish;
const steps = job.steps;
const env = workflow.env;
// js-yaml reads the bare `on:` key as the boolean true.
const triggers = workflow.on ?? workflow[true];

const stepIndex = (pattern) => {
  const index = steps.findIndex((s) => pattern.test(`${s.uses ?? ""}\n${s.run ?? ""}`));
  expect(index, `step matching ${pattern}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe("publish-plugin-blocklist workflow", () => {
  it("has a single job", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["publish"]);
  });

  it("publishes to the URL the client fetches", () => {
    expect(env.BLOCKLIST_URL).toBe(PLUGIN_BLOCKLIST_URL);
    expect(`/${env.BLOCKLIST_KEY}`).toBe(new URL(PLUGIN_BLOCKLIST_URL).pathname);
  });

  it("publishes a file that exists and triggers when it changes", () => {
    expect(existsSync(path.join(repoRoot, env.BLOCKLIST_FILE))).toBe(true);
    expect(triggers.push.paths).toContain(env.BLOCKLIST_FILE);
  });

  it("runs only from develop in this repository", () => {
    expect(Object.keys(triggers).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(triggers.push.branches).toEqual(["develop"]);
    expect(job.if).toContain("github.repository == 'daintreehq/daintree'");
    expect(job.if).toContain("github.ref == 'refs/heads/develop'");
  });

  it("publishes the develop tip one run at a time, so no run rolls the list back", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    const checkout = steps[stepIndex(/actions\/checkout@/)];
    expect(checkout.with.ref).toBe("develop");
  });

  it("validates the committed list before uploading it, then checks the edge", () => {
    const validate = stepIndex(/npm test -- \S+pluginBlocklistSeed\.test\.ts/);
    const testFile = steps[validate].run.match(/npm test -- (\S+)/)[1];
    expect(existsSync(path.join(repoRoot, testFile))).toBe(true);

    const upload = stepIndex(/aws s3 cp/);
    const verify = stepIndex(/node scripts\/ci\/verify-plugin-blocklist\.mjs/);
    expect(validate).toBeLessThan(upload);
    expect(upload).toBeLessThan(verify);
    expect(steps.some((s) => s["continue-on-error"])).toBe(false);
  });

  it("uploads the one object as JSON without long-lived caching", () => {
    const run = steps[stepIndex(/aws s3 cp/)].run;
    expect(run).toContain('"${BLOCKLIST_FILE}" "s3://${R2_BUCKET}/${BLOCKLIST_KEY}"');
    expect(run).toContain("--content-type application/json");
    expect(run).toContain('--cache-control "no-cache, no-store, must-revalidate"');
    expect(run).not.toMatch(/\bsync\b|--recursive/);
  });

  it("hands R2 credentials only to the upload step", () => {
    const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
    expect(withSecrets).toHaveLength(1);
    expect(withSecrets[0].run).toContain("aws s3 cp");
    expect(withSecrets[0].env.R2_BUCKET).toBe("${{ secrets.DAINTREE_R2_BUCKET }}");
  });
});
