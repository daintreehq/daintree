import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import yaml from "js-yaml";

// Regression guard for #11117: the three per-OS release workflows are supposed
// to share one gating contract — every e2e gate a workflow defines must be in
// the dependency chain of every platform build it packages. macOS had the
// online gate wired while Linux and Windows silently did not, so a failing
// real-agent run could still publish on two of three platforms.
//
// These assertions are derived from the parsed graph, not copied from it: gate
// and build jobs are discovered by shape, so a fourth gate added to one OS and
// forgotten on another fails here without anyone editing this file.

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows"
);

const RELEASE_WORKFLOWS = ["release-macos.yml", "release-linux.yml", "release-windows.yml"];

const load = (file) => yaml.load(readFileSync(path.join(workflowsDir, file), "utf8"));

const isGate = (jobId) => /^e2e-.+-gate$/.test(jobId);
const isBuild = (jobId) => /^build-daintree/.test(jobId);

const needsOf = (job) => {
  const needs = job?.needs ?? [];
  return Array.isArray(needs) ? needs : [needs];
};

// Every job reachable from `jobId` by walking `needs` edges backwards.
const upstreamOf = (jobs, jobId) => {
  const seen = new Set();
  const queue = [...needsOf(jobs[jobId])];
  while (queue.length > 0) {
    const next = queue.pop();
    if (seen.has(next) || !jobs[next]) continue;
    seen.add(next);
    queue.push(...needsOf(jobs[next]));
  }
  return seen;
};

const workflows = RELEASE_WORKFLOWS.map((file) => {
  const jobs = load(file).jobs;
  const jobIds = Object.keys(jobs);
  return {
    file,
    jobs,
    gates: jobIds.filter(isGate),
    builds: jobIds.filter(isBuild),
  };
});

describe("release workflow e2e gating contract (#11117)", () => {
  it.each(workflows)("$file defines e2e gates and platform builds", ({ gates, builds }) => {
    expect(gates.length).toBeGreaterThan(0);
    expect(builds.length).toBeGreaterThan(0);
  });

  it.each(workflows)(
    "$file: every build job depends on every e2e gate",
    ({ jobs, gates, builds }) => {
      for (const build of builds) {
        expect(needsOf(jobs[build]), `${build} must gate on all of: ${gates.join(", ")}`).toEqual(
          expect.arrayContaining(gates)
        );
      }
    }
  );

  it.each(workflows)("$file: publish transitively depends on every e2e gate", ({ jobs, gates }) => {
    expect(jobs["publish-daintree"], "expected a publish-daintree job").toBeTruthy();
    const upstream = upstreamOf(jobs, "publish-daintree");
    for (const gate of gates) {
      expect(upstream.has(gate), `publish-daintree must be gated by ${gate}`).toBe(true);
    }
  });

  // A gate scheduled under a different condition than the job it gates can skip
  // while that job still runs — the dependency edge would silently evaporate.
  // Windows guards its gates and builds with a smoke-artifact-reuse condition;
  // whatever the guard is, gates and builds must share it exactly.
  it.each(workflows)(
    "$file: gates and builds are scheduled under one condition",
    ({ jobs, gates, builds }) => {
      const guards = new Set([...gates, ...builds].map((id) => jobs[id].if ?? null));
      expect(
        guards.size,
        `divergent if: guards across gates/builds: ${[...guards].join(" | ")}`
      ).toBe(1);
    }
  );

  // continue-on-error is invalid on reusable-workflow (`uses:`) jobs — it makes
  // the whole workflow fail to start. It was added and reverted once already;
  // it would also defeat the gate.
  it.each(workflows)("$file: no gate opts out of failing the release", ({ jobs, gates }) => {
    for (const gate of gates) {
      expect(
        jobs[gate]["continue-on-error"],
        `${gate} must be able to fail the release`
      ).toBeFalsy();
    }
  });

  it("all three platforms define the same set of gates", () => {
    const [first, ...rest] = workflows.map((w) => [...w.gates].sort());
    for (const gates of rest) {
      expect(gates).toEqual(first);
    }
  });
});
