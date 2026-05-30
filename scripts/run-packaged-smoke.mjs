/**
 * Packaged-artifact smoke runner — gates per-OS release publish (#9246).
 *
 * Launches the already-installed/extracted Daintree binary in --smoke-test
 * mode and validates that the same stability markers emitted by
 * electron/setup/environment.ts and electron/services/smokeTest.ts are
 * present. Unlike scripts/run-smoke.mjs (which uses require('electron') to
 * launch the dev binary against the build output in dist/), this runner
 * takes the path to the actually-shipped binary via the PACKAGED_BINARY env
 * var so it exercises the asar payload, asar.unpacked native modules, and
 * codesigning that real users see.
 *
 * Expected markers cover the shipped native surfaces: node-pty,
 * better-sqlite3, win-job-object (Windows only), and the posix-pty-reaper
 * supervisor executable (macOS / Linux only).
 */

import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import url from "url";

const BASE_REQUIRED_MARKERS = [
  "[SMOKE] CHECK: node-pty native module",
  "[SMOKE] CHECK: better-sqlite3 native module",
  "[SMOKE] CHECK: Renderer did-finish-load",
  "[SMOKE] CHECK: Renderer + IPC bridge",
  "[SMOKE] CHECK: Terminal stress rounds",
  "[SMOKE] CHECK: Project persistence stress",
  "[SMOKE] Stability soak complete",
];

export function buildRequiredMarkers(platform) {
  const markers = [...BASE_REQUIRED_MARKERS];
  if (platform === "win32") {
    markers.push("[SMOKE] CHECK: win-job-object native module");
  } else if (platform === "darwin" || platform === "linux") {
    markers.push("[SMOKE] CHECK: posix-pty-reaper supervisor");
  }
  return markers;
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildPackagedSmokeEnv(
  binaryPath,
  baseEnv = process.env,
  platform = process.platform
) {
  const env = {
    ...baseEnv,
    NODE_ENV: "production",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ATOM_SHELL_INTERNAL_RUN_AS_NODE;

  if (platform === "linux" && path.basename(binaryPath) === "AppRun" && !env.APPDIR) {
    env.APPDIR = path.dirname(binaryPath);
  }

  return env;
}

function runPackagedSmokeOnce({ binaryPath, runIndex, runCount, timeoutMs, extraArgs }) {
  return new Promise((resolve, reject) => {
    mkdtemp(path.join(os.tmpdir(), "daintree-packaged-smoke-"))
      .then((userDataDir) => {
        const args = [
          "--smoke-test",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--noerrdialogs",
          `--user-data-dir=${userDataDir}`,
          ...extraArgs,
        ];
        if (process.platform === "linux") {
          args.push("--no-sandbox");
        }

        console.log(`[PACKAGED-SMOKE] Run ${runIndex}/${runCount}: launching ${binaryPath}`);

        const child = spawn(binaryPath, args, {
          env: buildPackagedSmokeEnv(binaryPath),
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let output = "";
        let hardKillTimer;

        const cleanup = async () => {
          clearTimeout(timeoutTimer);
          if (hardKillTimer) clearTimeout(hardKillTimer);
          // Swallow rm failures (Windows file locks held by a slow-exit
          // child are the common case). Letting cleanup() throw would
          // leave the outer Promise unresolved and hang the job until the
          // workflow-level timeout fires — the temp dir is in $TMPDIR
          // and the runner is ephemeral, so a stale dir is harmless.
          try {
            await rm(userDataDir, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn(
              `[PACKAGED-SMOKE] Cleanup: failed to remove ${userDataDir}: ${
                rmErr instanceof Error ? rmErr.message : String(rmErr)
              }`
            );
          }
        };

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.error(
            `[PACKAGED-SMOKE] Run ${runIndex}/${runCount}: timed out after ${timeoutMs}ms`
          );
          child.kill();
          hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        }, timeoutMs);
        timeoutTimer.unref();

        child.stdout?.on("data", (chunk) => {
          const text = chunk.toString();
          output += text;
          process.stdout.write(text);
        });

        child.stderr?.on("data", (chunk) => {
          const text = chunk.toString();
          output += text;
          process.stderr.write(text);
        });

        child.on("error", async (error) => {
          await cleanup();
          reject(error);
        });

        child.on("close", async (code, signal) => {
          await cleanup();
          resolve({ code, signal, output, timedOut });
        });
      })
      .catch(reject);
  });
}

export function validateSmokeOutput(runIndex, runCount, result, requiredMarkers) {
  const { code, signal, output, timedOut } = result;
  if (timedOut) {
    throw new Error(`Packaged smoke run ${runIndex}/${runCount} timed out`);
  }
  if (code !== 0) {
    throw new Error(
      `Packaged smoke run ${runIndex}/${runCount} failed with code ${code} (signal ${signal})`
    );
  }
  if (output.includes("[SMOKE] FAILED")) {
    throw new Error(`Packaged smoke run ${runIndex}/${runCount} reported a smoke failure`);
  }
  for (const marker of requiredMarkers) {
    if (!output.includes(marker)) {
      throw new Error(
        `Packaged smoke run ${runIndex}/${runCount} missing expected marker: ${marker}`
      );
    }
  }
}

async function main() {
  const binaryPath = process.env.PACKAGED_BINARY?.trim();
  if (!binaryPath) {
    throw new Error("PACKAGED_BINARY env var is required");
  }
  // We deliberately do NOT fs.statSync here — on the CI Linux runner the
  // AppRun entry point is a symlink/launcher resolved by AppImage tooling,
  // and the spawn() failure path already produces a clear error if the
  // path is wrong. Validating presence inline would force per-platform
  // resolve logic into this script that's better expressed in the
  // workflow's discovery step.

  const runCount = parsePositiveInt(process.env.SMOKE_RUNS, 1);
  const retries = Number.parseInt(process.env.SMOKE_RETRIES ?? "", 10);
  const retriesPerRun = Number.isFinite(retries) && retries >= 0 ? retries : 0;
  const timeoutMs = parsePositiveInt(process.env.SMOKE_TIMEOUT_MS, 240_000);
  const extraArgs = (process.env.SMOKE_EXTRA_ARGS ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const requiredMarkers = buildRequiredMarkers(process.platform);

  for (let i = 1; i <= runCount; i++) {
    const maxAttempts = retriesPerRun + 1;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await runPackagedSmokeOnce({
          binaryPath,
          runIndex: i,
          runCount,
          timeoutMs,
          extraArgs,
        });
        validateSmokeOutput(i, runCount, result, requiredMarkers);
        if (attempt > 1) {
          console.log(
            `[PACKAGED-SMOKE] Run ${i}/${runCount}: PASS (on attempt ${attempt}/${maxAttempts})`
          );
        } else {
          console.log(`[PACKAGED-SMOKE] Run ${i}/${runCount}: PASS`);
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          console.warn(
            `[PACKAGED-SMOKE] Run ${i}/${runCount}: attempt ${attempt}/${maxAttempts} failed — retrying. Cause: ${message}`
          );
        } else {
          console.error(
            `[PACKAGED-SMOKE] Run ${i}/${runCount}: exhausted ${maxAttempts} attempt(s). Last cause: ${message}`
          );
        }
      }
    }
    if (lastError) {
      throw lastError;
    }
  }

  console.log(
    `[PACKAGED-SMOKE] All ${runCount} packaged smoke run(s) passed (up to ${retriesPerRun} retry/retries per run)`
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(
      "[PACKAGED-SMOKE] FAILED:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  });
}
