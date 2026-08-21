import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PerfMode } from "./types";

// Single entry point for every performance benchmark. Each command spawns the
// underlying benchmark in its own process (clean argv, faithful exit code) so a
// benchmark runs identically to being invoked directly. Add a benchmark by
// adding one REGISTRY entry — package.json and this file never grow a per-
// benchmark script again.
//
//   npm run perf list                       # show every command
//   npm run perf ci                          # run the ci-mode harness matrix
//   npm run perf -- ci --update-baseline     # forward flags after `--`
//   npm run perf cold-start -- --runs 10

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(perfDir, "..", "..");

// Resolve a package's bin entry by direct file path. `require.resolve` is
// unreliable here because packages like `playwright` restrict `exports` and
// don't expose their CLI subpath. Candidates are tried in order (first match
// wins) so the direct dependency's bin is preferred over a hoisted transitive
// one. Resolved lazily (inside the runner) so an unrelated command like `list`
// never trips on a missing tool.
function resolveBin(candidates: string[], label: string): string {
  for (const relPath of candidates) {
    const abs = path.join(repoRoot, relPath);
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error(
    `[perf] could not locate ${label} (looked for: ${candidates.join(", ")}) — run \`npm install\` first`
  );
}

type Runner = (rest: string[]) => Promise<number>;

interface Command {
  summary: string;
  runner: Runner;
}

function spawnNode(args: string[], env?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      cwd: repoRoot,
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
  return tsxScript("run.ts", ["--mode", mode]);
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

interface PlaywrightBench {
  /** Playwright project the spec belongs to. */
  project: string;
  /** Spec path, repo-relative. */
  spec: string;
  /** Env var the spec's opt-in gate reads; always set to "1". */
  gate: string;
  /** npm build script to run first, when the spec needs a fresh bundle. */
  build?: "build:e2e" | "build:e2e:bench";
}

/**
 * Every Playwright-hosted benchmark is the same shape: optionally rebuild the
 * e2e bundle, then run one spec in one worker with its opt-in env gate set.
 */
function playwrightBench({ project, spec, gate, build }: PlaywrightBench): Runner {
  return async (rest) => {
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
        `--project=${project}`,
        "--workers=1",
        spec,
        ...rest,
      ],
      { [gate]: "1" }
    );
  };
}

const REGISTRY: Record<string, Command> = {
  smoke: { summary: "Fast local smoke matrix (run on demand)", runner: harness("smoke") },
  ci: { summary: "CI validation matrix (scheduled + manual dispatch)", runner: harness("ci") },
  nightly: { summary: "Full matrix + soak coverage", runner: harness("nightly") },
  soak: { summary: "Long-run stress matrix", runner: harness("soak") },
  "verify-baselines": {
    summary: "Assert all four committed baselines are fresh, complete, and non-degenerate",
    runner: tsxScript("verify-baselines.ts"),
  },
  "cold-start": {
    summary: "Manual cold-start sampler (needs a packaged binary under release/)",
    runner: tsxScript("cold-start.ts"),
  },
  "launch-ab": {
    summary: "Direct-spawn launch A/B benchmark (before/after across branches)",
    runner: tsxScript("launch-ab.ts"),
  },
  "recipe-fanout": {
    summary: "Cold recipe fanout through worktree, PTY host, and xterm",
    runner: playwrightBench({
      project: "full-worktree",
      spec: "e2e/full/worktree/recipe-fanout-perf.spec.ts",
      gate: "RUN_PERF_RECIPE_FANOUT",
      build: "build:e2e:bench",
    }),
  },
  "bulk-issue-worktrees": {
    summary: "Fake issue selection through bulk worktree recipes and real PTYs",
    runner: playwrightBench({
      project: "full-panels",
      spec: "e2e/full/panels/bulk-issue-worktree-recipe-perf.spec.ts",
      gate: "RUN_PERF_BULK_ISSUE_WORKTREES",
      build: "build:e2e:bench",
    }),
  },
  interactivity: {
    summary: "Keystroke-to-paint latency under fleet load (PERF-120..122, opt-in)",
    runner: playwrightBench({
      project: "full-terminal",
      spec: "e2e/full/terminal/interactivity-perf.spec.ts",
      gate: "RUN_PERF_INTERACTIVITY",
      build: "build:e2e",
    }),
  },
  scroll: {
    summary: "Wheel-to-paint latency for mouse-reporting TUIs (PERF-125..127, opt-in)",
    runner: playwrightBench({
      project: "full-terminal",
      spec: "e2e/full/terminal/scroll-perf.spec.ts",
      gate: "RUN_PERF_SCROLL",
      build: "build:e2e",
    }),
  },
  memory: {
    summary: "Memory kitchen-sink soak spec via Playwright",
    runner: playwrightBench({
      project: "full-resilience",
      spec: "e2e/full/resilience/memory-kitchen-sink.spec.ts",
      gate: "RUN_PERF_MEMORY",
    }),
  },
  "memory-growth": {
    summary: "Single-session retained-memory growth benchmark via Playwright",
    runner: playwrightBench({
      project: "full-resilience",
      spec: "e2e/full/resilience/memory-growth-perf.spec.ts",
      gate: "RUN_PERF_MEMORY_GROWTH",
      build: "build:e2e",
    }),
  },
  "memory-growth-compare": {
    summary: "Compare two long-session memory-growth results",
    runner: tsxScript("memory-growth-compare.ts"),
  },
  "memory-compare": {
    summary: "Diff two memory-bench result files into a delta table",
    runner: tsxScript("memory-bench-compare.ts"),
  },
  "memory-pressure": {
    summary: "Renderer responsiveness during sustained synthetic memory pressure",
    runner: playwrightBench({
      project: "full-resilience",
      spec: "e2e/full/resilience/memory-pressure-responsiveness-perf.spec.ts",
      gate: "RUN_PERF_MEMORY_PRESSURE",
      build: "build:e2e:bench",
    }),
  },
  analyze: {
    summary: "Bundle-size visualizer build (ANALYZE=true vite build)",
    runner: viteAnalyze(),
  },
};

function printUsage(): void {
  const width = Math.max(...Object.keys(REGISTRY).map((name) => name.length));
  console.log("Performance benchmarks — usage: npm run perf <command> [-- <args>]\n");
  for (const [name, command] of Object.entries(REGISTRY)) {
    console.log(`  ${name.padEnd(width)}  ${command.summary}`);
  }
  console.log(
    "\nCommon flags are forwarded to the benchmark, e.g. " +
      "`npm run perf -- smoke --update-baseline`, `npm run perf cold-start -- --json`."
  );
  console.log("Details: scripts/perf/README.md");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (
    command === undefined ||
    command === "list" ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printUsage();
    process.exit(0);
  }

  const entry = REGISTRY[command];
  if (!entry) {
    console.error(`[perf] unknown command: ${command}\n`);
    printUsage();
    process.exit(1);
  }

  process.exit(await entry.runner(rest));
}

main().catch((error) => {
  console.error("[perf] fatal:", error);
  process.exit(1);
});
