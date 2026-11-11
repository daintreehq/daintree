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
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const workflow = load(read(".github/workflows/publish-plugin-blocklist.yml"));
const job = workflow.jobs.publish;
const steps = job.steps;
const env = workflow.env;
// js-yaml reads the bare `on:` key as the boolean true.
const triggers = workflow.on ?? workflow[true];

// Shell comments dropped, so a commented-out command doesn't count as run.
const commands = (step) =>
  (step.run ?? "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

const stepIndex = (pattern) => {
  const index = steps.findIndex((s) => pattern.test(`${s.uses ?? ""}\n${commands(s)}`));
  expect(index, `step matching ${pattern}`).toBeGreaterThanOrEqual(0);
  return index;
};

const clauses = (expression) =>
  expression
    .split("&&")
    .map((clause) => clause.trim())
    .sort();

describe("publish-plugin-blocklist workflow", () => {
  it("has a single job", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["publish"]);
  });

  it("publishes to the URL the client fetches", () => {
    expect(env.BLOCKLIST_URL).toBe(PLUGIN_BLOCKLIST_URL);
    expect(`/${env.BLOCKLIST_KEY}`).toBe(new URL(PLUGIN_BLOCKLIST_URL).pathname);
  });

  it("publishes the file the release seed ships, and triggers when it changes", () => {
    const seedSource = read("electron/services/plugin/pluginBlocklistSeed.ts");
    const [, specifier] = seedSource.match(/from\s+"([^"]+\.json)"/);
    const seedFile = path.relative(
      repoRoot,
      path.resolve(repoRoot, "electron/services/plugin", specifier)
    );
    expect(env.BLOCKLIST_FILE).toBe(seedFile.split(path.sep).join("/"));
    expect(existsSync(path.join(repoRoot, env.BLOCKLIST_FILE))).toBe(true);
    expect(triggers.push.paths).toContain(env.BLOCKLIST_FILE);
  });

  it("never overrides where it reads from or publishes to", () => {
    const scopes = [job.env, ...steps.map((s) => s.env)].filter(Boolean);
    for (const scope of scopes) {
      expect(Object.keys(scope).filter((key) => key.startsWith("BLOCKLIST_"))).toEqual([]);
    }
  });

  it("runs only from develop in this repository", () => {
    expect(Object.keys(triggers).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(triggers.push.branches).toEqual(["develop"]);
    expect(clauses(job.if)).toEqual([
      "github.ref == 'refs/heads/develop'",
      "github.repository == 'daintreehq/daintree'",
    ]);
  });

  it("publishes the develop tip one run at a time, so no run rolls the list back", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    // Every develop run must share one group; anything per-run or per-commit
    // in the key would let two runs upload in either order.
    const contexts = [...workflow.concurrency.group.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map(
      ([, expression]) => expression
    );
    // Keyed by ref, so a refused dispatch from another branch can't take a
    // queued develop run's place.
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((expression) => expression === "github.ref")).toBe(true);
    expect(job.concurrency).toBeUndefined();

    const checkout = steps[stepIndex(/actions\/checkout@/)];
    expect(checkout.with.ref).toBe("develop");
  });

  it("validates the committed list before uploading it, then checks the edge", () => {
    const validate = stepIndex(/^npm test -- \S+pluginBlocklistSeed\.test\.ts$/m);
    const testFile = commands(steps[validate]).match(/npm test -- (\S+)/)[1];
    expect(existsSync(path.join(repoRoot, testFile))).toBe(true);

    const upload = stepIndex(/^\s*aws s3 cp /m);
    const verify = stepIndex(/^node scripts\/ci\/verify-plugin-blocklist\.mjs$/m);
    expect(validate).toBeLessThan(upload);
    expect(upload).toBeLessThan(verify);
  });

  it("lets no step be skipped or have its failure ignored", () => {
    for (const step of steps) {
      expect(step.if, step.name).toBeUndefined();
      expect(step["continue-on-error"], step.name).toBeUndefined();
      expect(commands(step), step.name).not.toMatch(/\|\|/);
    }
  });

  it("uploads the one object as JSON without long-lived caching", () => {
    const run = commands(steps[stepIndex(/^\s*aws s3 cp /m)]);
    expect(run).toContain('aws s3 cp "${BLOCKLIST_FILE}" "s3://${R2_BUCKET}/${BLOCKLIST_KEY}"');
    expect(run).toContain("--content-type application/json");
    expect(run).toContain('--cache-control "no-cache, no-store, must-revalidate"');
    expect(run).not.toMatch(/\bsync\b|--recursive/);
  });

  it("hands R2 credentials only to the upload step", () => {
    expect(JSON.stringify(env)).not.toContain("secrets.");
    expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.");
    const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
    expect(withSecrets).toHaveLength(1);
    expect(commands(withSecrets[0])).toContain("aws s3 cp");
    expect(withSecrets[0].env).toMatchObject({
      AWS_ACCESS_KEY_ID: "${{ secrets.R2_ACCESS_KEY_ID }}",
      AWS_SECRET_ACCESS_KEY: "${{ secrets.R2_SECRET_ACCESS_KEY }}",
      R2_ENDPOINT: "${{ secrets.R2_ENDPOINT }}",
      R2_BUCKET: "${{ secrets.DAINTREE_R2_BUCKET }}",
    });
  });
});
