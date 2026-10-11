import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkKind, PerfMode } from "./types";

/**
 * Every benchmark this repository can run, in one table.
 *
 * Split out of `index.ts` so it can be imported without running anything —
 * `index.ts` calls `main()` at module scope, so a test that imported it would
 * dispatch a command. The coverage test in `__tests__/perfRegistry.test.ts`
 * reads this module and nothing else, which is what makes "every performance
 * spec is discoverable from `npm run perf list`" an enforced property rather
 * than a habit.
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(perfDir, "..", "..");

// Resolve a package's bin entry by direct file path. `require.resolve` is
// unreliable here because packages like `playwright` restrict `exports` and
// don't expose their CLI subpath. Candidates are tried in order (first match
// wins) so the direct dependency's bin is preferred over a hoisted transitive
// one. Resolved lazily (inside the runner) so an unrelated command like `list`
// never trips on a missing tool.
function resolveBin(candidates: string[], label: string): string {
  for (const relPath of candidates) {
    const abs = path.join(REPO_ROOT, relPath);
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error(
    `[perf] could not locate ${label} (looked for: ${candidates.join(", ")}) — run \`npm install\` first`
  );
}

export type Runner = (rest: string[]) => Promise<number>;

export interface Command {
  summary: string;
  /**
   * What layer this command's numbers describe — the same vocabulary the
   * scenario matrix uses (`config/benchmarkClasses.ts`).
   *
   * `journey` drives the packaged-equivalent app from a real user entry point
   * to a visible result; `mechanism` measures shipped code with one or more
   * user-path layers removed; `diagnostic` is a floor, an approximation, or a
   * tool rather than a product claim. Printed by `perf list` so no reader has
   * to infer fidelity from a spec's comments.
   */
  kind: BenchmarkKind;
  /** Playwright spec this command drives, repo-relative, when it drives one. */
  spec?: string;
  /** Env gate the spec reads to opt in. Set to "1" by the runner. */
  gate?: string;
  runner: Runner;
}

function spawnNode(args: string[], env?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        // Surface signal termination with the conventional 128+signum code
        // (SIGINT → 130, SIGTERM → 143) instead of flattening every kill to a
        // generic failure, so a Ctrl-C'd or timed-out run is distinguishable.
        const signum = os.constants.signals[signal];
        resolve(typeof signum === "number" ? 128 + signum : 1);
        return;
      }
      resolve(code ?? 0);
    });
    child.on("error", (error) => {
      console.error("[perf] failed to launch benchmark:", error);
      resolve(1);
    });
  });
}

// TS/ESM benchmark under the tsx loader — mirrors `tsx <file>` but pins node so
// it works cross-platform without resolving the tsx bin shim.
function tsxScript(file: string, fixedArgs: string[] = [], env?: Record<string, string>): Runner {
  const scriptPath = path.join(perfDir, file);
  return (rest) => spawnNode(["--import", "tsx", scriptPath, ...fixedArgs, ...rest], env);
}

function harness(mode: PerfMode): Runner {
  const scriptPath = path.join(perfDir, "run.ts");
  return (rest) =>
    spawnNode(["--expose-gc", "--import", "tsx", scriptPath, "--mode", mode, ...rest]);
}

function viteAnalyze(): Runner {
  return (rest) =>
    spawnNode([resolveBin(["node_modules/vite/bin/vite.js"], "vite"), "build", ...rest], {
      ANALYZE: "true",
    });
}

function npmScript(name: string): Promise<number> {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    console.error(`[perf] cannot run npm script '${name}': npm_execpath is unavailable`);
    return Promise.resolve(1);
  }
  return spawnNode([npmCli, "run", name]);
}

/**
 * Every Playwright-hosted benchmark lives under `e2e/perf/` and runs through
 * its own config, which a bare `npx playwright test` never loads — so none of
 * them rides along with a correctness bucket.
 */
export const PERF_PLAYWRIGHT_CONFIG = "playwright.perf.config.ts";
export const PERF_PLAYWRIGHT_PROJECT = "perf";
export const PERF_SPEC_DIR = "e2e/perf";

interface PlaywrightBench {
  summary: string;
  kind: BenchmarkKind;
  /** Spec path, repo-relative, under PERF_SPEC_DIR. */
  spec: string;
  /** Env var the spec's opt-in gate reads; always set to "1". */
  gate: string;
  /** npm build script to run first, when the spec needs a fresh bundle. */
  build?: "build:e2e" | "build:e2e:bench";
}

/**
 * Every Playwright-hosted benchmark is the same shape: optionally rebuild the
 * e2e bundle, then run one spec in one worker with its opt-in env gate set.
 *
 * The returned Command carries `spec` and `gate` taken from the same object the
 * runner uses, so the metadata `perf list` prints and the coverage test reads
 * cannot drift from what actually runs.
 */
function playwrightBench({ summary, kind, spec, gate, build }: PlaywrightBench): Command {
  return {
    summary,
    kind,
    spec,
    gate,
    runner: async (rest) => {
      if (build) {
        const buildExitCode = await npmScript(build);
        if (buildExitCode !== 0) return buildExitCode;
      }
      return spawnNode(
        [
          resolveBin(
            ["node_modules/@playwright/test/cli.js", "node_modules/playwright/cli.js"],
            "playwright"
          ),
          "test",
          `--config=${PERF_PLAYWRIGHT_CONFIG}`,
          `--project=${PERF_PLAYWRIGHT_PROJECT}`,
          "--workers=1",
          spec,
          ...rest,
        ],
        { [gate]: "1" }
      );
    },
  };
}

export const REGISTRY: Record<string, Command> = {
  "foreground-terminal": {
    summary: "Visible single/two-agent terminal CPU and GPU time (macOS, explicit scenario)",
    kind: "mechanism",
    runner: tsxScript("foreground-terminal.ts"),
  },
  // Modes set iteration counts and which scenarios are eligible; each needs
  // `--scenario <ONE-ID>`. Nothing schedules these — there is no perf CI.
  smoke: {
    summary: "One scenario, fast sampling (--scenario required)",
    kind: "mechanism",
    runner: harness("smoke"),
  },
  ci: {
    summary: "One scenario, more iterations (--scenario required)",
    kind: "mechanism",
    runner: harness("ci"),
  },
  nightly: {
    summary: "One scenario, heaviest sampling (--scenario required)",
    kind: "mechanism",
    runner: harness("nightly"),
  },
  soak: {
    summary: "One scenario, long-run stress (--scenario required)",
    kind: "mechanism",
    runner: harness("soak"),
  },
  compare: {
    summary: "Diff two run summaries into a comparability-aware delta table",
    kind: "diagnostic",
    runner: tsxScript("compare.ts"),
  },
  journeys: {
    summary: "Print the user-journey manifest and the benchmarks that cover each one",
    kind: "diagnostic",
    runner: tsxScript("journeys/report.ts"),
  },
  affected: {
    summary: "Map changed files to the journeys and scenarios that own them (--base <ref>)",
    kind: "diagnostic",
    runner: tsxScript("journeys/affected.ts"),
  },
  calibrate: {
    summary: "Run one scenario repeatedly on an unchanged tree and report the noise floor",
    kind: "diagnostic",
    runner: tsxScript("calibrate.ts"),
  },
  diagnose: {
    summary: "Re-run one scenario under the CPU and heap profilers into an artifact bundle",
    kind: "diagnostic",
    runner: tsxScript("diagnose.ts"),
  },
  "verify-baselines": {
    summary:
      "Assert the committed baseline files are usable — shape, provenance, no degenerate references",
    kind: "diagnostic",
    runner: tsxScript("verify-baselines.ts"),
  },
  "cold-start": {
    summary: "Manual cold-start sampler (needs a packaged binary under release/)",
    kind: "journey",
    runner: tsxScript("cold-start.ts"),
  },
  "launch-ab": {
    summary: "Direct-spawn launch A/B benchmark (before/after across branches)",
    kind: "journey",
    runner: tsxScript("launch-ab.ts"),
  },
  "recipe-fanout": playwrightBench({
    summary: "Cold recipe fanout through worktree, PTY host, and xterm",
    kind: "journey",
    spec: "e2e/perf/recipe-fanout-perf.spec.ts",
    gate: "RUN_PERF_RECIPE_FANOUT",
    build: "build:e2e:bench",
  }),
  "bulk-issue-worktrees": playwrightBench({
    summary: "Fake issue selection through bulk worktree recipes and real PTYs",
    kind: "journey",
    spec: "e2e/perf/bulk-issue-worktree-recipe-perf.spec.ts",
    gate: "RUN_PERF_BULK_ISSUE_WORKTREES",
    build: "build:e2e:bench",
  }),
  interactivity: playwrightBench({
    summary: "Keystroke-to-paint latency under fleet load (PERF-120..122, opt-in)",
    kind: "journey",
    spec: "e2e/perf/interactivity-perf.spec.ts",
    gate: "RUN_PERF_INTERACTIVITY",
    build: "build:e2e",
  }),
  scroll: playwrightBench({
    summary: "Wheel-to-paint latency for mouse-reporting TUIs (PERF-125..127, opt-in)",
    kind: "journey",
    spec: "e2e/perf/scroll-perf.spec.ts",
    gate: "RUN_PERF_SCROLL",
    build: "build:e2e",
  }),
  interactions: playwrightBench({
    summary: "Input-to-painted-result latency for ~60 everyday UI interactions (opt-in)",
    kind: "journey",
    spec: "e2e/perf/interaction-latency-perf.spec.ts",
    gate: "RUN_PERF_INTERACTIONS",
    build: "build:e2e",
  }),
  "panel-close-add": playwrightBench({
    summary:
      "Grid add/close transitions with agent TUIs: first frame, settle time, layout jumps, resize storms",
    kind: "journey",
    spec: "e2e/perf/panel-close-add-perf.spec.ts",
    gate: "RUN_PERF_PANEL_CLOSE_ADD",
    build: "build:e2e",
  }),
  "project-switch": playwrightBench({
    summary: "Switch round-trip and on-screen reveal latency, cold (LRU-evicted) and warm",
    kind: "journey",
    spec: "e2e/perf/project-switch-perf.spec.ts",
    gate: "RUN_PERF_SWITCH",
    build: "build:e2e",
  }),
  "project-switch-rotation": playwrightBench({
    summary:
      "Real-UI switch rotation: intent → focused pane paints a typed nonce, per LRU depth and cache cap, plus memory",
    kind: "journey",
    spec: "e2e/perf/project-switch-rotation-perf.spec.ts",
    gate: "RUN_PERF_SWITCH_ROTATION",
    build: "build:e2e",
  }),
  "project-switch-stress": playwrightBench({
    summary:
      "Cold/warm project-switch churn across many projects: switch latency, FD and memory growth per round",
    kind: "journey",
    spec: "e2e/perf/project-switch-stress.spec.ts",
    gate: "RUN_PERF_STRESS",
    build: "build:e2e",
  }),
  "project-switch-rotation-compare": {
    summary: "Compare two switch-rotation results, or price one cached view with --marginal",
    kind: "diagnostic",
    runner: tsxScript("project-switch-rotation-compare.ts"),
  },
  "agent-launch": playwrightBench({
    summary: "agent.launch dispatch to panel, xterm and first agent output",
    kind: "journey",
    spec: "e2e/perf/agent-launch-perf.spec.ts",
    gate: "RUN_PERF_AGENT_LAUNCH",
    build: "build:e2e",
  }),
  "worktree-agent-ready": playwrightBench({
    summary: "Create a worktree, switch to it, launch an agent, tear it down — single and burst",
    kind: "journey",
    spec: "e2e/perf/worktree-agent-ready-perf.spec.ts",
    gate: "RUN_PERF_WORKTREE_AGENT_READY",
    build: "build:e2e",
  }),
  "store-fanout": playwrightBench({
    summary:
      "React re-renders and render-ms per git tick, agent flip and activity flush, as worktrees scale",
    kind: "mechanism",
    spec: "e2e/perf/store-fanout-perf.spec.ts",
    gate: "RUN_PERF_STORE_FANOUT",
    // The probe this spec reads (window.__DAINTREE_RENDER_PROBE__) only exists
    // in a DAINTREE_RENDER_PROBE=1 build, so an ordinary e2e bundle measures
    // nothing and reports zeros.
    build: "build:e2e:bench",
  }),
  "background-energy": playwrightBench({
    summary:
      "Renderer, xterm and process CPU while hidden worktree agents stream, plus retained output on reveal",
    kind: "mechanism",
    spec: "e2e/perf/background-energy-perf.spec.ts",
    gate: "RUN_BACKGROUND_ENERGY",
    // React commit counters come from the render probe, which only a bench
    // build carries; a production-mode run must not measure the probe itself.
    build: process.env.BACKGROUND_ENERGY_PRODUCTION === "1" ? "build:e2e" : "build:e2e:bench",
  }),
  "list-mount": playwrightBench({
    summary:
      "DOM-node delta and long-animation-frame count for ReviewHub mounting a 1000-file list",
    kind: "journey",
    spec: "e2e/perf/list-mount-budget-perf.spec.ts",
    gate: "RUN_PERF_LIST_MOUNT",
    build: "build:e2e",
  }),
  "agent-state-latency": playwrightBench({
    summary: "Working↔waiting transition latency for a hidden agent pane against the quiet window",
    kind: "journey",
    spec: "e2e/perf/agent-state-latency-perf.spec.ts",
    gate: "RUN_PERF_AGENT_STATE_LATENCY",
    build: "build:e2e",
  }),
  memory: playwrightBench({
    summary: "Memory kitchen-sink soak spec via Playwright",
    kind: "journey",
    spec: "e2e/perf/memory-kitchen-sink.spec.ts",
    gate: "RUN_PERF_MEMORY",
    build: "build:e2e",
  }),
  "memory-growth": playwrightBench({
    summary: "Single-session retained-memory growth benchmark via Playwright",
    kind: "journey",
    spec: "e2e/perf/memory-growth-perf.spec.ts",
    gate: "RUN_PERF_MEMORY_GROWTH",
    build: "build:e2e",
  }),
  "memory-growth-compare": {
    summary: "Compare two long-session memory-growth results",
    kind: "diagnostic",
    runner: tsxScript("memory-growth-compare.ts"),
  },
  "memory-compare": {
    summary: "Diff two memory-bench result files into a delta table",
    kind: "diagnostic",
    runner: tsxScript("memory-bench-compare.ts"),
  },
  "memory-pressure": playwrightBench({
    summary: "Renderer responsiveness during sustained synthetic memory pressure",
    kind: "journey",
    spec: "e2e/perf/memory-pressure-responsiveness-perf.spec.ts",
    gate: "RUN_PERF_MEMORY_PRESSURE",
    build: "build:e2e:bench",
  }),
  analyze: {
    summary: "Bundle-size visualizer build (ANALYZE=true vite build)",
    kind: "diagnostic",
    runner: viteAnalyze(),
  },
};

/**
 * Performance specs that deliberately have no `npm run perf` command, and why.
 *
 * The coverage test treats every spec under `e2e/perf/`, and any spec elsewhere
 * under `e2e/` whose name ends `-perf.spec.ts` or mentions memory, as a
 * benchmark that must be reachable from the dispatcher.
 * A spec listed here is an explicit decision; one that is neither registered nor
 * listed fails the test, which is the point — the five specs that prompted this
 * (project switch, store fan-out, agent launch, worktree-agent-ready) existed
 * for months without appearing in `npm run perf list`, and a benchmark nobody
 * can find is a benchmark nobody compares.
 */
export const UNREGISTERED_PERF_SPECS: Readonly<Record<string, string>> = {
  "e2e/full/resilience/core-perf-list-mount-budget.spec.ts":
    "not a benchmark despite the name: the functional ReviewHub virtualization journey that runs with full-resilience; its DOM-delta and long-animation-frame budgets are `npm run perf list-mount`",
  "e2e/nightly/nightly-memory-leaks.spec.ts":
    "belongs to the `nightly` Playwright project, run as a lane by `npm run test:e2e:nightly` rather than one benchmark at a time",
  "e2e/nightly/nightly-multiproject-memory-leak.spec.ts":
    "belongs to the `nightly` Playwright project, run as a lane by `npm run test:e2e:nightly`",
  "e2e/nightly/nightly-worker-governance-memory.spec.ts":
    "belongs to the `nightly` Playwright project, run as a lane by `npm run test:e2e:nightly`",
};

export function printUsage(): void {
  const width = Math.max(...Object.keys(REGISTRY).map((name) => name.length));
  console.log("Performance benchmarks — usage: npm run perf <command> [-- <args>]\n");
  console.log(
    "  Class: journey = real user entry point through to a visible result; " +
      "mechanism = shipped code with user-path layers removed; diagnostic = floor, " +
      "approximation or tool. A class is what a number may be claimed to mean.\n"
  );
  for (const [name, command] of Object.entries(REGISTRY)) {
    console.log(`  ${name.padEnd(width)}  [${command.kind}] ${command.summary}`);
  }
  console.log(
    "\nCommon flags are forwarded to the benchmark, e.g. " +
      "`npm run perf smoke -- --scenario PERF-105`, `npm run perf cold-start -- --json`."
  );
  console.log("Details: scripts/perf/README.md");
}
