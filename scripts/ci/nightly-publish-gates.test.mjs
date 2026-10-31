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

const MACOS = "startsWith(matrix.os, 'macos')";
const LINUX = "startsWith(matrix.os, 'ubuntu')";
const SMOKE = "node scripts/run-packaged-smoke.mjs";
const PRELOAD = "npm run check:preload-backdoors";

// Shell with comment lines dropped, so a commented-out command never counts.
const code = (step) =>
  typeof step.run === "string"
    ? step.run
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n")
    : "";
const runs = (step, text) => code(step).includes(text);
const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const gateSteps = allSteps.filter((s) => runs(s, SMOKE) || runs(s, PRELOAD));

function stepIndex(job, predicate, what) {
  const index = job.steps.findIndex(predicate);
  expect(index, `missing step: ${what}`).toBeGreaterThanOrEqual(0);
  return index;
}

const packageIndex = (condition) =>
  stepIndex(
    build,
    (s) => s.if === condition && runs(s, "npx electron-builder"),
    `electron-builder for ${condition}`
  );
const uploadIndex = () =>
  stepIndex(build, (s) => s.uses?.startsWith("actions/upload-artifact"), "artifact upload");

function packagedSmoke(condition) {
  const index = stepIndex(build, (s) => s.if === condition && runs(s, SMOKE), `smoke ${condition}`);
  return { index, step: build.steps[index] };
}

describe("nightly-publish gates (#15587)", () => {
  it("checks for preload backdoors after the build and before any packaging", () => {
    const buildIndex = stepIndex(build, (s) => /^npm run build$/m.test(code(s)), "npm run build");
    const checkIndex = stepIndex(build, (s) => runs(s, PRELOAD), PRELOAD);
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
      expect(/\btest:smoke(?!:)|\brun-smoke\.mjs\b/.test(code(step)), step.name).toBe(false);
    }
  });

  it("smokes the macOS arm64 and universal bundles after packaging, before upload", () => {
    const { index, step } = packagedSmoke(MACOS);
    const loop = code(step).match(/^\s*for app in (.+); do$/m);
    expect(loop, "macOS smoke no longer loops over the bundles").not.toBeNull();
    expect(loop[1].trim().split(/\s+/).sort()).toEqual([
      "release/mac-arm64/Daintree.app",
      "release/mac-universal/Daintree.app",
    ]);
    expect(code(step)).toContain('PACKAGED_BINARY="$app/Contents/MacOS/Daintree"');
    expect(index).toBeGreaterThan(packageIndex(MACOS));
    expect(index).toBeLessThan(uploadIndex());
  });

  it("smokes each Linux AppImage on its own runner after packaging, before upload", () => {
    const { index, step } = packagedSmoke(LINUX);
    expect(code(step)).toContain("release/*.AppImage");
    expect(code(step)).toContain("--appimage-extract");
    expect(code(step)).toContain('PACKAGED_BINARY="$work/squashfs-root/AppRun"');
    expect(code(step)).toMatch(/xvfb-run --auto-servernum node scripts\/run-packaged-smoke\.mjs/);
    expect(index).toBeGreaterThan(packageIndex(LINUX));
    expect(index).toBeLessThan(uploadIndex());
  });

  it("smokes the shipped x64 macOS zip natively on Intel", () => {
    expect(smokeX64, "smoke-x64 job is missing").toBeTruthy();
    expect(smokeX64["runs-on"]).toBe("macos-15-intel");
    expect(smokeX64.needs).toEqual(expect.arrayContaining(["build"]));
    const download = stepIndex(
      smokeX64,
      (s) => s.uses?.startsWith("actions/download-artifact"),
      "x64 artifact download"
    );
    expect(smokeX64.steps[download].with.name).toBe("nightly-macos-15");
    const smoke = stepIndex(smokeX64, (s) => runs(s, SMOKE), "x64 packaged smoke");
    expect(smoke).toBeGreaterThan(download);
    const step = smokeX64.steps[smoke];
    // A skipped step would let the job, and so publish, succeed unlaunched.
    expect(step.if).toBeUndefined();
    expect(code(step)).toContain("release/Daintree-*-x64-mac.zip");
    expect(code(step)).toContain("ditto -x -k");
    expect(code(step)).toContain(
      'PACKAGED_BINARY="release/mac-x64/Daintree.app/Contents/MacOS/Daintree"'
    );
  });

  it("publishes only after every gate passed", () => {
    expect(publish.needs).toEqual(expect.arrayContaining(["build", "smoke-x64"]));
    // A status function would let a job run past a failed or skipped gate.
    for (const [name, job] of Object.entries({ build, "smoke-x64": smokeX64, publish })) {
      expect(String(job.if ?? ""), name).not.toMatch(/\b(?:always|failure|cancelled)\s*\(/);
      expect(job["continue-on-error"] ?? false, name).toBe(false);
    }
    expect(gateSteps.length).toBeGreaterThanOrEqual(4);
    for (const step of gateSteps) {
      expect(step["continue-on-error"] ?? false, step.name).toBe(false);
      expect(code(step), step.name).not.toMatch(/\|\|\s*(?:true|:)\s*$/m);
      if (/\bfor\b/.test(code(step))) {
        // The loop's trailing `echo` would otherwise mask a failed launch.
        expect(code(step), step.name).toMatch(/^\s*set -euo pipefail$/m);
      }
    }
  });

  it("writes to R2 only from the publish job", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === "publish") continue;
      for (const step of job.steps) {
        expect(/\baws\b.*\bs3(?:api)?\b/.test(code(step)), `${name}: ${step.name}`).toBe(false);
      }
      expect(JSON.stringify(job), name).not.toMatch(/secrets\.(?:R2_|DAINTREE_R2_)/);
    }
  });

  it("stays publish-only: no test suites and no issue-writing permissions", () => {
    const grantsIssueWrite = (perms) => perms === "write-all" || perms?.issues === "write";
    expect(grantsIssueWrite(workflow.permissions)).toBe(false);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(grantsIssueWrite(job.permissions), name).toBe(false);
    }
    const suite =
      /\bnpm\b[^\n]*?\s(?:t|test|test:(?!smoke:packaged\b)[\w:-]+)(?=\s|$)|\bvitest\b|\bplaywright\b/m;
    for (const step of allSteps) {
      expect(suite.test(code(step)), step.name).toBe(false);
    }
  });
});
