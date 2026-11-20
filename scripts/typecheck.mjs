#!/usr/bin/env node
// Typechecks every TypeScript project in the repo with the TS7 native compiler
// (`typescript7`; the `typescript` dependency stays on TS6 for typescript-eslint).
//
//   node scripts/typecheck.mjs                 all projects (`npm run typecheck`)
//   node scripts/typecheck.mjs --changed       only projects the branch touches
//   node scripts/typecheck.mjs --changed --base <ref> --dry-run
//   node scripts/typecheck.mjs --only <project>   one project, no output prefix
//
// `--only` and `runProjectSync` are what the build's type gates call (`root`
// ahead of `vite build`, `plugins` inside build-main.mjs), so the build and
// `npm run typecheck` cannot drift onto different compilers or arguments.
//
// `--changed` exists for machines running many agent worktrees at once, where
// every agent checking all twelve projects stacks compiler processes into swap.
// A project is selected when its own program (`tsc --listFilesOnly`) contains a
// file changed since the merge base with origin/develop, committed or not. That
// list is exact, so an import from an unexpected folder cannot slip past it.
// What a program list cannot show selects everything: manifests, tsconfigs,
// workspace packages (consumers read their built `dist`, which git never sees),
// deleted or renamed sources whose importers may now break, and added or
// removed JavaScript, which can shadow a module resolution without ever
// entering a program (`allowJs` is off).
//
// The all-project modes read their limits from the environment, which passes
// through `npm run typecheck`'s nested scripts untouched (CI sets all three):
//
//   TYPECHECK_CONCURRENCY        compilers at once (default 3)
//   TYPECHECK_TIMEOUT_MINUTES    whole-run deadline; past it, exit 124 (default none)
//   TYPECHECK_MIN_AVAILABLE_MB   Linux: stop when MemAvailable falls below this
//
// A run that stops reports every unfinished project with its step, command,
// pid, age, memory and the output it had buffered, then kills its compilers.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSC = "node_modules/typescript7/bin/tsc";
const DEFAULT_CONCURRENCY = 3;
const HEARTBEAT_MS = 30_000;
const MEMORY_CHECK_MS = 2_000;
const KILL_GRACE_MS = 5_000;
export const DEADLINE_STATUS = 124;

// `configs` lists every tsconfig whose program the project checks, including
// referenced composite projects, since `-b` sees those only as emitted `.d.ts`.
export const PROJECTS = [
  { name: "root", steps: [["--noEmit"]], configs: ["tsconfig.json"] },
  {
    name: "electron",
    steps: [
      ["-b", "electron/tsconfig.json"],
      ["--noEmit", "-p", "electron/tsconfig.preload.json"],
    ],
    configs: ["shared/tsconfig.json", "electron/tsconfig.json", "electron/tsconfig.preload.json"],
  },
  ...[
    ["perf", "tsconfig.perf.json"],
    ["e2e", "tsconfig.e2e.json"],
    ["plugins", "tsconfig.plugins.json"],
    ["plugin-views", "tsconfig.plugin-views.json"],
    ["daintree-plugin", "packages/daintree-plugin/tsconfig.json"],
    ["create-daintree-plugin", "packages/create-daintree-plugin/tsconfig.json"],
    ["plugin-sdk", "packages/plugin-sdk/tsconfig.json"],
    ["plugin-vite", "packages/plugin-vite/tsconfig.json"],
    ["svelte-source-model", "packages/svelte-source-model/tsconfig.json"],
    ["tour", "packages/tour/tsconfig.json"],
  ].map(([name, config]) => ({ name, steps: [["--noEmit", "-p", config]], configs: [config] })),
];

const DELETION_SENSITIVE = /\.(?:[cm]?[jt]sx?|json)$/;
const RESOLUTION_ONLY = /\.(?:[cm]?jsx?)$/;

export function runAllReason(change) {
  const base = path.posix.basename(change.path);
  if (base === "package.json" || base === "package-lock.json") return `${change.path} changed`;
  if (/^tsconfig.*\.json$/.test(base)) return `${change.path} changed`;
  if (change.path.startsWith("packages/")) return `workspace package ${change.path} changed`;
  if (change.removed && DELETION_SENSITIVE.test(change.path)) {
    return `${change.path} was deleted or renamed`;
  }
  if (change.added && RESOLUTION_ONLY.test(change.path)) return `${change.path} was added`;
  return null;
}

// `listFiles(config)` returns repo-relative posix paths, or null when the
// program could not be listed (the project is then checked to be safe).
export function selectProjects(changes, listFiles, projects = PROJECTS) {
  for (const change of changes) {
    const reason = runAllReason(change);
    if (reason) return projects.map((project) => ({ project, reason }));
  }
  const present = changes.filter((change) => !change.removed).map((change) => change.path);
  if (present.length === 0) return [];

  const selected = [];
  for (const project of projects) {
    let reason = null;
    for (const config of project.configs) {
      const files = listFiles(config);
      if (files === null) {
        reason = `could not list ${config}`;
        break;
      }
      const set = new Set(files);
      const hit = present.find((file) => set.has(file));
      if (hit) {
        reason = hit;
        break;
      }
    }
    if (reason) selected.push({ project, reason });
  }
  return selected;
}

// Parses `git diff --name-status -z`: status, path, and a second path for
// renames and copies, all NUL-separated.
export function parseNameStatus(output) {
  const tokens = output.split("\0");
  const changes = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++];
    if (status.startsWith("R")) {
      changes.push(
        { path: tokens[i++], removed: true, added: false },
        { path: tokens[i++], removed: false, added: true }
      );
    } else if (status.startsWith("C")) {
      i++;
      changes.push({ path: tokens[i++], removed: false, added: true });
    } else {
      changes.push({ path: tokens[i++], removed: status === "D", added: status === "A" });
    }
  }
  return changes;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolveBase(explicit) {
  const candidates = explicit ? [explicit] : ["origin/develop", "develop"];
  for (const ref of candidates) {
    try {
      return git(["merge-base", "HEAD", ref]).trim();
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function changedFiles(base) {
  const tracked = parseNameStatus(git(["diff", "--name-status", "-M", "-z", base]));
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ path: file, removed: false, added: true }));
  return [...tracked, ...untracked];
}

function listProgramFiles(config) {
  let output;
  try {
    output = execFileSync(process.execPath, [TSC, "--listFilesOnly", "-p", config], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Partial output from a failed listing could omit the changed file.
    return null;
  }
  const files = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .filter((file) => !file.startsWith("..") && !file.startsWith("node_modules/"));
  return files.length > 0 ? files : null;
}

function tscMissing() {
  if (existsSync(path.join(ROOT, TSC))) return false;
  console.error(`[typecheck] ${TSC} is missing; run npm install`);
  return true;
}

// Runs one project's steps in order with inherited stdio and returns the exit
// status: the first failing step's, or 0.
export function runProjectSync(name, { spawnStep = spawnSync } = {}) {
  const project = PROJECTS.find((candidate) => candidate.name === name);
  if (!project) {
    const known = PROJECTS.map((candidate) => candidate.name).join(", ");
    console.error(`[typecheck] unknown project "${name}"; expected one of: ${known}`);
    return 1;
  }
  if (tscMissing()) return 1;
  for (const args of project.steps) {
    const result = spawnStep(process.execPath, [TSC, ...args], { cwd: ROOT, stdio: "inherit" });
    if (result.error) console.error(`[typecheck] ${project.name} spawn failed:`, result.error);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

// The exit status for `--only <project>`, which excludes the all-project modes.
export function runOnly(argv, runProject = runProjectSync) {
  if (argv.includes("--changed") || argv.includes("--dry-run")) {
    console.error("[typecheck] --only cannot be combined with --changed or --dry-run");
    return 2;
  }
  return runProject(argv[argv.indexOf("--only") + 1] ?? "");
}

function positiveNumber(env, name, integer) {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}, got "${raw}"`);
  }
  return value;
}

// Throws on a malformed value, so a typo in CI cannot silently drop a limit.
export function readRunOptions(env = process.env) {
  const minutes = positiveNumber(env, "TYPECHECK_TIMEOUT_MINUTES", false);
  const floorMb = positiveNumber(env, "TYPECHECK_MIN_AVAILABLE_MB", false);
  return {
    concurrency: positiveNumber(env, "TYPECHECK_CONCURRENCY", true) ?? DEFAULT_CONCURRENCY,
    deadlineMs: minutes === null ? 0 : minutes * 60_000,
    minAvailableBytes: floorMb === null ? 0 : floorMb * 2 ** 20,
    heartbeatMs: env.CI && env.CI !== "false" && env.CI !== "0" ? HEARTBEAT_MS : 0,
  };
}

function readProcBytes(file, field) {
  try {
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((candidate) => candidate.startsWith(`${field}:`));
    const kib = line ? Number.parseInt(line.slice(field.length + 1), 10) : NaN;
    return Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    return null;
  }
}

const readRss = (pid) =>
  process.platform === "linux" && pid ? readProcBytes(`/proc/${pid}/status`, "VmRSS") : null;
const readAvailable = () =>
  process.platform === "linux" ? readProcBytes("/proc/meminfo", "MemAvailable") : null;

const spawnCompilerStep = (args) =>
  spawn(process.execPath, [TSC, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

// On POSIX the TS7 shim execve()s into the native compiler, so the child's pid
// is the compiler. On Windows the shim waits on it in execFileSync, so /T
// reaches it through the live wrapper.
function killCompiler(child) {
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status === 0) return;
  }
  child.kill("SIGKILL");
}

function duration(ms) {
  const total = Math.round(ms / 1000);
  return total < 60
    ? `${total}s`
    : `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

const gib = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

function prefixed(name, chunks) {
  const text = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  return text
    ? text
        .split(/\r?\n/)
        .map((line) => `[${name}] ${line}\n`)
        .join("")
    : "";
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const SIGNAL_STATUS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

// Checks `projects` with at most `concurrency` compilers at once, printing each
// project's output as one block when it finishes, and resolves to the exit
// status: 0, 1 when any project failed, DEADLINE_STATUS past the deadline, 1
// under the memory floor, or 128 + n on a signal. A step settles on `close`,
// not `exit`, so its last diagnostic is never left in the pipe.
export function runProjects(projects, options = {}, deps = {}) {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    deadlineMs = 0,
    heartbeatMs = 0,
    minAvailableBytes = 0,
  } = options;
  const {
    spawnStep = spawnCompilerStep,
    kill = killCompiler,
    write = (text) => process.stdout.write(text),
    rssOf = readRss,
    availableMemory = readAvailable,
    signals = process,
    now = Date.now,
  } = deps;

  return new Promise((resolve) => {
    const started = now();
    const queue = [...projects];
    const active = new Set();
    const live = new Set();
    const intervals = [];
    const timeouts = [];
    let finished = 0;
    let status = 0;
    let stopped = false;
    let done = false;

    const onSignal = (signal) => {
      if (stopped) process.exit(SIGNAL_STATUS[signal]);
      stop(`received ${signal}`, SIGNAL_STATUS[signal]);
    };

    const clearTimers = () => {
      for (const timer of intervals) clearInterval(timer);
      for (const timer of timeouts) clearTimeout(timer);
      intervals.length = 0;
      timeouts.length = 0;
    };

    const finish = () => {
      if (done) return;
      done = true;
      clearTimers();
      for (const signal of SIGNALS) signals.off(signal, onSignal);
      resolve(status);
    };

    const memoryNote = () => {
      const available = availableMemory();
      return available === null ? "" : `; ${gib(available)} available`;
    };

    const describe = (run) => {
      const rss = rssOf(run.child.pid);
      const steps = run.project.steps.length;
      return (
        `${run.project.name} step ${run.step + 1}/${steps} (pid ${run.child.pid ?? "none"}, ` +
        `${duration(now() - run.started)}${rss === null ? "" : `, rss ${gib(rss)}`})`
      );
    };

    const complete = (run, code) => {
      active.delete(run);
      finished += 1;
      if (code !== 0) status = 1;
      const verdict = code === 0 ? "passed" : `failed (exit ${code})`;
      write(
        prefixed(run.project.name, run.output) +
          `[typecheck] ${run.project.name} ${verdict} in ${duration(now() - run.started)}\n`
      );
      next();
    };

    const runStep = (run) => {
      run.stepStarted = now();
      let child;
      try {
        child = spawnStep(run.project.steps[run.step]);
      } catch (error) {
        run.output.push(Buffer.from(`spawn failed: ${error.message}\n`));
        complete(run, 1);
        return;
      }
      run.child = child;
      live.add(child);
      let settled = false;
      const settle = (code) => {
        if (settled) return;
        settled = true;
        live.delete(child);
        if (stopped) {
          if (live.size === 0) finish();
          return;
        }
        if (code === 0 && run.step + 1 < run.project.steps.length) {
          run.step += 1;
          runStep(run);
        } else {
          complete(run, code);
        }
      };
      const collect = (chunk) => run.output.push(Buffer.from(chunk));
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => {
        collect(`spawn failed: ${error.message}\n`);
        if (child.pid === undefined) settle(1);
      });
      child.on("close", (code, signal) => settle(signal ? 1 : (code ?? 1)));
    };

    const next = () => {
      while (!stopped && queue.length > 0 && active.size < concurrency) {
        const run = { project: queue.shift(), step: 0, started: now(), output: [], child: null };
        active.add(run);
        runStep(run);
      }
      if (!stopped && active.size === 0 && queue.length === 0) finish();
    };

    function stop(reason, code) {
      if (stopped || done) return;
      stopped = true;
      status = code;
      clearTimers();
      const running = [...active];
      const notStarted = queue.map((project) => project.name);
      let report =
        `[typecheck] ${reason} after ${duration(now() - started)}: ` +
        `${finished}/${projects.length} project(s) finished, ${running.length} still running` +
        (notStarted.length > 0 ? `, not started: ${notStarted.join(", ")}` : "") +
        `${memoryNote()}\n`;
      for (const run of running) {
        const args = run.project.steps[run.step];
        report +=
          `[typecheck] unfinished: ${describe(run)}, this step ${duration(now() - run.stepStarted)}: ` +
          `node ${TSC} ${args.join(" ")}\n` +
          (run.output.length > 0
            ? prefixed(run.project.name, run.output)
            : `[${run.project.name}] (no compiler output yet)\n`);
      }
      write(report);
      if (live.size === 0) {
        finish();
        return;
      }
      for (const child of live) kill(child);
      timeouts.push(
        setTimeout(() => {
          for (const child of live) {
            write(`[typecheck] pid ${child.pid} did not exit after it was killed\n`);
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref?.();
          }
          finish();
        }, KILL_GRACE_MS)
      );
    }

    for (const signal of SIGNALS) signals.on(signal, onSignal);
    if (heartbeatMs > 0) {
      write(
        `[typecheck] ${projects.length} project(s), ${Math.min(concurrency, projects.length)} at a time` +
          `${deadlineMs > 0 ? `, deadline ${duration(deadlineMs)}` : ""}${memoryNote()}\n`
      );
      intervals.push(
        setInterval(() => {
          const running = [...active].map(describe).join(", ") || "nothing";
          write(
            `[typecheck] ${duration(now() - started)}: ${finished}/${projects.length} finished, ` +
              `running ${running}; ${queue.length} queued${memoryNote()}\n`
          );
        }, heartbeatMs)
      );
    }
    if (deadlineMs > 0) {
      timeouts.push(
        setTimeout(
          () => stop(`deadline of ${duration(deadlineMs)} reached`, DEADLINE_STATUS),
          deadlineMs
        )
      );
    }
    if (minAvailableBytes > 0 && availableMemory() !== null) {
      intervals.push(
        setInterval(() => {
          const available = availableMemory();
          if (available !== null && available < minAvailableBytes) {
            stop(
              `available memory fell to ${gib(available)}, under the ${gib(minAvailableBytes)} floor`,
              1
            );
          }
        }, MEMORY_CHECK_MS)
      );
    }
    next();
  });
}

async function runAll(projects) {
  let options;
  try {
    options = readRunOptions();
  } catch (error) {
    console.error(`[typecheck] ${error.message}`);
    return 2;
  }
  return runProjects(projects, options);
}

async function main() {
  const argv = process.argv.slice(2);
  const changedMode = argv.includes("--changed");
  const dryRun = argv.includes("--dry-run");
  const baseIndex = argv.indexOf("--base");
  const explicitBase = baseIndex === -1 ? null : argv[baseIndex + 1];

  if (argv.includes("--only")) process.exit(runOnly(argv));

  if (tscMissing()) process.exit(1);

  if (!changedMode) {
    if (!dryRun) process.exitCode = await runAll(PROJECTS);
    return;
  }

  const base = resolveBase(explicitBase);
  let selected;
  if (!base) {
    console.log("[typecheck] no merge base with develop; checking every project");
    selected = PROJECTS.map((project) => ({ project, reason: "no merge base" }));
  } else {
    const changes = changedFiles(base);
    selected = selectProjects(changes, listProgramFiles);
    console.log(
      `[typecheck] ${changes.length} changed file(s) since ${base.slice(0, 10)}; ` +
        `${selected.length} of ${PROJECTS.length} project(s) affected`
    );
  }

  for (const { project, reason } of selected) console.log(`  ${project.name}: ${reason}`);
  if (selected.length === 0 || dryRun) return;
  process.exitCode = await runAll(selected.map(({ project }) => project));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
