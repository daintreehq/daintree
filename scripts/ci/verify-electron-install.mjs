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

const REPAIR_ATTEMPTS = 3;

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

    await sleep(2 ** (attempt - 1) * 1_000);
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
