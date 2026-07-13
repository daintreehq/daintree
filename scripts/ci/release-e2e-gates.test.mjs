import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import yaml from "js-yaml";

// Regression guard for #11117: online E2E gated the macOS release but not Linux
// or Windows, so a failing real-agent run could still publish on two of three
// platforms. Release workflows only fire on a v* tag or a manual dispatch, so
// they can never be exercised on a PR — these structural assertions are the
// only enforcement of the gating contract in CI.
//
// The contract under test is behavioural, not cosmetic. Two things have to hold
// for a gate to actually gate, and each has a failure mode that looks fine in
// the YAML:
//   1. The suite really runs. Suites are resolved from each gate's `with:`/
//      matrix, not from job names — a job called `e2e-online-gate` passing
//      `suite: core` would satisfy any name-shaped assertion while testing the
//      wrong thing.
//   2. Failure really propagates. A `needs:` edge only blocks while every job
//      along it keeps its implicit success() check, which ANY status-check
//      function silently replaces.

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows"
);

const RELEASE_WORKFLOWS = ["release-macos.yml", "release-linux.yml", "release-windows.yml"];

// The suites whose failure must block a publish, per docs/e2e-testing.md. This
// is the release policy, deliberately spelled out here rather than read back
// out of the workflows — otherwise deleting a gate from all three OSes at once
// would keep this file green. Adding a suite to the release gate is a decision,
// so it should cost an edit here.
const RELEASE_BLOCKING_SUITES = [
  "core",
  "online",
  "full-terminal",
  "full-worktree",
  "full-presets",
  "full-platform",
  "full-panels",
  "full-resilience",
  "full-plugins",
];

const E2E_WORKFLOW = "./.github/workflows/e2e.yml";

const isGate = (jobId) => /^e2e-.+-gate$/.test(jobId);
const isBuild = (jobId) => /^build-daintree/.test(jobId);

const needsOf = (job) => {
  const needs = job?.needs ?? [];
  return Array.isArray(needs) ? needs : [needs];
};

// A gate either passes one literal suite or fans a matrix of them out. Only
// credit the matrix when the job actually forwards it: a strategy listing
// `online` while `with.suite` hardcodes `core` runs core, whatever the matrix
// says.
const suitesOf = (job) => {
  const suite = job.with?.suite;
  if (typeof suite !== "string") return [];
  const matrixSuites = job.strategy?.matrix?.suite;
  if (Array.isArray(matrixSuites) && /\bmatrix\.suite\b/.test(suite)) return matrixSuites;
  return suite.includes("${{") ? [] : [suite];
};

// Jobs that actually ship bits, found by the action they run rather than by
// name — a second publisher added under any other job id still gets traced.
const publishersOf = (jobs) =>
  Object.keys(jobs).filter((id) =>
    (jobs[id].steps ?? []).some((step) => step.uses?.includes("/publish-daintree"))
  );

// A job with no `if:` is implicitly `if: success()`, which is what makes a
// `needs:` edge blocking. ANY status-check function replaces that implicit
// check — including success() itself, which is why this matches all four rather
// than just the obviously-dangerous three: `if: success() || github.ref_type ==
// 'tag'` runs on a tag no matter what the gate did.
const OVERRIDES_SUCCESS = /\b(success|always|failure|cancelled)\s*\(/;

const overridesSuccess = (job) => job.if !== undefined && OVERRIDES_SUCCESS.test(String(job.if));

// Jobs reachable from `jobId` by `needs:` edges that actually propagate failure
// — the walk stops at any job that overrides its success check, because a gate
// failing upstream of one of those never reaches the other side. Reachability
// alone would happily "prove" a release is gated through a chain of always().
const blockingUpstreamOf = (jobs, jobId) => {
  const seen = new Set();
  if (overridesSuccess(jobs[jobId])) return seen;
  const queue = [...needsOf(jobs[jobId])];
  while (queue.length > 0) {
    const next = queue.pop();
    if (seen.has(next) || !jobs[next]) continue;
    seen.add(next);
    if (overridesSuccess(jobs[next])) continue;
    queue.push(...needsOf(jobs[next]));
  }
  return seen;
};

const workflows = RELEASE_WORKFLOWS.map((file) => {
  const jobs = yaml.load(readFileSync(path.join(workflowsDir, file), "utf8")).jobs;
  const jobIds = Object.keys(jobs);
  const gates = jobIds.filter(isGate);
  return {
    file,
    platform: file.replace(/^release-|\.yml$/g, ""),
    jobs,
    gates,
    builds: jobIds.filter(isBuild),
    publishers: publishersOf(jobs),
    gatedSuites: gates.flatMap((gate) => suitesOf(jobs[gate])),
  };
});

describe("release workflow e2e gating contract (#11117)", () => {
  it.each(workflows)(
    "$file wires gates, builds and a publisher",
    ({ gates, builds, publishers }) => {
      expect(gates.length).toBeGreaterThan(0);
      expect(builds.length).toBeGreaterThan(0);
      expect(publishers.length).toBeGreaterThan(0);
    }
  );

  it.each(workflows)("$file: every build directly needs every gate", ({ jobs, gates, builds }) => {
    for (const build of builds) {
      expect(needsOf(jobs[build]), `${build} must gate on all of: ${gates.join(", ")}`).toEqual(
        expect.arrayContaining(gates)
      );
    }
  });

  // #11117 itself: resolve the suites a build is actually gated on by following
  // its own `needs:`, so both ways of losing the contract — unwiring the gate
  // from the build, or deleting the gate job outright, on any number of OSes —
  // land here.
  it.each(workflows)("$file: the release-blocking suites gate every build", ({ jobs, builds }) => {
    for (const build of builds) {
      const suites = needsOf(jobs[build])
        .filter(isGate)
        .flatMap((gate) => suitesOf(jobs[gate]));
      expect(suites, `${build} must be gated on: ${RELEASE_BLOCKING_SUITES.join(", ")}`).toEqual(
        expect.arrayContaining(RELEASE_BLOCKING_SUITES)
      );
    }
  });

  // The property that actually matters: a failing gate must be able to stop the
  // publish. Walks only edges that propagate failure, so a chain of always()
  // between the gate and the publisher reads as ungated — which is what a naive
  // reachability check would miss, and how `assemble-windows-release` could
  // quietly become a bypass.
  it.each(workflows)(
    "$file: a failing gate blocks every publisher",
    ({ jobs, gates, publishers }) => {
      for (const publisher of publishers) {
        const blocking = blockingUpstreamOf(jobs, publisher);
        for (const gate of gates) {
          expect(
            blocking.has(gate),
            `${gate} failing must stop ${publisher}, but no chain of success-gated needs connects them`
          ).toBe(true);
        }
      }
    }
  );

  it.each(workflows)("$file: no build overrides its success check", ({ jobs, builds }) => {
    for (const build of builds) {
      expect(
        overridesSuccess(jobs[build]),
        `${build} would run past a failed gate: if: ${jobs[build].if}`
      ).toBe(false);
    }
  });

  it.each(workflows)(
    "$file: gates call the shared e2e workflow for this platform",
    ({ jobs, gates, platform }) => {
      for (const gate of gates) {
        expect(jobs[gate].uses, `${gate} must call the shared e2e workflow`).toBe(E2E_WORKFLOW);
        expect(jobs[gate].with.platform, `${gate} must target ${platform}`).toBe(platform);
      }
    }
  );

  // Online drives real agent CLIs against real APIs; without the secrets it
  // cannot run at all, and a gate that cannot run is not a gate.
  it.each(workflows)("$file: the online gate inherits secrets", ({ jobs, gates }) => {
    const online = gates.filter((gate) => suitesOf(jobs[gate]).includes("online"));
    expect(online.length).toBe(1);
    expect(jobs[online[0]].secrets).toBe("inherit");
  });

  // continue-on-error is unsupported on reusable-workflow (`uses:`) jobs at any
  // value — it makes the whole workflow fail to start. Added and reverted once
  // already; it would also defeat the gate.
  it.each(workflows)("$file: no gate opts out of failing the release", ({ jobs, gates }) => {
    for (const gate of gates) {
      expect(jobs[gate], `${gate} must be able to fail the release`).not.toHaveProperty(
        "continue-on-error"
      );
    }
  });

  it("all three platforms gate on the same suites", () => {
    const [first, ...rest] = workflows.map((w) => [...w.gatedSuites].sort());
    for (const gatedSuites of rest) {
      expect(gatedSuites).toEqual(first);
    }
  });
});
