import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PERF_PLAYWRIGHT_CONFIG,
  PERF_SPEC_DIR,
  REGISTRY,
  UNREGISTERED_PERF_SPECS,
} from "../registry";

/**
 * Is every performance benchmark in this repository reachable from
 * `npm run perf list`?
 *
 * It was not. Project switch, store fan-out, agent launch and worktree-agent-ready
 * all existed as working Playwright benchmarks for months while being absent
 * from the dispatcher — so the only way to find one was to already know it
 * existed. A benchmark nobody can find is a benchmark nobody compares, which
 * makes it a benchmark nobody maintains, which is how a spec ends up measuring
 * a path the product no longer takes.
 *
 * The rule is therefore mechanical: every spec under `e2e/perf/`, and any spec
 * elsewhere under `e2e/` whose name marks it as a performance or memory harness,
 * must be either a registry command or an explicit entry in
 * `UNREGISTERED_PERF_SPECS` with a reason. Adding a new one and forgetting the
 * registry fails here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const E2E_ROOT = path.join(REPO_ROOT, "e2e");

/**
 * Specs that measure rather than assert: anything in the perf directory, and
 * elsewhere the `-perf` suffix or a memory harness.
 */
function isBenchmarkSpec(relPath: string): boolean {
  if (relPath.startsWith(`${PERF_SPEC_DIR}/`)) return true;
  const name = path.basename(relPath);
  return /-perf\.spec\.ts$/.test(name) || /memory.*\.spec\.ts$/.test(name);
}

function collectSpecs(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSpecs(full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".spec.ts")) continue;
    const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
    if (isBenchmarkSpec(rel)) out.push(rel);
  }
}

function benchmarkSpecs(): string[] {
  const found: string[] = [];
  collectSpecs(E2E_ROOT, found);
  return found.sort();
}

const registeredSpecs = new Map<string, string>();
for (const [name, command] of Object.entries(REGISTRY)) {
  if (command.spec) registeredSpecs.set(command.spec, name);
}

describe("perf registry coverage", () => {
  it("finds the benchmark specs it is meant to be guarding", () => {
    // A discovery bug here would make every other assertion in this file pass
    // vacuously, which is the one failure mode a coverage test cannot afford.
    const specs = benchmarkSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(12);
    expect(specs).toContain(`${PERF_SPEC_DIR}/interactivity-perf.spec.ts`);
    expect(specs).toContain(`${PERF_SPEC_DIR}/project-switch-perf.spec.ts`);
    // Named by neither convention, so only the directory rule can find it.
    expect(specs).toContain(`${PERF_SPEC_DIR}/project-switch-stress.spec.ts`);
  });

  it("keeps every registered spec in the perf directory", () => {
    // The perf config only loads that directory, so a spec registered from
    // anywhere else would run as nothing — and would still be imported by
    // whichever correctness bucket owns its folder.
    const stray = [...registeredSpecs.keys()].filter(
      (spec) => !spec.startsWith(`${PERF_SPEC_DIR}/`)
    );
    expect(stray).toEqual([]);
  });

  it("keeps the perf directory out of the main Playwright config", () => {
    const main = readFileSync(path.join(REPO_ROOT, "playwright.config.ts"), "utf-8");
    expect(main).not.toMatch(/e2e\/perf/);
    const perf = readFileSync(path.join(REPO_ROOT, PERF_PLAYWRIGHT_CONFIG), "utf-8");
    expect(perf).toContain(`./${PERF_SPEC_DIR}`);
  });

  it("registers or explicitly excludes every benchmark spec", () => {
    const unaccounted = benchmarkSpecs().filter(
      (spec) => !registeredSpecs.has(spec) && !(spec in UNREGISTERED_PERF_SPECS)
    );
    expect(unaccounted).toEqual([]);
  });

  it("names no spec that does not exist", () => {
    const missing = [...registeredSpecs.keys(), ...Object.keys(UNREGISTERED_PERF_SPECS)].filter(
      (spec) => {
        try {
          return !statSync(path.join(REPO_ROOT, spec)).isFile();
        } catch {
          return true;
        }
      }
    );
    expect(missing).toEqual([]);
  });

  it("does not both register and exclude the same spec", () => {
    const both = [...registeredSpecs.keys()].filter((spec) => spec in UNREGISTERED_PERF_SPECS);
    expect(both).toEqual([]);
  });

  it("sets a gate the spec actually reads", () => {
    // A command whose gate does not match the spec's own opt-in check runs the
    // spec with every test skipped and exits 0 — a benchmark that reports
    // nothing and looks like it passed.
    const wrong: string[] = [];
    for (const [spec, command] of registeredSpecs) {
      const gate = REGISTRY[command]!.gate;
      if (!gate) {
        wrong.push(`${command} drives a spec but declares no gate`);
        continue;
      }
      const source = readFileSync(path.join(REPO_ROOT, spec), "utf-8");
      if (!source.includes(gate)) wrong.push(`${command}: ${spec} never reads ${gate}`);
    }
    expect(wrong).toEqual([]);
  });

  it("gives every exclusion a reason rather than an empty string", () => {
    const empty = Object.entries(UNREGISTERED_PERF_SPECS)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([spec]) => spec);
    expect(empty).toEqual([]);
  });

  it("classifies every command", () => {
    const kinds = new Set(["journey", "mechanism", "diagnostic"]);
    const bad = Object.entries(REGISTRY)
      .filter(([, command]) => !kinds.has(command.kind))
      .map(([name]) => name);
    expect(bad).toEqual([]);
  });

  it("declares a spec for every gated command and a gate for every spec", () => {
    // The two travel together — `playwrightBench` builds both from one object —
    // so a mismatch means someone hand-built a Command and half-filled it.
    const mismatched = Object.entries(REGISTRY)
      .filter(([, command]) => Boolean(command.spec) !== Boolean(command.gate))
      .map(([name]) => name);
    expect(mismatched).toEqual([]);
  });
});
