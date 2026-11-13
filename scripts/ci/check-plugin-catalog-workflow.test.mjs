import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
// A developer's global signing settings would otherwise apply to the fixtures.
const GIT_FIXTURE_CONFIG = [
  "user.email=ci@example.test",
  "user.name=CI",
  "commit.gpgsign=false",
  "tag.gpgsign=false",
].flatMap((setting) => ["-c", setting]);
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

  it("sets its outputs from the diff it runs", () => {
    // Runs the step's own script in a repository whose HEAD has the base as its
    // first parent, the shape of a pull request's merge commit.
    const outputs = (changeCatalog) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-catalog-job-"));
      try {
        const git = (...args) =>
          execFileSync("git", [...GIT_FIXTURE_CONFIG, ...args], {
            cwd: dir,
            encoding: "utf8",
          }).trim();
        git("init", "-q");
        mkdirSync(path.join(dir, "plugins"));
        writeFileSync(path.join(dir, CATALOG_FILE), '{ "entries": [] }\n');
        git("add", "-A");
        git("commit", "-q", "-m", "base");
        const base = git("rev-parse", "HEAD");
        const changed = changeCatalog ? CATALOG_FILE : "README.md";
        writeFileSync(path.join(dir, changed), '{ "entries": [], "x": 1 }\n');
        git("add", "-A");
        git("commit", "-q", "-m", "change");
        const outputFile = path.join(dir, "github-output");
        writeFileSync(outputFile, "");
        execFileSync("bash", ["-c", step("Find catalog changes").run], {
          cwd: dir,
          env: { ...process.env, GITHUB_OUTPUT: outputFile },
          stdio: "ignore",
        });
        const lines = readFileSync(outputFile, "utf8").trim().split("\n");
        return { base, values: Object.fromEntries(lines.map((line) => line.split("="))) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    const changed = outputs(true);
    expect(changed.values).toEqual({ base: changed.base, changed: "true" });
    const unchanged = outputs(false);
    expect(unchanged.values).toEqual({ base: unchanged.base, changed: "false" });
  });

  it("can't skip the diff or pass on a failed check, and holds no secrets", () => {
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@")).if).toBeUndefined();
    expect(step("Find catalog changes").if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    for (const s of steps) expect(s["continue-on-error"], s.name).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });
});
