import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";

import { PLUGIN_BLOCKLIST_URL } from "../../shared/config/pluginBlocklist.ts";
import { PLUGIN_CATALOG_URL } from "../../shared/config/pluginCatalog.ts";

// The publish workflows never run on a pull request, so these structural
// assertions are the only check in CI that each one publishes the right file
// to the URL the client fetches, only from develop, and only after validation
// (#16774, #16778). The blocklist and the catalog share one path: a single R2
// object uploaded with `aws s3 cp`, then checked at the edge.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

/** The repo-relative file a source module names through a relative specifier. */
const fileNamedBy = (sourceFile, pattern) => {
  const [, specifier] = read(sourceFile).match(pattern);
  const resolved = path.resolve(repoRoot, path.dirname(sourceFile), specifier);
  return path.relative(repoRoot, resolved).split(path.sep).join("/");
};

// Shell comments dropped, so a commented-out command doesn't count as run.
const commands = (step) =>
  (step.run ?? "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

const clauses = (expression) =>
  expression
    .split("&&")
    .map((clause) => clause.trim())
    .sort();

const LISTS = [
  {
    name: "blocklist",
    workflow: ".github/workflows/publish-plugin-blocklist.yml",
    url: PLUGIN_BLOCKLIST_URL,
    validate: /^npm test -- \S+pluginBlocklistSeed\.test\.ts$/m,
    // Every release ships the published file as its seed.
    publishedFile: () =>
      fileNamedBy("electron/services/plugin/pluginBlocklistSeed.ts", /from\s+"([^"]+\.json)"/),
    beforeUpload: [],
  },
  {
    name: "catalog",
    workflow: ".github/workflows/publish-plugin-catalog.yml",
    url: PLUGIN_CATALOG_URL,
    validate: /^npm test -- \S+publishedPluginCatalog\.test\.ts$/m,
    publishedFile: () =>
      fileNamedBy(
        "electron/services/plugin/__tests__/publishedPluginCatalog.test.ts",
        /readText\("([^"]+catalog\.json)"\)/
      ),
    // Every entry's asset is downloaded again, whatever reached develop.
    beforeUpload: [/^npx tsx scripts\/ci\/check-plugin-catalog\.ts --catalog "\$\{LIST_FILE\}"$/m],
  },
];

const loadWorkflow = (file) => {
  const workflow = load(read(file));
  // js-yaml reads the bare `on:` key as the boolean true.
  return { workflow, triggers: workflow.on ?? workflow[true] };
};

describe.each(LISTS)("publish-plugin-$name workflow", (list) => {
  const { workflow, triggers } = loadWorkflow(list.workflow);
  const job = workflow.jobs.publish;
  const steps = job.steps;
  const env = workflow.env;

  const stepIndex = (pattern) => {
    const index = steps.findIndex((s) => pattern.test(`${s.uses ?? ""}\n${commands(s)}`));
    expect(index, `step matching ${pattern}`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it("has a single job", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["publish"]);
  });

  it("publishes to the URL the client fetches", () => {
    expect(env.LIST_URL).toBe(list.url);
    expect(`/${env.LIST_KEY}`).toBe(new URL(list.url).pathname);
  });

  it("publishes the file the app's own checks read, and triggers when it changes", () => {
    expect(env.LIST_FILE).toBe(list.publishedFile());
    expect(existsSync(path.join(repoRoot, env.LIST_FILE))).toBe(true);
    expect(triggers.push.paths).toContain(env.LIST_FILE);
  });

  it("never overrides where it reads from or publishes to", () => {
    const scopes = [job.env, ...steps.map((s) => s.env)].filter(Boolean);
    for (const scope of scopes) {
      expect(Object.keys(scope).filter((key) => key.startsWith("LIST_"))).toEqual([]);
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

  it("validates the committed file before uploading it, then checks the edge", () => {
    const validate = stepIndex(list.validate);
    const testFile = commands(steps[validate]).match(/npm test -- (\S+)/)[1];
    expect(existsSync(path.join(repoRoot, testFile))).toBe(true);

    const order = [
      validate,
      ...list.beforeUpload.map(stepIndex),
      stepIndex(/^\s*aws s3 cp /m),
      stepIndex(/^node scripts\/ci\/verify-plugin-list\.mjs$/m),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
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
    expect(run).toContain('aws s3 cp "${LIST_FILE}" "s3://${R2_BUCKET}/${LIST_KEY}"');
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

describe("plugin list publish workflows", () => {
  it("publish different objects and never queue behind each other", () => {
    const loaded = LISTS.map((list) => loadWorkflow(list.workflow).workflow);
    const keys = loaded.map((workflow) => workflow.env.LIST_KEY);
    const groups = loaded.map((workflow) => workflow.concurrency.group);
    expect(new Set(keys).size).toBe(LISTS.length);
    expect(new Set(groups).size).toBe(LISTS.length);
  });
});
