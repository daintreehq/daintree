/**
 * CDP freeze harness runner (#11846) — launches the built Electron app in
 * `--daintree-freeze-harness` mode and validates that a cached project view's
 * renderer genuinely stops executing tasks when the production efficiency-freeze
 * path freezes it, and resumes when it is thawed.
 *
 * Deliberately not a Playwright spec. Playwright sends
 * `Emulation.setFocusEmulationEnabled` to every page target it attaches to,
 * which pins the renderer to "user-visible" and makes
 * `Page.setWebLifecycleState(frozen)` a silent no-op that still returns ok. A
 * freeze assertion written in Playwright passes whether or not freeze works, so
 * it can never fail. This runner keeps Playwright out of the process entirely.
 *
 * Mirrors `run-smoke.mjs`: spawn the real app, scrape markers, exit non-zero on
 * a missing marker or a non-zero child exit. The measurement and every
 * assertion live in `electron/services/freezeHarness.ts` — this file only
 * launches and adjudicates.
 *
 * Platform coverage: measured on macOS only. The finding is Chromium/CDP
 * semantics so it should hold cross-platform, but that is an inference. Windows
 * is the platform most likely to differ and is unverified.
 */

import { spawn, spawnSync } from "child_process";
import { constants as fsConstants } from "fs";
import { access, mkdtemp, rm } from "fs/promises";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");

const BUILD_ARTIFACTS = [
  "dist/index.html",
  "dist-electron/electron/bootstrap.js",
  "dist-electron/electron/main.js",
];

export const REQUIRED_MARKERS = [
  "[FREEZE-HARNESS] CHECK: cached view ready",
  "[FREEZE-HARNESS] CHECK: probe running — OK",
  "[FREEZE-HARNESS] CHECK: freeze ratio — OK",
  "[FREEZE-HARNESS] CHECK: recovery — OK",
  "[FREEZE-HARNESS] PASS",
];

const FAILURE_MARKER = "[FREEZE-HARNESS] FAILED";

/** Grace between the graceful kill and the hard one, and again before we stop waiting. */
const CHILD_KILL_GRACE_MS = 5_000;
/** How long the stdio pipes get to drain after the root exits before we settle anyway. */
const OUTPUT_DRAIN_MS = 2_000;
/** Cap on how long settlement waits for the user-data dir to be removed. */
const CLEANUP_DEADLINE_MS = 5_000;
/** Cap on the failure dump, so one write cannot outrun the flush before exit. */
const MAX_DUMP_CHARS = 64_000;
/** Backstop for a pipe whose write callback never fires. See `exitAfterFlush`. */
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * Node clamps an out-of-range `setTimeout` delay to 1ms, so an oversized
 * timeout is not a long timeout — it is an instant one. Anything above this
 * falls back rather than silently inverting what the caller asked for.
 */
const MAX_TIMER_MS = 2_147_483_647;
/** Runs are ~15s each; a ceiling here is a typo guard, not a capability limit. */
const MAX_RUNS = 1_000;

export function parsePositiveInt(value, fallback, max = MAX_TIMER_MS) {
  const raw = String(value ?? "").trim();
  // Number.parseInt("5junk") is 5 and parseInt("1.5") is 1; neither is what the
  // caller wrote, and silently reinterpreting an env var is how you debug the
  // wrong run for an hour.
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

/**
 * Last `maxChars` of the child's output, prefixed with how much was dropped.
 * The dump is a single write racing `exitAfterFlush`'s bail timer, so it has to
 * be a predictable size — a chatty 180s child can otherwise produce a string
 * large enough that the flush is cut off and the diagnostic is lost entirely.
 */
export function boundedTail(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  const dropped = value.length - maxChars;
  return `[... ${dropped} earlier characters omitted ...]\n${value.slice(-maxChars)}`;
}

/**
 * How to kill the child's whole tree on a given platform, as data.
 *
 * Electron's descendants (GPU, utility, pty-host, workspace-host) inherit this
 * script's stdout/stderr, so a survivor holds those pipes open and this process
 * never exits — the v0.32.0 Windows hang, which took a release step from 43s to
 * a 12-minute timeout. Killing the root alone is not enough.
 *
 * Deliberately PID-scoped on both platforms. `run-packaged-smoke.mjs` can fall
 * back to `taskkill /im Daintree.exe` because it is single-tenant against a
 * packaged build; this runner launches the *unpackaged* `electron.exe`, so an
 * image-name kill would take out VS Code and every other Electron app on the
 * developer's machine. There is no last resort here, by design.
 *
 * Returned as a descriptor rather than executed so the platform branch is
 * testable without spawning anything.
 */
export function describeTreeKill(platform, pid, { force = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "none" };
  if (platform === "win32") {
    // `/t` walks the tree as it stands right now, so a descendant already
    // reparented away is out of reach; the caller escalates rather than
    // trusting one call, and stops entirely once the root pid is stale.
    // `/f` only on escalation. Without it taskkill asks the tree to close, which
    // is the graceful half of the same escalation the POSIX branch expresses as
    // SIGTERM-then-SIGKILL; forcing on the first call would make the second one
    // a duplicate rather than a step up.
    const args = ["/pid", String(pid), "/t"];
    if (force) args.push("/f");
    return { kind: "taskkill", command: "taskkill", args };
  }
  // Valid only because the child is spawned `detached` on POSIX, which makes it
  // a process-group leader with pgid === pid. Never negate a pid that was not.
  // The group outlives the leader, so this stays deliverable after the root has
  // exited — which is precisely when the survivors matter.
  return { kind: "group-signal", pid: -pid, signal: force ? "SIGKILL" : "SIGTERM" };
}

/** Whether the child should lead its own process group. Windows has no groups. */
export function shouldDetach(platform) {
  return platform !== "win32";
}

/**
 * Is the pid still a safe thing to aim at once the root has exited?
 *
 * Platform-specific, because the two branches address different things. Windows
 * `taskkill /pid /t` walks a tree rooted at that pid, which no longer exists —
 * and the pid may already have been recycled onto an unrelated process. POSIX
 * aims at `-pid`, the process GROUP, which outlives its leader and still
 * contains exactly the survivors holding our pipes. Suppressing there would
 * disable the escalation at the moment it becomes the only thing that can work.
 */
export function shouldSuppressTreeKill(platform, rootExited) {
  return rootExited && platform === "win32";
}

function runTreeKill(child, { force, rootExited, sync = false }) {
  if (shouldSuppressTreeKill(process.platform, rootExited)) return;
  const action = describeTreeKill(process.platform, child.pid, { force });
  if (action.kind === "none") return;
  if (action.kind === "taskkill") {
    // Synchronously when we are about to exit: `spawn` only *starts* taskkill,
    // and a runner that exits in the same tick gives it no ordering guarantee.
    // POSIX needs no equivalent — `process.kill` is the syscall itself.
    if (sync) {
      try {
        spawnSync(action.command, action.args, { stdio: "ignore", windowsHide: true });
      } catch {
        // Nothing left to escalate to.
      }
      return;
    }
    spawn(action.command, action.args, { stdio: "ignore", windowsHide: true }).on(
      "error",
      () => {}
    );
    return;
  }
  try {
    process.kill(action.pid, action.signal);
  } catch {
    // The group is already gone, or we raced its exit. Fall back to the root.
    try {
      child.kill(action.signal);
    } catch {
      // Ignore races with process exit.
    }
  }
}

/**
 * Exit without waiting for the event loop to drain.
 *
 * Mirrors `run-packaged-smoke.mjs`. Flush first: under CI stdout/stderr are
 * pipes, which are async, and this script forwards the app's output through
 * them — a bare exit truncates the tail of the log, which is exactly the part
 * that explains a failure. The timer is the backstop for a blocked pipe whose
 * write callback never fires, and is unref'd so it cannot itself hold us open.
 */
function exitAfterFlush(code) {
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };

  const bail = setTimeout(done, FLUSH_TIMEOUT_MS);
  bail.unref();

  process.stdout.write("", () => {
    process.stderr.write("", done);
  });
}

/**
 * Pull the machine-readable RESULT line out of the child's output, so a run can
 * report its numbers even when it fails. Returns null when absent.
 */
export function extractResultLine(output) {
  const match = /\[FREEZE-HARNESS\] RESULT (\{.*\})/.exec(output ?? "");
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function validateHarnessOutput(runIndex, runCount, result) {
  const { code, signal, output, timedOut } = result;
  if (timedOut) {
    throw new Error(`Freeze harness run ${runIndex}/${runCount} timed out`);
  }
  if (output.includes(FAILURE_MARKER)) {
    throw new Error(`Freeze harness run ${runIndex}/${runCount} reported a failure`);
  }
  if (code !== 0) {
    throw new Error(
      `Freeze harness run ${runIndex}/${runCount} failed with code ${code} (signal ${signal})`
    );
  }
  for (const marker of REQUIRED_MARKERS) {
    if (!output.includes(marker)) {
      throw new Error(
        `Freeze harness run ${runIndex}/${runCount} missing expected marker: ${marker}`
      );
    }
  }
}

async function assertBuildArtifacts() {
  for (const relativePath of BUILD_ARTIFACTS) {
    const fullPath = path.join(ROOT, relativePath);
    try {
      await access(fullPath, fsConstants.R_OK);
    } catch {
      throw new Error(`Missing build artifact: ${relativePath}. Run "npm run build" first.`);
    }
  }
}

function runHarnessOnce({ runIndex, runCount, timeoutMs }) {
  const electronPath = require("electron");
  return new Promise((resolve, reject) => {
    mkdtemp(path.join(os.tmpdir(), "daintree-freeze-harness-run-"))
      .then((userDataDir) => {
        const args = [
          ".",
          "--daintree-freeze-harness",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--noerrdialogs",
          `--user-data-dir=${userDataDir}`,
        ];
        if (process.platform === "linux") {
          args.push("--no-sandbox");
        }

        console.log(`[FREEZE-RUNNER] Run ${runIndex}/${runCount}: launching Electron`);

        const env = { ...process.env, NODE_ENV: "production" };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.ATOM_SHELL_INTERNAL_RUN_AS_NODE;

        const child = spawn(electronPath, args, {
          cwd: ROOT,
          env,
          detached: shouldDetach(process.platform),
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let output = "";
        let hardKillTimer;
        let giveUpTimer;
        let drainTimer;
        let settled = false;
        // Set from `exit`, which fires when the root process goes away. `close`
        // fires only once every inherited stdio pipe has drained — see below.
        let rootExited = false;
        let exitCode = null;
        let exitSignal = null;

        const onSignal = (signal) => {
          // On POSIX `detached` put Electron in its own process group, so a
          // Ctrl+C in the terminal reaches this script and nothing else. Pass it
          // on, or we trade the Windows hang this file exists to fix for a POSIX
          // orphan. Windows spawns attached, but forwarding is still correct
          // there — the runner is the only thing that will do it.
          runTreeKill(child, { force: false, rootExited, sync: true });
          process.exit(128 + (os.constants.signals[signal] ?? 0));
        };
        const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
        for (const signal of SIGNALS) process.on(signal, onSignal);

        // One settlement path. `error` and `close` can both fire, `close` may
        // never fire at all, and cleanup must never be what decides whether this
        // promise settles.
        const finish = async (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          if (hardKillTimer) clearTimeout(hardKillTimer);
          if (giveUpTimer) clearTimeout(giveUpTimer);
          if (drainTimer) clearTimeout(drainTimer);
          for (const signal of SIGNALS) process.off(signal, onSignal);
          // Awaited, but only up to a deadline. Awaiting unconditionally is the
          // hang this file exists to prevent; not awaiting at all means the
          // explicit exit routinely kills the removal mid-flight and leaks an
          // Electron profile per run. On Windows a held handle also needs a
          // moment to be released after the tree dies.
          await Promise.race([
            rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
              (removeError) => {
                console.error(
                  `[FREEZE-RUNNER] Could not remove ${userDataDir}: ${
                    removeError instanceof Error ? removeError.message : String(removeError)
                  }`
                );
              }
            ),
            new Promise((r) => {
              const t = setTimeout(r, CLEANUP_DEADLINE_MS);
              t.unref();
            }),
          ]);
          if (error) reject(error);
          else resolve(result);
        };

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.error(
            `[FREEZE-RUNNER] Run ${runIndex}/${runCount}: timed out after ${timeoutMs}ms`
          );
          runTreeKill(child, { force: false, rootExited });
          hardKillTimer = setTimeout(
            () => runTreeKill(child, { force: true, rootExited }),
            CHILD_KILL_GRACE_MS
          );
          // A tree we could not fully reach may keep the stdio pipes open, so
          // `close` never arrives. Settle anyway — the timeout is already the
          // verdict, and waiting past it is the hang we are defending against.
          giveUpTimer = setTimeout(
            () => void finish(null, { code: exitCode, signal: exitSignal, output, timedOut: true }),
            CHILD_KILL_GRACE_MS * 2
          );
        }, timeoutMs);
        timeoutTimer.unref();

        const capture = (chunk, stream) => {
          const text = chunk.toString();
          output += text;
          if (text.includes("[FREEZE-HARNESS]")) stream.write(text);
        };
        child.stdout?.on("data", (chunk) => capture(chunk, process.stdout));
        child.stderr?.on("data", (chunk) => capture(chunk, process.stderr));

        child.on("error", (error) => {
          if (rootExited || timedOut) {
            // Not a spawn failure — `error` also reports a kill we failed to
            // deliver. Settling on it here would report the wrong cause and
            // disarm the escalation that is still mid-flight.
            console.error(
              `[FREEZE-RUNNER] Teardown error: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            return;
          }
          void finish(error, null);
        });

        // `exit` is the root's verdict; `close` additionally waits for every
        // inherited stdio pipe to drain. Electron's descendants inherit those
        // pipes, so a single survivor means `close` never arrives — and a run
        // that PASSED and exited 0 would otherwise sit here until the timeout
        // and be reported as a failure. Take the verdict from `exit`, give the
        // pipes a bounded moment to drain for the sake of the log tail, then
        // settle regardless.
        child.on("exit", (code, signal) => {
          rootExited = true;
          exitCode = code;
          exitSignal = signal;
          if (settled) return;
          // Disarm the timeout: the root has reported, so the run is decided.
          // Without this a root that exits 0 with every PASS marker moments
          // before the deadline still settles `timedOut: true` and is reported
          // as a failure — the drain below outlives the timer that flips it.
          clearTimeout(timeoutTimer);
          const timedOutAtExit = timedOut;
          drainTimer = setTimeout(
            () => void finish(null, { code, signal, output, timedOut: timedOutAtExit }),
            OUTPUT_DRAIN_MS
          );
        });

        child.on("close", (code, signal) => {
          void finish(null, {
            code: code ?? exitCode,
            signal: signal ?? exitSignal,
            output,
            timedOut,
          });
        });
      })
      .catch(reject);
  });
}

async function main() {
  await assertBuildArtifacts();

  const runCount = parsePositiveInt(process.env.FREEZE_HARNESS_RUNS, 1, MAX_RUNS);
  const timeoutMs = parsePositiveInt(process.env.FREEZE_HARNESS_TIMEOUT_MS, 180_000);
  const results = [];

  for (let i = 1; i <= runCount; i++) {
    const result = await runHarnessOnce({ runIndex: i, runCount, timeoutMs });
    const parsed = extractResultLine(result.output);
    if (parsed) results.push(parsed);
    try {
      validateHarnessOutput(i, runCount, result);
    } catch (error) {
      // Only `[FREEZE-HARNESS]` lines are echoed live, so a child that died
      // before its first marker has said nothing at all on the console — the
      // reason is sitting unread in `output`. Dump it, once, on the way out.
      console.error(`[FREEZE-RUNNER] Captured output from run ${i}/${runCount}:`);
      console.error(
        boundedTail(result.output.trimEnd(), MAX_DUMP_CHARS) || "(child produced no output)"
      );
      throw error;
    }
    console.log(`[FREEZE-RUNNER] Run ${i}/${runCount}: PASS`);
  }

  if (results.length > 1) {
    const ratios = results.map((r) => r.freezeRatio);
    console.log(
      `[FREEZE-RUNNER] freezeRatio across ${results.length} runs: min=${Math.min(
        ...ratios
      )} max=${Math.max(...ratios)}`
    );
  }
  console.log(`[FREEZE-RUNNER] All ${runCount} run(s) passed`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then(() => exitAfterFlush(0))
    .catch((error) => {
      console.error(
        "[FREEZE-RUNNER] FAILED:",
        error instanceof Error ? error.message : String(error)
      );
      exitAfterFlush(1);
    });
}
