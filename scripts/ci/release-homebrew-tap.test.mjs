import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
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

// Evaluates the job's `if:` for the clause shapes it uses, so the gate is held
// to its outcome rather than its spelling. Any other clause (an `|| true`, a
// stray `&& false`) is unsupported and fails the test instead of passing it.
function evaluateIf(expression, { ref, inputs = {} }) {
  const github = { ref, ref_name: ref.replace(/^refs\/(tags|heads)\//, "") };
  const read = (name) => {
    if (name === "github.ref") return github.ref;
    if (name === "github.ref_name") return github.ref_name;
    if (name.startsWith("inputs.")) return inputs[name.slice("inputs.".length)];
    throw new Error(`unsupported context ${name}`);
  };
  const results = String(expression)
    .split("&&")
    .map((clause) => clause.trim())
    .map((clause) => {
      let m;
      if ((m = /^startsWith\(([\w.]+), '([^']*)'\)$/.exec(clause))) {
        return String(read(m[1]) ?? "").startsWith(m[2]);
      }
      if ((m = /^!contains\(([\w.]+), '([^']*)'\)$/.exec(clause))) {
        return !String(read(m[1]) ?? "").includes(m[2]);
      }
      if ((m = /^(inputs\.\w+) != true$/.exec(clause))) return read(m[1]) !== true;
      throw new Error(`unsupported clause in ${JOB_ID}.if: ${clause}`);
    });
  return results.every(Boolean);
}

function runSecretCheck(token) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tap-secret-"));
  try {
    const output = path.join(dir, "github-output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", stepNamed("Check Homebrew tap token").run], {
      encoding: "utf8",
      env: { ...process.env, HOMEBREW_TAP_TOKEN: token, GITHUB_OUTPUT: output },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
    ["a stable tag push", { ref: "refs/tags/v0.49.0" }, true],
    [
      "a stable tag dispatch",
      { ref: "refs/tags/v0.49.0", inputs: { dry_run: false, skip_notarization: false } },
      true,
    ],
    ["an rc tag", { ref: "refs/tags/v0.50.0-rc.1" }, false],
    ["a beta tag", { ref: "refs/tags/v0.50.0-beta.2" }, false],
    ["a build-metadata tag", { ref: "refs/tags/v0.50.0+build.7" }, false],
    ["a dry run on a tag", { ref: "refs/tags/v0.49.0", inputs: { dry_run: true } }, false],
    [
      "a skip_notarization run",
      { ref: "refs/tags/v0.49.0", inputs: { skip_notarization: true } },
      false,
    ],
    ["a branch dispatch", { ref: "refs/heads/develop", inputs: { dry_run: false } }, false],
    ["a dry run on a branch", { ref: "refs/heads/develop", inputs: { dry_run: true } }, false],
  ])("decides %s", (_label, event, runs) => {
    expect(evaluateIf(job.if, event)).toBe(runs);
  });

  it("serializes tap writes across tags without dropping a waiting release", () => {
    expect(job.concurrency).toEqual({
      group: "homebrew-tap",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  it("checks the token secret first", () => {
    const check = stepNamed("Check Homebrew tap token");
    expect(stepIndex("Check Homebrew tap token")).toBe(0);
    expect(check.id).toBe("tap-secret");
    expect(check.env.HOMEBREW_TAP_TOKEN).toBe("${{ secrets.HOMEBREW_TAP_TOKEN }}");
  });

  it.skipIf(process.platform === "win32")("skips with a notice when the token is empty", () => {
    const { status, stdout, output } = runSecretCheck("");
    expect(status).toBe(0);
    expect(output).toBe("configured=false\n");
    expect(stdout).toMatch(/^::notice::Homebrew tap update skipped/m);
  });

  it.skipIf(process.platform === "win32")("goes ahead silently when the token is set", () => {
    const { status, stdout, output } = runSecretCheck("github_pat_example");
    expect(status).toBe(0);
    expect(output).toBe("configured=true\n");
    expect(stdout).toBe("");
  });

  it.each([
    ["Check out repository", SECRET_GATE],
    ["Check out Homebrew tap", SECRET_GATE],
    ["Set up Node.js", SECRET_GATE],
    ["Generate cask", SECRET_GATE],
    ["Audit cask", WRITTEN_GATE],
    ["Push cask to the tap", WRITTEN_GATE],
  ])("gates %s", (name, gate) => {
    expect(stepNamed(name)?.if).toBe(gate);
  });

  it("has no step the gate table above doesn't know", () => {
    expect(steps.map((s) => s.name)).toEqual([
      "Check Homebrew tap token",
      "Check out repository",
      "Check out Homebrew tap",
      "Set up Node.js",
      "Generate cask",
      "Audit cask",
      "Push cask to the tap",
    ]);
  });

  it("hashes against the tap's current cask, so an old tag can't roll it back", () => {
    const generate = stepNamed("Generate cask");
    expect(generate.id).toBe("cask");
    const command = generate.run.trim();
    expect(command.startsWith("node scripts/ci/homebrew-cask.mjs")).toBe(true);
    expect(command).toContain('--version "${GITHUB_REF_NAME#v}"');
    expect(command).toContain("--existing homebrew-tap/Casks/daintree.rb");
    expect(command).toContain('--out "$RUNNER_TEMP/daintree.rb"');
    const tap = stepNamed("Check out Homebrew tap");
    expect(tap.with).toMatchObject({
      repository: "daintreehq/homebrew-tap",
      token: "${{ secrets.HOMEBREW_TAP_TOKEN }}",
      path: "homebrew-tap",
    });
  });

  it("fails the push when the audit fails", () => {
    const audit = stepNamed("Audit cask");
    expect(audit.run).toMatch(/^set -euo pipefail$/m);
    expect(audit.run).toMatch(/^brew style --cask daintree-release\/audit\/daintree$/m);
    expect(audit.run).toMatch(
      /^brew audit --cask --strict --online --arch=all daintree-release\/audit\/daintree$/m
    );
    expect(audit.run).not.toMatch(/\|\|\s*(true|:)/);
    expect(audit).not.toHaveProperty("continue-on-error");
    expect(stepIndex("Audit cask")).toBeLessThan(stepIndex("Push cask to the tap"));
  });

  it("pushes the cask from the tap checkout, never forced", () => {
    const push = stepNamed("Push cask to the tap");
    expect(push["working-directory"]).toBe("homebrew-tap");
    expect(push.run).toContain('cp "$RUNNER_TEMP/daintree.rb" Casks/daintree.rb');
    expect(push.run).toMatch(/^git push origin HEAD$/m);
    expect(push.run).not.toMatch(/--force|\s-f\b/);
  });

  it("keeps the token out of the source checkout", () => {
    const source = stepNamed("Check out repository");
    expect(source.with["persist-credentials"]).toBe(false);
    expect(source.with).not.toHaveProperty("token");
  });

  it.each(["nightly-publish.yml", "release-linux.yml", "release-windows.yml"])(
    "%s never writes to another repository or the tap",
    (file) => {
      const source = readWorkflow(file);
      expect(source).not.toMatch(/homebrew|HOMEBREW_TAP_TOKEN/i);
      const otherJobs = load(source).jobs;
      for (const [id, other] of Object.entries(otherJobs)) {
        for (const step of other.steps ?? []) {
          expect(step.run ?? "", `${file} ${id} must not git push`).not.toMatch(/\bgit push\b/);
        }
      }
    }
  );
});
