import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { load } from "js-yaml";

// Guards the Homebrew tap publish (#16419). Release workflows only fire on a v*
// tag or a manual dispatch, so they never run on a PR: these structural
// assertions are the only CI enforcement of who may write to the tap and when.

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows"
);
const readWorkflow = (file) => readFileSync(path.join(workflowsDir, file), "utf8");

const JOB_ID = "publish-homebrew-tap";
const jobs = load(readWorkflow("release-macos.yml")).jobs;
const job = jobs[JOB_ID];
const steps = job?.steps ?? [];
const stepNamed = (name) => steps.find((s) => s.name === name);
const stepIndex = (name) => steps.findIndex((s) => s.name === name);

const SECRET_GATE = "steps.tap-secret.outputs.configured == 'true'";
const WRITTEN_GATE = "steps.cask.outputs.written == 'true'";

describe("release-macos.yml Homebrew tap publish (#16419)", () => {
  it("runs only after the R2 publish succeeded", () => {
    expect(job, `release-macos.yml must define ${JOB_ID}`).toBeDefined();
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(needs).toContain("publish-daintree");
    // Any status function replaces the implicit success() that makes needs block.
    expect(String(job.if)).not.toMatch(/\b(success|always|failure|cancelled)\s*\(/);
    expect(job).not.toHaveProperty("continue-on-error");
  });

  it.each([
    ["a tag ref", "startsWith(github.ref, 'refs/tags/v')"],
    ["not a dry run", "inputs.dry_run != true"],
    ["not a skip_notarization run", "inputs.skip_notarization != true"],
    ["not a prerelease tag", "!contains(github.ref_name, '-')"],
    ["not a build-metadata tag", "!contains(github.ref_name, '+')"],
  ])("requires %s", (_label, clause) => {
    const clauses = String(job.if)
      .split("&&")
      .map((c) => c.trim());
    expect(clauses).toContain(clause);
    expect(String(job.if)).not.toMatch(/\|\|/);
  });

  it("serializes tap writes across tags", () => {
    expect(job.concurrency).toEqual({ group: "homebrew-tap", "cancel-in-progress": false });
  });

  it("skips with a notice when the token secret is missing", () => {
    const check = stepNamed("Check Homebrew tap token");
    expect(check?.id).toBe("tap-secret");
    expect(stepIndex("Check Homebrew tap token")).toBe(0);
    expect(check.env.HOMEBREW_TAP_TOKEN).toBe("${{ secrets.HOMEBREW_TAP_TOKEN }}");
    expect(check.run).toContain('echo "configured=false" >> "$GITHUB_OUTPUT"');
    expect(check.run).toMatch(/::notice::Homebrew tap update skipped/);
    expect(check.run).not.toMatch(/exit 1|::error::/);
  });

  it("gates every later step on the token, directly or through the generated cask", () => {
    for (const step of steps.slice(1)) {
      expect([SECRET_GATE, WRITTEN_GATE], `${step.name} must be gated`).toContain(step.if);
    }
    // The cask output exists only when Generate cask ran, which needs the token.
    expect(stepNamed("Generate cask")?.if).toBe(SECRET_GATE);
  });

  it("guards against rolling the tap back before hashing the published DMGs", () => {
    const generate = stepNamed("Generate cask");
    expect(generate.run).toContain("node scripts/ci/homebrew-cask.mjs");
    expect(generate.run).toContain('--version "${GITHUB_REF_NAME#v}"');
    expect(generate.run).toContain("--existing homebrew-tap/Casks/daintree.rb");
    expect(stepIndex("Check out Homebrew tap")).toBeLessThan(stepIndex("Generate cask"));
    const tap = stepNamed("Check out Homebrew tap");
    expect(tap.with.repository).toBe("daintreehq/homebrew-tap");
    expect(tap.with.path).toBe("homebrew-tap");
  });

  it("audits the cask before pushing it", () => {
    const audit = stepNamed("Audit cask");
    expect(audit.run).toMatch(/brew style --cask /);
    expect(audit.run).toMatch(/brew audit --cask --strict --online --arch=all /);
    expect(audit.run).toMatch(/set -euo pipefail/);
    expect(stepIndex("Audit cask")).toBeLessThan(stepIndex("Push cask to the tap"));
    const push = stepNamed("Push cask to the tap");
    expect(push.if).toBe(WRITTEN_GATE);
    expect(push.run).toMatch(/git push origin HEAD/);
    expect(push.run).not.toMatch(/--force|-f\b/);
  });

  it("keeps the token out of the source checkout", () => {
    const source = stepNamed("Check out repository");
    expect(source.with["persist-credentials"]).toBe(false);
    expect(source.with).not.toHaveProperty("token");
  });

  it.each(["nightly-publish.yml", "release-linux.yml", "release-windows.yml"])(
    "%s never touches the tap",
    (file) => {
      const source = readWorkflow(file);
      expect(source).not.toMatch(/homebrew-tap|HOMEBREW_TAP_TOKEN|homebrew-cask\.mjs/);
    }
  );
});
