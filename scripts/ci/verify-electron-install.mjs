import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);

function resolveElectronPackageRoot() {
  return dirname(require.resolve("electron/package.json"));
}

function resolveElectronPath() {
  const electronPath = require("electron");
  if (typeof electronPath !== "string" || electronPath.length === 0) {
    throw new Error("electron package did not return an executable path");
  }
  if (!existsSync(electronPath)) {
    throw new Error(`electron executable is missing: ${electronPath}`);
  }
  return electronPath;
}

const REPAIR_ATTEMPTS = 5;

// GitHub's release CDN serves transient 500s for the Electron zip — one took
// out a v0.29.0 Windows release job. The previous 1s/2s backoff spent all three
// attempts inside four seconds, far too fast to ride a blip out. These delays
// cover ~110s of outage while staying well inside the job budget.
const REPAIR_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];

async function repairElectronInstall(packageRoot) {
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt += 1) {
    rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
    rmSync(join(packageRoot, "path.txt"), { force: true });

    console.log(`[verify-electron-install] Repair attempt ${attempt}/${REPAIR_ATTEMPTS}`);
    const result = spawnSync(process.execPath, [join(packageRoot, "install.js")], {
      stdio: "inherit",
      env: process.env,
    });

    if (result.status === 0) {
      return;
    }

    if (attempt === REPAIR_ATTEMPTS) {
      throw new Error(`electron install.js exited with code ${result.status ?? "null"}`);
    }

    const backoffMs = REPAIR_BACKOFF_MS[attempt - 1] ?? REPAIR_BACKOFF_MS.at(-1);
    console.log(`[verify-electron-install] Retrying in ${backoffMs / 1_000}s`);
    await sleep(backoffMs);
  }
}

const packageRoot = resolveElectronPackageRoot();

try {
  const electronPath = resolveElectronPath();
  console.log(`[verify-electron-install] Electron OK: ${electronPath}`);
} catch (error) {
  console.warn(
    `[verify-electron-install] Electron install is incomplete; repairing: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  await repairElectronInstall(packageRoot);
  const electronPath = resolveElectronPath();
  console.log(`[verify-electron-install] Electron repaired: ${electronPath}`);
}
