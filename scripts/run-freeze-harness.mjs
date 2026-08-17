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

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
            `[FREEZE-RUNNER] Run ${runIndex}/${runCount}: timed out after ${timeoutMs}ms`
          );
          child.kill();
          hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        }, timeoutMs);
        timeoutTimer.unref();

        const capture = (chunk, stream) => {
          const text = chunk.toString();
          output += text;
          if (text.includes("[FREEZE-HARNESS]")) stream.write(text);
        };
        child.stdout?.on("data", (chunk) => capture(chunk, process.stdout));
        child.stderr?.on("data", (chunk) => capture(chunk, process.stderr));

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

async function main() {
  await assertBuildArtifacts();

  const runCount = parsePositiveInt(process.env.FREEZE_HARNESS_RUNS, 1);
  const timeoutMs = parsePositiveInt(process.env.FREEZE_HARNESS_TIMEOUT_MS, 180_000);
  const results = [];

  for (let i = 1; i <= runCount; i++) {
    const result = await runHarnessOnce({ runIndex: i, runCount, timeoutMs });
    const parsed = extractResultLine(result.output);
    if (parsed) results.push(parsed);
    validateHarnessOutput(i, runCount, result);
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
  main().catch((error) => {
    console.error(
      "[FREEZE-RUNNER] FAILED:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  });
}
