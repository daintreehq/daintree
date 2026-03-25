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
  "[SMOKE] CHECK: Renderer did-finish-load",
  "[SMOKE] CHECK: Renderer + IPC bridge",
  "[SMOKE] CHECK: Terminal stress rounds",
  "[SMOKE] CHECK: Project persistence stress",
  "[SMOKE] Stability soak complete",
];

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
    mkdtemp(path.join(os.tmpdir(), "canopy-smoke-"))
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
  if (output.includes("[SMOKE] FAILED")) {
    throw new Error(`Smoke run ${runIndex}/${runCount} reported a smoke failure`);
  }
  for (const marker of REQUIRED_MARKERS) {
    if (!output.includes(marker)) {
      throw new Error(`Smoke run ${runIndex}/${runCount} missing expected marker: ${marker}`);
    }
  }
}

async function main() {
  await assertBuildArtifacts();

  const defaultRuns = process.platform === "win32" && process.env.CI ? 3 : 1;
  const runCount = parsePositiveInt(process.env.SMOKE_RUNS, defaultRuns);
  const timeoutMs = parsePositiveInt(process.env.SMOKE_TIMEOUT_MS, 210_000);
  const extraArgs = (process.env.SMOKE_EXTRA_ARGS ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (let i = 1; i <= runCount; i++) {
    const result = await runElectronSmokeOnce({
      runIndex: i,
      runCount,
      timeoutMs,
      extraArgs,
    });
    validateSmokeOutput(i, runCount, result);
    console.log(`[SMOKE-RUNNER] Run ${i}/${runCount}: PASS`);
  }

  console.log(`[SMOKE-RUNNER] All ${runCount} smoke run(s) passed`);
}

main().catch((error) => {
  console.error("[SMOKE-RUNNER] FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
