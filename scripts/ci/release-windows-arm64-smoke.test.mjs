import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { load } from "js-yaml";

// Regression guard for #10030: the arm64 Windows build must smoke-test its
// own NSIS installer (on the arm64 runner) before the artifact is uploaded,
// so a broken arm64 binary can never reach publish unexercised. These assert
// structural invariants of the workflow, not hardcoded literals — they fail
// if the gate is removed, reordered after upload, or wired to the wrong arch.

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows/release-windows.yml"
);
const workflow = load(readFileSync(workflowPath, "utf8"));

function stepNames(job) {
  return job.steps.map((s) => s.name);
}

function findStep(job, predicate) {
  return job.steps.find(predicate);
}

describe("release-windows arm64 packaged smoke gate (#10030)", () => {
  const arm64 = workflow.jobs["build-daintree-arm64"];

  it("runs the arm64 build on an arm64 runner", () => {
    expect(arm64["runs-on"]).toBe("windows-11-arm");
  });

  it("has a packaged-smoke step that runs the shared smoke runner", () => {
    const smoke = findStep(arm64, (s) => /smoke/i.test(s.name ?? ""));
    expect(smoke, "arm64 build job is missing a smoke-test step").toBeTruthy();
    expect(smoke.run).toContain("node scripts/run-packaged-smoke.mjs");
  });

  it("extracts the arm64-specific nested archive, not the x64 one", () => {
    const smoke = findStep(arm64, (s) => /smoke/i.test(s.name ?? ""));
    expect(smoke.run).toContain("app-arm64.7z");
    expect(smoke.run).not.toContain("app-64.7z");
  });

  it("smoke-tests before uploading the artifact so a failure gates publish", () => {
    const names = stepNames(arm64);
    const smokeIdx = names.findIndex((n) => /smoke/i.test(n ?? ""));
    const uploadIdx = names.findIndex((n) => /upload build artifacts/i.test(n ?? ""));
    expect(smokeIdx).toBeGreaterThanOrEqual(0);
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    expect(smokeIdx).toBeLessThan(uploadIdx);
  });

  it("does not let the smoke step pass through failures silently", () => {
    const smoke = findStep(arm64, (s) => /smoke/i.test(s.name ?? ""));
    // No continue-on-error escape hatch — the gate must be able to fail the job.
    expect(smoke["continue-on-error"]).toBeFalsy();
    // 7z exit codes are checked so a corrupt archive can't slip a truncated payload through.
    expect(smoke.run).toContain("$LASTEXITCODE");
  });

  it("keeps arm64 smoke runner config in parity with the x64 step", () => {
    const x64 = workflow.jobs["build-daintree-x64"];
    const x64Smoke = findStep(x64, (s) => /smoke/i.test(s.name ?? ""));
    const armSmoke = findStep(arm64, (s) => /smoke/i.test(s.name ?? ""));
    expect(x64Smoke, "x64 build job is missing its smoke-test step").toBeTruthy();
    // The two architectures should share the same timeout/retry envelope.
    expect(armSmoke.env.SMOKE_TIMEOUT_MS).toBe(x64Smoke.env.SMOKE_TIMEOUT_MS);
    expect(armSmoke.env.SMOKE_RETRIES).toBe(x64Smoke.env.SMOKE_RETRIES);
    expect(armSmoke["timeout-minutes"]).toBe(x64Smoke["timeout-minutes"]);
  });
});
