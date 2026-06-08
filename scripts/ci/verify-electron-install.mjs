import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

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

function repairElectronInstall(packageRoot) {
  rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
  rmSync(join(packageRoot, "path.txt"), { force: true });

  const result = spawnSync(process.execPath, [join(packageRoot, "install.js")], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`electron install.js exited with code ${result.status ?? "null"}`);
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
  repairElectronInstall(packageRoot);
  const electronPath = resolveElectronPath();
  console.log(`[verify-electron-install] Electron repaired: ${electronPath}`);
}
