/**
 * Idle harness runner (#12521) — boots the built app with GPU compositing on,
 * holds a fixture of projects and terminals idle for minutes, and reports what
 * the whole process tree cost: CPU including short-lived children, idle and
 * interrupt wakeups per process, subprocess launches by command, workspace-host
 * restarts, resource-profile transitions, and `sysmond`/`fseventsd` CPU over
 * the same window. The measurement lives in `electron/services/idleHarness.ts`;
 * this file launches, supervises, repeats and aggregates.
 *
 * On demand only, like the budget scripts: not in PR CI, not in `check`, not
 * in any E2E project. It reports numbers and fails only when a cell did not
 * materialise as requested — there are no thresholds until repeated
 * real-hardware baselines exist to set them from.
 *
 * macOS only: the process sampler (`idle-harness-sampler.c`) reads Mach
 * rusage counters, and is compiled here with `xcrun clang`, the same toolchain
 * the node-pty rebuild already needs.
 *
 * Usage (after `npm run build`):
 *   npm run test:idle-harness -- --projects=3 --terminals=19 --stream
 *   npm run test:idle-harness -- --all --runs=3 --json=idle-before.json
 *
 *   --projects=N         open projects, 1-5 (default 1)
 *   --terminals=N        terminals across them, 0-60 (default 0)
 *   --stream             one terminal in the active project streams output
 *   --blurred            measure with the window blurred instead of focused
 *   --all                the issue's matrix: 1/3/5 projects x 0/19 terminals x
 *                        quiet/streaming x focused/blurred (18 valid cells)
 *   --runs=N             repetitions per cell (default 1)
 *   --window-seconds=N   measured window (default 300, spans every periodic cost)
 *   --settle-seconds=N   quiet time after setup before the window (default 30)
 *   --json=PATH          write every run and the per-cell summary to PATH
 *
 * Cells with two or more projects and some terminals keep one cached project's
 * view protected from the efficiency freeze by a live agent state — the
 * population that costs the most and the one the freeze never applies to.
 * Leave the machine alone while it runs: a focus change inside the window
 * invalidates the run.
 */

import { spawnSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  assertBuildArtifacts,
  boundedTail,
  exitAfterFlush,
  launchHarnessRun,
  parsePositiveInt,
} from "./run-freeze-harness.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const SAMPLER_SOURCE = path.join(SCRIPT_DIR, "idle-harness-sampler.c");

const TAG = "IDLE-RUNNER";
const LOG_PREFIX = "[IDLE-HARNESS]";
const RESULT_PREFIX = `${LOG_PREFIX} RESULT `;
const COMPLETE_MARKER = `${LOG_PREFIX} COMPLETE`;
const FAILURE_MARKER = `${LOG_PREFIX} FAILED`;

/**
 * GPU stays on: compositor, WebGL and animation cost is what the freeze
 * harness's `--disable-gpu` hides. First-run dialogs are skipped so an
 * onboarding surface is not part of the idle reading.
 */
export const IDLE_HARNESS_ARGS = [
  "--daintree-idle-harness",
  "--daintree-e2e-skip-first-run-dialogs",
];

/** Read by the app; must match `IDLE_HARNESS_CONFIG_ENV` and `SPAWN_CENSUS_DIR_ENV`. */
export const CONFIG_ENV = "DAINTREE_IDLE_HARNESS_CONFIG";
export const CENSUS_DIR_ENV = "DAINTREE_IDLE_SPAWN_CENSUS_DIR";

export const MATRIX = {
  projects: [1, 3, 5],
  terminals: [0, 19],
  stream: [false, true],
  blurred: [false, true],
};

const DEFAULTS = { projects: 1, terminals: 0, runs: 1, windowSeconds: 300, settleSeconds: 30 };
const MAX_PROJECTS = 5;
const MAX_TERMINALS = 60;
/** Boot, fixture setup, census drain and teardown on top of settle + window. */
const OVERHEAD_TIMEOUT_MS = 240_000;
const MAX_DUMP_CHARS = 64_000;

/** Parse argv into options, or return the problems. Unknown flags are errors. */
export function parseArgs(argv) {
  const options = { ...DEFAULTS, stream: false, blurred: false, all: false, json: null };
  const errors = [];
  for (const arg of argv) {
    const [flag, value] = arg.split(/=(.*)/s, 2);
    const int = (max) => {
      const parsed = parsePositiveInt(value, null, max);
      if (parsed === null) errors.push(`${flag} needs a whole number from 1 to ${max}`);
      return parsed;
    };
    switch (flag) {
      case "--projects":
        options.projects = int(MAX_PROJECTS) ?? options.projects;
        break;
      case "--terminals":
        if (value === "0") options.terminals = 0;
        else options.terminals = int(MAX_TERMINALS) ?? options.terminals;
        break;
      case "--stream":
        options.stream = true;
        break;
      case "--blurred":
        options.blurred = true;
        break;
      case "--all":
        options.all = true;
        break;
      case "--runs":
        options.runs = int(1_000) ?? options.runs;
        break;
      case "--window-seconds":
        options.windowSeconds = int(3_600) ?? options.windowSeconds;
        break;
      case "--settle-seconds":
        if (value === "0") options.settleSeconds = 0;
        else options.settleSeconds = int(600) ?? options.settleSeconds;
        break;
      case "--json":
        if (!value) errors.push("--json needs a path");
        else options.json = path.resolve(value);
        break;
      default:
        errors.push(`unknown argument ${arg}`);
    }
  }
  if (!options.all && options.stream && options.terminals === 0) {
    errors.push("--stream needs at least one terminal");
  }
  return errors.length > 0 ? { errors } : { options };
}

/** Even split, remainder to the first (active) projects: 19 over 3 is 7/6/6. */
export function distributeTerminals(projects, total) {
  const base = Math.floor(total / projects);
  const extra = total % projects;
  return Array.from({ length: projects }, (_, index) => base + (index < extra ? 1 : 0));
}

export function cellName({ projects, terminals, stream, blurred }) {
  return `p${projects}-t${terminals}-${stream ? "stream" : "quiet"}-${blurred ? "blurred" : "focused"}`;
}

/** The app-side config for one cell. See `IdleHarnessConfig`. */
export function cellConfig(cell, { windowSeconds, settleSeconds, samplerPath }) {
  const terminalsPerProject = distributeTerminals(cell.projects, cell.terminals);
  return {
    cell: cellName(cell),
    terminalsPerProject,
    stream: cell.stream,
    blurred: cell.blurred,
    protectedProjectIndex: cell.projects >= 2 && terminalsPerProject[1] > 0 ? 1 : null,
    windowMs: windowSeconds * 1000,
    settleMs: settleSeconds * 1000,
    samplerPath,
  };
}

/** Every valid cell of the issue's matrix. Streaming needs a terminal to stream in. */
export function enumerateMatrix() {
  const cells = [];
  for (const projects of MATRIX.projects) {
    for (const terminals of MATRIX.terminals) {
      for (const stream of MATRIX.stream) {
        if (stream && terminals === 0) continue;
        for (const blurred of MATRIX.blurred) cells.push({ projects, terminals, stream, blurred });
      }
    }
  }
  return cells;
}

/**
 * The child environment: the runner's own, minus anything that would change
 * what the app does — inherited Daintree switches (E2E, demo, profiling) and
 * run-as-Node flags. Everything the harness needs is added back explicitly.
 */
export function sanitizeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.toUpperCase().startsWith("DAINTREE_")) continue;
    if (key === "ELECTRON_RUN_AS_NODE" || key === "ATOM_SHELL_INTERNAL_RUN_AS_NODE") continue;
    out[key] = value;
  }
  return out;
}

export function extractIdleResult(output) {
  const text = String(output ?? "");
  const start = text.lastIndexOf(RESULT_PREFIX);
  if (start < 0) return null;
  const end = text.indexOf("\n", start);
  try {
    return JSON.parse(text.slice(start + RESULT_PREFIX.length, end < 0 ? undefined : end));
  } catch {
    return null;
  }
}

/** Why a run does not count, or null when it does. Numbers never make a run invalid. */
export function judgeRun({ code, signal, output, timedOut }, result) {
  if (timedOut) return "timed out";
  if (!result) return "no RESULT line";
  if (!result.valid) return (result.failures ?? []).join("; ") || "cell did not materialise";
  if (String(output).includes(FAILURE_MARKER)) return "harness reported a failure";
  if (code !== 0) return `exited with code ${code} (signal ${signal})`;
  if (!String(output).includes(COMPLETE_MARKER)) return "no COMPLETE marker";
  return null;
}

export function stats(values) {
  const sorted = values
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, min: sorted[0], median, max: sorted[sorted.length - 1] };
}

/** Headline figures of one run, flat, for summaries and aggregation. */
export function headline(result) {
  return {
    cpuPercent: result.tree?.cpuPercent ?? null,
    idleWakeupsPerSec: result.tree?.idleWakeupsPerSec ?? null,
    interruptWakeupsPerSec: result.tree?.interruptWakeupsPerSec ?? null,
    spawnsPerSec: result.spawns?.perSecond ?? null,
    sysmondCpuPercent: result.daemons?.sysmond?.cpuPercent ?? null,
    fseventsdCpuPercent: result.daemons?.fseventsd?.cpuPercent ?? null,
    workspaceHostRestarts: result.workspaceHosts?.restarts ?? null,
    profileTransitions: result.resourceProfile?.transitions?.length ?? null,
  };
}

export function summariseCell(results) {
  const heads = results.map(headline);
  const summary = {};
  for (const key of Object.keys(heads[0] ?? {})) summary[key] = stats(heads.map((h) => h[key]));
  const byLabel = {};
  for (const result of results) {
    for (const [label, usage] of Object.entries(result.tree?.byLabel ?? {})) {
      (byLabel[label] ??= []).push(usage.cpuPercent);
    }
  }
  summary.cpuPercentByLabel = Object.fromEntries(
    Object.entries(byLabel).map(([label, values]) => [label, stats(values)])
  );
  return summary;
}

function formatRun(result) {
  const h = headline(result);
  const labels = Object.entries(result.tree?.byLabel ?? {})
    .slice(0, 6)
    .map(([label, usage]) => `${label} ${usage.cpuPercent}%`)
    .join(", ");
  const commands = Object.entries(result.spawns?.byCommand ?? {})
    .slice(0, 4)
    .map(([command, count]) => `${command}×${count}`)
    .join(", ");
  return [
    `tree ${h.cpuPercent}% of a core, ${h.idleWakeupsPerSec} idle / ${h.interruptWakeupsPerSec} interrupt wakeups/s`,
    `  by label: ${labels}`,
    `  spawns ${h.spawnsPerSec}/s${commands ? ` (${commands})` : ""}`,
    `  sysmond ${h.sysmondCpuPercent ?? "?"}%, fseventsd ${h.fseventsdCpuPercent ?? "?"}%` +
      `, workspace-host restarts ${h.workspaceHostRestarts}, profile transitions ${h.profileTransitions}`,
  ].join("\n");
}

function compileSampler(dir) {
  const output = path.join(dir, "idle-harness-sampler");
  const result = spawnSync("xcrun", ["clang", "-O2", "-o", output, SAMPLER_SOURCE], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not compile the process sampler with xcrun clang: ${
        result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`
      }`
    );
  }
  return output;
}

function gitRevision() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.errors) throw new Error(parsed.errors.join("; "));
  const options = parsed.options;
  if (process.platform !== "darwin") {
    throw new Error("the idle harness samples Mach rusage counters and runs on macOS only");
  }
  await assertBuildArtifacts();

  const cells = options.all
    ? enumerateMatrix()
    : [
        {
          projects: options.projects,
          terminals: options.terminals,
          stream: options.stream,
          blurred: options.blurred,
        },
      ];
  const toolDir = await mkdtemp(path.join(os.tmpdir(), "daintree-idle-harness-tools-"));
  const report = {
    schema: 1,
    createdAt: new Date().toISOString(),
    revision: gitRevision(),
    options: {
      runs: options.runs,
      windowSeconds: options.windowSeconds,
      settleSeconds: options.settleSeconds,
    },
    cells: [],
  };
  let invalidRuns = 0;

  try {
    const samplerPath = compileSampler(toolDir);
    const timeoutMs = (options.windowSeconds + options.settleSeconds) * 1000 + OVERHEAD_TIMEOUT_MS;
    const baseEnv = sanitizeEnv(process.env);

    for (const cell of cells) {
      const config = cellConfig(cell, { ...options, samplerPath });
      const entry = { cell: config.cell, config, runs: [], summary: null };
      report.cells.push(entry);
      console.log(
        `[${TAG}] ${config.cell}: terminals ${JSON.stringify(config.terminalsPerProject)}`
      );

      for (let run = 1; run <= options.runs; run++) {
        const censusDir = await mkdtemp(path.join(os.tmpdir(), "daintree-idle-census-"));
        try {
          const outcome = await launchHarnessRun({
            runIndex: run,
            runCount: options.runs,
            timeoutMs,
            harnessArgs: IDLE_HARNESS_ARGS,
            baseEnv,
            extraEnv: {
              [CONFIG_ENV]: JSON.stringify(config),
              [CENSUS_DIR_ENV]: censusDir,
            },
            tag: TAG,
            shouldEcho: (text) => text.includes(LOG_PREFIX) && !text.includes(RESULT_PREFIX),
            userDataPrefix: "daintree-idle-harness-run-",
          });
          const result = extractIdleResult(outcome.output);
          const invalid = judgeRun(outcome, result);
          entry.runs.push(invalid ? { invalid, result } : result);
          if (invalid) {
            invalidRuns++;
            console.error(
              `[${TAG}] ${config.cell} run ${run}/${options.runs}: INVALID — ${invalid}`
            );
            if (!result) {
              console.error(
                boundedTail(String(outcome.output).trimEnd(), MAX_DUMP_CHARS) || "(no output)"
              );
            }
          } else {
            console.log(
              `[${TAG}] ${config.cell} run ${run}/${options.runs}:\n${formatRun(result)}`
            );
          }
        } finally {
          await rm(censusDir, { recursive: true, force: true }).catch(() => {});
        }
      }

      const valid = entry.runs.filter((run) => !run.invalid);
      entry.summary = valid.length > 0 ? summariseCell(valid) : null;
      if (valid.length > 1) {
        const s = entry.summary;
        console.log(
          `[${TAG}] ${config.cell} over ${valid.length} runs: cpu% ${JSON.stringify(s.cpuPercent)}, ` +
            `idle wakeups/s ${JSON.stringify(s.idleWakeupsPerSec)}`
        );
      }
    }
  } finally {
    await rm(toolDir, { recursive: true, force: true }).catch(() => {});
    if (options.json) {
      await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`[${TAG}] wrote ${options.json}`);
    }
  }

  if (invalidRuns > 0) throw new Error(`${invalidRuns} run(s) did not produce a valid measurement`);
  console.log(`[${TAG}] done`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then(() => exitAfterFlush(0))
    .catch((error) => {
      console.error(`[${TAG}] FAILED:`, error instanceof Error ? error.message : String(error));
      exitAfterFlush(1);
    });
}
