import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import yaml from "js-yaml";

// Regression guard for #11117: online E2E gated the macOS release but not Linux
// or Windows, so a failing real-agent run could still publish on two of three
// platforms. Release workflows only fire on a v* tag, so they can never be
// exercised on a PR — these structural assertions are the only enforcement of
// the gating contract in CI.
//
// The contract under test is behavioural, not cosmetic: every suite that must
// gate a release (core + online, plus whatever full-* buckets exist) has to sit
// in the dependency chain of every platform build, on every OS. Suites are
// resolved from each gate's `with:`/matrix rather than from job names, because
// a job called `e2e-online-gate` that passes `suite: core` would satisfy a
// name-shaped assertion while testing the wrong thing.

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows"
);

const RELEASE_WORKFLOWS = ["release-macos.yml", "release-linux.yml", "release-windows.yml"];

// The suites whose failure must block a publish, per docs/e2e-testing.md. Named
// from the release contract, not copied from the workflows — deleting a gate
// from every OS at once still has to fail this file.
const RELEASE_BLOCKING_SUITES = ["core", "online"];

const E2E_WORKFLOW = "./.github/workflows/e2e.yml";

const isGate = (jobId) => /^e2e-.+-gate$/.test(jobId);
const isBuild = (jobId) => /^build-daintree/.test(jobId);

const needsOf = (job) => {
  const needs = job?.needs ?? [];
  return Array.isArray(needs) ? needs : [needs];
};

// A gate either passes one literal suite or fans a matrix of them out. The
// matrix form sets `with.suite: ${{ matrix.suite }}`, so the literal list lives
// on the strategy.
const suitesOf = (job) => {
  const matrixSuites = job.strategy?.matrix?.suite;
  if (Array.isArray(matrixSuites)) return matrixSuites;
  const suite = job.with?.suite;
  return typeof suite === "string" && !suite.includes("${{") ? [suite] : [];
};

// Jobs that actually ship bits, found by the action they run rather than by
// name — a second publisher added under any other job id still gets traced.
const publishersOf = (jobs) =>
  Object.keys(jobs).filter((id) =>
    (jobs[id].steps ?? []).some((step) => step.uses?.includes("/publish-daintree"))
  );

// always()/failure()/cancelled() replace the implicit success() check that makes
// a `needs:` edge blocking. Anywhere on the gated path, they turn a gate into
// decoration. (An explicit success() is redundant but harmless.)
const OVERRIDES_SUCCESS = /\b(always|failure|cancelled)\s*\(/;

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

  it.each(workflows)(
    "$file: every publisher is downstream of every gate",
    ({ jobs, gates, publishers }) => {
      for (const publisher of publishers) {
        const upstream = upstreamOf(jobs, publisher);
        for (const gate of gates) {
          expect(upstream.has(gate), `${publisher} must be gated by ${gate}`).toBe(true);
        }
      }
    }
  );

  // A `needs:` edge only blocks while the dependent keeps its implicit success()
  // check. This is the premise the whole contract rests on: uniformly slapping
  // `if: always()` on the builds would leave the graph looking perfectly gated
  // while shipping a failed release.
  it.each(workflows)(
    "$file: nothing on the gated path overrides the success check",
    ({ jobs, builds, publishers }) => {
      for (const jobId of [...builds, ...publishers]) {
        const condition = jobs[jobId].if;
        if (condition === undefined) continue;
        expect(
          OVERRIDES_SUCCESS.test(String(condition)),
          `${jobId} would run past a failed gate: if: ${condition}`
        ).toBe(false);
      }
    }
  );

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
