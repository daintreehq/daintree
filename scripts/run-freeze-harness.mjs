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

import { spawn } from "child_process";
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
/** Backstop for a pipe whose write callback never fires. See `exitAfterFlush`. */
const FLUSH_TIMEOUT_MS = 5_000;

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    // `/t` walks the tree as it stands right now, so anything already orphaned
    // by the root's own exit is out of reach — which is why the caller escalates
    // rather than trusting one call.
    return {
      kind: "taskkill",
      command: "taskkill",
      args: ["/pid", String(pid), "/t", "/f"],
    };
  }
  // Valid only because the child is spawned `detached` on POSIX, which makes it
  // a process-group leader with pgid === pid. Never negate a pid that was not.
  return { kind: "group-signal", pid: -pid, signal: force ? "SIGKILL" : "SIGTERM" };
}

/** Whether the child should lead its own process group. Windows has no groups. */
export function shouldDetach(platform) {
  return platform !== "win32";
}

function runTreeKill(child, { force }) {
  const action = describeTreeKill(process.platform, child.pid, { force });
  if (action.kind === "none") return;
  if (action.kind === "taskkill") {
    spawn(action.command, action.args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
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
        let settled = false;

        // One settlement path. `error` and `close` can both fire (a spawn
        // failure emits `error`, and a failed spawn may never emit `close` at
        // all), and cleanup must never be what decides whether this promise
        // settles — see `finish` below.
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          if (hardKillTimer) clearTimeout(hardKillTimer);
          if (giveUpTimer) clearTimeout(giveUpTimer);
          // Fire-and-forget, and non-throwing: on Windows the app can still hold
          // a handle under the user-data dir, and an rm rejection inside an async
          // listener would leave this promise pending forever — the runner would
          // hang on a run that had already produced its verdict.
          rm(userDataDir, { recursive: true, force: true }).catch((removeError) => {
            console.error(
              `[FREEZE-RUNNER] Could not remove ${userDataDir}: ${
                removeError instanceof Error ? removeError.message : String(removeError)
              }`
            );
          });
          if (error) reject(error);
          else resolve(result);
        };

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.error(
            `[FREEZE-RUNNER] Run ${runIndex}/${runCount}: timed out after ${timeoutMs}ms`
          );
          runTreeKill(child, { force: false });
          hardKillTimer = setTimeout(() => runTreeKill(child, { force: true }), CHILD_KILL_GRACE_MS);
          // A tree we could not fully reach may keep the stdio pipes open, so
          // `close` never arrives. Settle anyway — the timeout is already the
          // verdict, and waiting past it is the hang we are defending against.
          giveUpTimer = setTimeout(
            () => finish(null, { code: null, signal: "SIGKILL", output, timedOut: true }),
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

        child.on("error", (error) => finish(error, null));
        child.on("close", (code, signal) => finish(null, { code, signal, output, timedOut }));
      })
      .catch(reject);
  });
}

async function main() {
  await assertBuildArtifacts();

  const runCount = parsePositiveInt(process.env.FREEZE_HARNESS_RUNS, 1);
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
      console.error(result.output.trimEnd() || "(child produced no output)");
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
