/**
 * Electron stability soak — NOT the Playwright e2e smoke suite.
 *
 * This script launches the built Electron app in --smoke-test mode and
 * validates stability markers (node-pty, renderer load, IPC bridge, terminal
 * stress, project persistence). It runs in CI on every push and pull request
 * (Linux, xvfb) via `npm run test:smoke` in `.github/workflows/ci.yml`.
 *
 * The Playwright release-gate smoke suite lives in `e2e/core/` and runs via
 * `npm run test:e2e:core`. See `docs/e2e-testing.md` for the distinction
 * and the smoke audit cadence.
 */

import { spawn } from "child_process";
import { constants as fsConstants } from "fs";
import { access, mkdtemp, rm } from "fs/promises";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");

const BUILD_ARTIFACTS = [
  "dist/index.html",
  "dist-electron/electron/bootstrap.js",
  "dist-electron/electron/main.js",
];

const REQUIRED_MARKERS = [
  "[SMOKE] CHECK: node-pty native module",
  "[SMOKE] CHECK: better-sqlite3 native module",
  "[SMOKE] CHECK: Renderer did-finish-load",
  "[SMOKE] CHECK: Renderer + IPC bridge",
  "[SMOKE] CHECK: Terminal stress rounds",
  "[SMOKE] CHECK: Project persistence stress",
  "[SMOKE] Stability soak complete",
];
const FATAL_OUTPUT_MARKERS = ["[SMOKE] FAILED", "Bootstrap failed:"];

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function runElectronSmokeOnce({ runIndex, runCount, timeoutMs, extraArgs }) {
  return new Promise((resolve, reject) => {
    mkdtemp(path.join(os.tmpdir(), "daintree-smoke-"))
      .then((userDataDir) => {
        const args = [
          ".",
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

        console.log(
          `[SMOKE-RUNNER] Run ${runIndex}/${runCount}: launching Electron (${path.basename(
            electronPath
          )})`
        );

        const env = {
          ...process.env,
          NODE_ENV: "production",
        };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.ATOM_SHELL_INTERNAL_RUN_AS_NODE;

        const child = spawn(electronPath, args, {
          cwd: ROOT,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let output = "";
        let hardKillTimer;

        const cleanup = async () => {
          clearTimeout(timeoutTimer);
          if (hardKillTimer) clearTimeout(hardKillTimer);
          await rm(userDataDir, { recursive: true, force: true });
        };

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.error(
            `[SMOKE-RUNNER] Run ${runIndex}/${runCount}: timed out after ${timeoutMs}ms`
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

function validateSmokeOutput(runIndex, runCount, result) {
  const { code, signal, output, timedOut } = result;
  if (timedOut) {
    throw new Error(`Smoke run ${runIndex}/${runCount} timed out`);
  }
  if (code !== 0) {
    throw new Error(
      `Smoke run ${runIndex}/${runCount} failed with code ${code} (signal ${signal})`
    );
  }
  const fatalMarker = FATAL_OUTPUT_MARKERS.find((marker) => output.includes(marker));
  if (fatalMarker) {
    throw new Error(`Smoke run ${runIndex}/${runCount} reported fatal output: ${fatalMarker}`);
  }
  for (const marker of REQUIRED_MARKERS) {
    if (!output.includes(marker)) {
      throw new Error(`Smoke run ${runIndex}/${runCount} missing expected marker: ${marker}`);
    }
  }
}

async function main() {
  await assertBuildArtifacts();

  const isWindowsCI = process.platform === "win32" && Boolean(process.env.CI);
  const defaultRuns = isWindowsCI ? 3 : 1;
  const defaultRetries = isWindowsCI ? 1 : 0;
  const runCount = parsePositiveInt(process.env.SMOKE_RUNS, defaultRuns);
  const retries = Number.parseInt(process.env.SMOKE_RETRIES ?? "", 10);
  const retriesPerRun = Number.isFinite(retries) && retries >= 0 ? retries : defaultRetries;
  const timeoutMs = parsePositiveInt(process.env.SMOKE_TIMEOUT_MS, 210_000);
  const extraArgs = (process.env.SMOKE_EXTRA_ARGS ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (let i = 1; i <= runCount; i++) {
    const maxAttempts = retriesPerRun + 1;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await runElectronSmokeOnce({
          runIndex: i,
          runCount,
          timeoutMs,
          extraArgs,
        });
        validateSmokeOutput(i, runCount, result);
        if (attempt > 1) {
          console.log(
            `[SMOKE-RUNNER] Run ${i}/${runCount}: PASS (on attempt ${attempt}/${maxAttempts})`
          );
        } else {
          console.log(`[SMOKE-RUNNER] Run ${i}/${runCount}: PASS`);
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          console.warn(
            `[SMOKE-RUNNER] Run ${i}/${runCount}: attempt ${attempt}/${maxAttempts} failed — retrying. Cause: ${message}`
          );
        } else {
          console.error(
            `[SMOKE-RUNNER] Run ${i}/${runCount}: exhausted ${maxAttempts} attempt(s). Last cause: ${message}`
          );
        }
      }
    }
    if (lastError) {
      throw lastError;
    }
  }

  console.log(
    `[SMOKE-RUNNER] All ${runCount} smoke run(s) passed (up to ${retriesPerRun} retry/retries per run)`
  );
}

main().catch((error) => {
  console.error("[SMOKE-RUNNER] FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
