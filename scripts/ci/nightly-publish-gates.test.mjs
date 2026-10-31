import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { load } from "js-yaml";

// Structural guard for #15587: nothing reaches the nightly feed until every
// binary it offers has launched in packaged form, and the preload-backdoor
// gate runs before packaging. A nightly client that can't boot can't
// auto-update its way out, so these gates must stay wired to `publish`.

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows/nightly-publish.yml"
);
const workflow = load(readFileSync(workflowPath, "utf8"));
const { build, publish } = workflow.jobs;
const smokeX64 = workflow.jobs["smoke-x64"];

const runs = (step, text) => typeof step.run === "string" && step.run.includes(text);
const indexOf = (job, predicate) => job.steps.findIndex(predicate);
const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const uploadIndex = () => indexOf(build, (s) => s.uses?.startsWith("actions/upload-artifact"));

function packagedSmoke(job, condition) {
  const index = indexOf(
    job,
    (s) => s.if === condition && runs(s, "node scripts/run-packaged-smoke.mjs")
  );
  expect(index, `no packaged smoke step for ${condition}`).toBeGreaterThanOrEqual(0);
  return { index, step: job.steps[index] };
}

describe("nightly-publish gates (#15587)", () => {
  it("checks for preload backdoors after the build and before any packaging", () => {
    const buildIndex = indexOf(build, (s) => /^npm run build$/m.test(s.run ?? ""));
    const checkIndex = indexOf(build, (s) => runs(s, "npm run check:preload-backdoors"));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBeGreaterThan(buildIndex);
    // Every leg packages, so the gate must not be scoped to one OS.
    expect(build.steps[checkIndex].if).toBeUndefined();

    const packageIndexes = build.steps
      .map((s, i) => (runs(s, "electron-builder") ? i : -1))
      .filter((i) => i >= 0);
    expect(packageIndexes.length).toBeGreaterThan(0);
    for (const i of packageIndexes) expect(i).toBeGreaterThan(checkIndex);
  });

  it("launches only packaged binaries, never the dev Electron against dist/", () => {
    for (const step of allSteps) {
      expect(runs(step, "test:smoke"), step.name).toBe(false);
      expect(runs(step, "run-smoke.mjs"), step.name).toBe(false);
    }
  });

  it("smokes the macOS arm64 and universal bundles after packaging, before upload", () => {
    const { index, step } = packagedSmoke(build, "startsWith(matrix.os, 'macos')");
    expect(step.run).toContain("release/mac-arm64/Daintree.app");
    expect(step.run).toContain("release/mac-universal/Daintree.app");
    expect(step.run).toContain('PACKAGED_BINARY="$app/Contents/MacOS/Daintree"');
    const packageIndex = indexOf(build, (s) => s.name === "Package (macOS)");
    expect(index).toBeGreaterThan(packageIndex);
    expect(index).toBeLessThan(uploadIndex());
  });

  it("smokes each Linux AppImage on its own runner after packaging, before upload", () => {
    const { index, step } = packagedSmoke(build, "startsWith(matrix.os, 'ubuntu')");
    expect(step.run).toContain("release/*.AppImage");
    expect(step.run).toContain("--appimage-extract");
    expect(step.run).toContain('PACKAGED_BINARY="$work/squashfs-root/AppRun"');
    expect(step.run).toContain("xvfb-run --auto-servernum node scripts/run-packaged-smoke.mjs");
    const packageIndex = indexOf(build, (s) => s.name === "Package (Linux)");
    expect(index).toBeGreaterThan(packageIndex);
    expect(index).toBeLessThan(uploadIndex());
  });

  it("smokes the shipped x64 macOS zip natively on Intel", () => {
    expect(smokeX64["runs-on"]).toBe("macos-15-intel");
    expect(smokeX64.needs).toEqual(expect.arrayContaining(["build"]));
    const download = smokeX64.steps.find((s) => s.uses?.startsWith("actions/download-artifact"));
    expect(download.with.name).toBe("nightly-macos-15");
    const smoke = smokeX64.steps.find((s) => runs(s, "node scripts/run-packaged-smoke.mjs"));
    expect(smoke.run).toContain("release/Daintree-*-x64-mac.zip");
    expect(smoke.run).toContain("ditto -x -k");
    expect(smoke.run).toContain(
      'PACKAGED_BINARY="release/mac-x64/Daintree.app/Contents/MacOS/Daintree"'
    );
  });

  it("installs the Linux runtime libraries and xvfb before the Linux smoke", () => {
    const { index } = packagedSmoke(build, "startsWith(matrix.os, 'ubuntu')");
    const install = indexOf(
      build,
      (s) => s.if === "startsWith(matrix.os, 'ubuntu')" && /apt-get install[\s\S]*\bxvfb\b/.test(s.run ?? "")
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(index);
  });

  it("publishes only after every gate passed", () => {
    expect(publish.needs).toEqual(expect.arrayContaining(["build", "smoke-x64"]));
    // An `always()`/`!cancelled()` condition would publish past a failed gate.
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.if, name).toBeUndefined();
      expect(job["continue-on-error"], name).toBeUndefined();
    }
    for (const step of allSteps) {
      if (runs(step, "run-packaged-smoke.mjs") || runs(step, "check:preload-backdoors")) {
        expect(step["continue-on-error"], step.name).toBeUndefined();
      }
    }
  });

  it("uploads to R2 only from the publish job", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === "publish") continue;
      for (const step of job.steps) expect(runs(step, "aws s3"), `${name}: ${step.name}`).toBe(false);
    }
  });

  it("stays publish-only: no test suites and no issue-writing permissions", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.permissions, name).toBeUndefined();
    }
    const suite = /\bnpm (?:run )?test\b|\bvitest\b|\bplaywright\b/;
    for (const step of allSteps) {
      expect(suite.test(step.run ?? ""), step.name).toBe(false);
    }
  });
});
