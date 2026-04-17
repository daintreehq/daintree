// Silence EPIPE errors on stdout/stderr. When the parent terminal is closed
// (e.g. user quits Terminal.app while Daintree runs), writes to the broken pipe
// throw an uncaught EPIPE that would crash the main process. These are harmless.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      throw err;
    });
  }
}

import nodeV8 from "node:v8";
import vm from "node:vm";
import { execFile } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import { existsSync } from "fs";
import os from "os";
import fixPath from "fix-path";
import Database from "better-sqlite3";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";

export let exposeGc: (() => void) | undefined;
try {
  nodeV8.setFlagsFromString("--expose_gc");
  exposeGc = vm.runInNewContext("gc") as () => void;
  (globalThis as Record<string, unknown>).__daintree_gc = exposeGc;
} catch {
  // GC exposure not available — non-critical
}

if (app.isPackaged) {
  fixPath();
}

// In development, use a separate userData directory so the dev instance
// doesn't conflict with the production app's single-instance lock or storage.
// Skip when --user-data-dir is explicitly set (e.g. E2E tests) so that
// each test run gets its own isolated data directory.
const hasExplicitUserDataDir = process.argv.some((a) => a.startsWith("--user-data-dir"));
if (!app.isPackaged && !hasExplicitUserDataDir) {
  // Keep dev data separate per variant so `BUILD_VARIANT=canopy npm run dev`
  // doesn't collide with the default Daintree dev instance.
  const devDirName = process.env.BUILD_VARIANT === "canopy" ? "canopy-app-dev" : "daintree-dev";
  app.setPath("userData", path.join(app.getPath("appData"), devDirName));
}

// TODO(0.9.0): Remove this temporary Canopy -> Daintree userData migration
// after the 0.8.x upgrade window closes.
//
// One-shot rebrand migration on first Daintree launch. The copy goes to a
// staging directory and is atomically promoted with a rename, so a crash mid-
// copy leaves us in a recoverable state instead of a half-populated userData.
// A `.rebrand-migrated` marker skips the flow on subsequent launches.
//
// Skipped when --user-data-dir is set (E2E tests) and for the canopy variant
// (it IS the Canopy user data — migrating would copy it into itself).
//
// Design notes:
//  - Chromium singleton locks, caches, and crashpad state must NOT be copied.
//    Inheriting SingletonLock that points at a live Canopy PID makes Daintree
//    fail to launch (it thinks it's a secondary instance and exits).
//    Crashpad state would re-report Canopy's crashes under Daintree's bundle
//    id. Caches regenerate, copying them is wasted I/O.
//  - Pre-rebrand 0.6.x Canopy used a named session partition `persist:canopy-app`;
//    Daintree uses `persist:daintree`. The Partitions subdir is renamed after
//    copy so Local Storage / IndexedDB / Cookies carry across.
//  - If Daintree has a `daintree.db` with real rows, we assume the user has
//    been running Daintree and skip the copy to avoid clobbering real state.
//    A schema-only DB (e.g. created by a pre-release Daintree launch that
//    never wrote any user data) does NOT count — issue #5156.
//  - Auto-heal: users already affected by the pre-fix bug have a marker
//    containing "skipped: daintree.db already present" plus an empty
//    daintree.db. If the legacy canopy.db still has real data, we delete
//    the stale marker and re-run the migration on next launch.

// Probe daintree.db (or canopy.db) for actual user data. Opens read-only
// so the file is never created as a side effect, fails fast on lock, and
// throws on any SQLite error so the caller can decide the safe default.
function countProjectRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, timeout: 0 });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  } finally {
    // Always close — leaving the connection open holds WAL/SHM sidecar
    // descriptors that conflict with the persistence service opening the
    // same file moments later during normal startup.
    db.close();
  }
}

// Detect Chromium-side Daintree state — Preferences, Local Storage, and the
// `persist:daintree` partition are all written by previous Daintree launches
// even when the user never opened a project. Used as a second signal so the
// row-count probe alone never wipes out customized state (themes, layouts,
// auth tokens stored in localStorage). Marker file is intentionally ignored
// here so the auto-heal pre-check can still delete a stale skip marker.
function hasDaintreeUsageMarkers(newUserData: string): boolean {
  return (
    fs.existsSync(path.join(newUserData, "Preferences")) ||
    fs.existsSync(path.join(newUserData, "Local Storage")) ||
    fs.existsSync(path.join(newUserData, "Partitions", "daintree"))
  );
}

if (!hasExplicitUserDataDir && process.env.BUILD_VARIANT !== "canopy") {
  try {
    const newUserData = app.getPath("userData");
    const markerPath = path.join(newUserData, ".rebrand-migrated");
    const appData = app.getPath("appData");
    const legacyName = app.isPackaged ? "Canopy" : "canopy-app-dev";
    const legacyUserData = path.join(appData, legacyName);
    const daintreeDbPath = path.join(newUserData, "daintree.db");
    const legacyDbPath = path.join(legacyUserData, "canopy.db");

    // Auto-heal pre-check: a marker written by the buggy pre-fix code path
    // has the literal "skipped: daintree.db already present" text and may be
    // sitting next to a schema-only daintree.db while real data still lives
    // in the legacy Canopy directory. Delete the marker so the normal
    // migration flow below re-runs.
    if (fs.existsSync(markerPath)) {
      try {
        const markerContent = fs.readFileSync(markerPath, "utf-8").trim();
        if (markerContent.includes("skipped: daintree.db already present")) {
          // Fail-safe defaults: Infinity for daintree (treat probe failure as
          // "has data" — never overwrite an unreadable user DB), 0 for canopy
          // (treat probe failure as "no legacy data" — don't migrate empty).
          let daintreeRows = Number.POSITIVE_INFINITY;
          let canopyRows = 0;
          try {
            daintreeRows = countProjectRows(daintreeDbPath);
          } catch {
            // probe failed — leave daintreeRows = Infinity (no auto-heal)
          }
          try {
            canopyRows = countProjectRows(legacyDbPath);
          } catch {
            // probe failed — leave canopyRows = 0 (no auto-heal)
          }
          // Extra guard: never auto-heal when Chromium-side Daintree state
          // exists. A user who launched pre-release Daintree, customized
          // prefs/themes, but never opened a project would have the same
          // (zero-row daintree.db, populated canopy.db) shape — wiping
          // their state to re-run the migration is exactly the bug we are
          // fixing in the other direction.
          if (daintreeRows === 0 && canopyRows > 0 && !hasDaintreeUsageMarkers(newUserData)) {
            fs.rmSync(markerPath);
            console.log(
              "[daintree] Auto-healing rebrand migration — stale skip marker found alongside empty daintree.db; re-running migration"
            );
          }
        }
      } catch (err) {
        // Reading or inspecting the marker failed — leave it in place.
        // Conservative: better to skip migration than to delete a marker
        // we can't reason about.
        console.warn("[daintree] Auto-heal pre-check failed:", err);
      }
    }

    if (!fs.existsSync(markerPath)) {
      // Replace the old `fs.existsSync(daintreeDbPath)` guard with a row
      // count: a schema-only DB has zero rows in `projects` and is safe to
      // overwrite. Any probe error is treated as "has data" (fail-safe).
      let daintreeHasRows = false;
      if (fs.existsSync(daintreeDbPath)) {
        try {
          daintreeHasRows = countProjectRows(daintreeDbPath) > 0;
        } catch {
          daintreeHasRows = true;
        }
      }
      // Either real project rows OR Chromium-side state means Daintree has
      // been used — block the migration in both cases. The usage-marker
      // check protects pre-release users who customized prefs/themes but
      // never opened a project from having their state wiped.
      const daintreeAlreadyUsed = daintreeHasRows || hasDaintreeUsageMarkers(newUserData);

      if (daintreeAlreadyUsed) {
        // Daintree has already been used — never overwrite real user state.
        // Drop the marker so we don't re-check on every launch. Atomic
        // write so a crash mid-write doesn't leave a half-formed marker
        // that the auto-heal pre-check would misread on the next launch.
        resilientAtomicWriteFileSync(
          markerPath,
          new Date().toISOString() + "\nskipped: daintree.db already present\n"
        );
        console.log("[daintree] Skipping userData migration — existing daintree.db found");
      } else if (fs.existsSync(legacyUserData)) {
        // Files/dirs produced by Chromium/Electron that must NOT be copied:
        // singleton locks, caches, crashpad state. See
        // https://www.electronjs.org/docs/latest/api/app#appgetpathname .
        const EXCLUDE = new Set([
          "SingletonLock",
          "SingletonCookie",
          "SingletonSocket",
          "lockfile",
          "GPUCache",
          "ShaderCache",
          "GrShaderCache",
          "DawnCache",
          "DawnGraphiteCache",
          "DawnWebGPUCache",
          "Code Cache",
          "Cache",
          "Crashpad",
          "Crash Reports",
          "Network",
          "blob_storage",
          "Service Worker",
        ]);
        const stagingPath = newUserData + ".migrating";
        if (fs.existsSync(stagingPath)) {
          fs.rmSync(stagingPath, { recursive: true, force: true });
        }
        fs.cpSync(legacyUserData, stagingPath, {
          recursive: true,
          filter: (src) => !EXCLUDE.has(path.basename(src)),
        });
        // Rename the SQLite database + WAL/SHM/backup artefacts in staging.
        for (const suffix of ["", "-wal", "-shm", ".backup"]) {
          const oldDb = path.join(stagingPath, "canopy.db" + suffix);
          const newDb = path.join(stagingPath, "daintree.db" + suffix);
          if (fs.existsSync(oldDb) && !fs.existsSync(newDb)) {
            fs.renameSync(oldDb, newDb);
          }
        }
        // Pre-rebrand Canopy used `persist:canopy-app` session partition;
        // rename the directory so Chromium finds carried-over storage under
        // the new `persist:daintree` partition name.
        const oldPartition = path.join(stagingPath, "Partitions", "canopy-app");
        const newPartition = path.join(stagingPath, "Partitions", "daintree");
        if (fs.existsSync(oldPartition) && !fs.existsSync(newPartition)) {
          fs.renameSync(oldPartition, newPartition);
        }
        // Atomic promotion: remove the bare newUserData (only if it's empty
        // of user data — we've already guarded on daintree.db above) and
        // rename staging into place.
        if (fs.existsSync(newUserData)) {
          fs.rmSync(newUserData, { recursive: true, force: true });
        }
        fs.renameSync(stagingPath, newUserData);
        // Atomic write: if a crash happens between the rename above and a
        // partial marker write, next launch would see no marker and could
        // re-run the migration over already-migrated data.
        resilientAtomicWriteFileSync(markerPath, new Date().toISOString());
        console.log(`[daintree] Migrated userData ${legacyUserData} -> ${newUserData}`);
      } else if (fs.existsSync(newUserData)) {
        // No legacy dir but new dir already exists (fresh install or already
        // migrated on a prior version) — drop the marker so we don't re-check.
        resilientAtomicWriteFileSync(markerPath, new Date().toISOString());
      }
    }
  } catch (err) {
    // The marker is intentionally NOT written here. A clean retry on the next
    // launch is safe because the existing-data guard at the top of this block
    // protects any user state accumulated between a failed migration and the
    // next launch.
    console.warn("[daintree] userData migration failed:", err);
  }
}

// GPU crash fallback: disable hardware acceleration before app.whenReady()
// This flag is written by GpuCrashMonitorService after repeated GPU crashes.
const gpuFlagPath = path.join(app.getPath("userData"), "gpu-disabled.flag");
export const gpuHardwareAccelerationDisabled = fs.existsSync(gpuFlagPath);
if (gpuHardwareAccelerationDisabled) {
  app.disableHardwareAcceleration();
  console.log("[GPU] Hardware acceleration disabled by crash fallback flag");
}

// Handle --reset-data: wipe userData before Chromium acquires file locks
const shouldResetData =
  process.argv.includes("--reset-data") || process.env.DAINTREE_RESET_DATA === "1";
if (shouldResetData) {
  const userDataPath = app.getPath("userData");
  if (fs.existsSync(userDataPath)) {
    for (const entry of fs.readdirSync(userDataPath)) {
      try {
        fs.rmSync(path.join(userDataPath, entry), { recursive: true, force: true });
      } catch {
        // Skip locked files
      }
    }
  }
}

// Chromium feature flags: memory reclamation + platform-specific features
const enabledFeatures = ["PartitionAllocMemoryReclaimer"];

// Enable native Wayland support on Linux (Electron < 38)
// Electron 38+ auto-detects via XDG_SESSION_TYPE; this flag is ignored.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  if (process.env.XDG_SESSION_TYPE === "wayland") {
    enabledFeatures.push("WaylandWindowDecorations");
    app.commandLine.appendSwitch("enable-wayland-ime");
  }
}

app.commandLine.appendSwitch("enable-features", enabledFeatures.join(","));

// Raise GPU tile memory budget to keep Retina/multi-panel rendering from exhausting Chromium's default cap
app.commandLine.appendSwitch("force-gpu-mem-available-mb", "1024");

if (process.platform === "win32") {
  const extraPaths = getWindowsExtraPaths();
  const current = process.env.PATH || "";
  const existingEntries = current.split(path.delimiter).map((e) => e.toLowerCase());
  const missing = extraPaths.filter(
    (p) => !existingEntries.includes(p.toLowerCase()) && existsSync(p)
  );
  if (missing.length) {
    process.env.PATH = [...missing, current].join(path.delimiter);
  }
}

const REFRESH_TIMEOUT_MS = 5_000;

function deduplicatePath(pathStr: string, caseInsensitive: boolean): string {
  const entries = pathStr.split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of entries) {
    const key = caseInsensitive ? entry.toLowerCase() : entry;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(entry);
    }
  }
  return unique.join(path.delimiter);
}

function expandWindowsEnvVars(str: string): string {
  return str.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
}

function getWindowsExtraPaths(): string[] {
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const chocoInstall = process.env["ChocolateyInstall"] || "C:\\ProgramData\\chocolatey";
  const home = os.homedir();

  const paths = [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "Programs", "Git", "cmd"),
    path.join(programFiles, "Git", "cmd"),
    path.join(programFilesX86, "Git", "cmd"),
    path.join(home, "scoop", "shims"),
    path.join(chocoInstall, "bin"),
  ];

  // Volta: env var first, hardcoded fallback
  if (process.env["VOLTA_HOME"]) {
    paths.push(path.join(process.env["VOLTA_HOME"], "bin"));
  } else {
    paths.push(path.join(home, "AppData", "Local", "Volta", "bin"));
  }

  // pnpm: env var only
  if (process.env["PNPM_HOME"]) {
    paths.push(process.env["PNPM_HOME"]);
  }

  // fnm: env var only (dynamic per session)
  if (process.env["FNM_MULTISHELL_PATH"]) {
    paths.push(process.env["FNM_MULTISHELL_PATH"]);
  }

  // nvm-windows: env var only
  if (process.env["NVM_SYMLINK"]) {
    paths.push(process.env["NVM_SYMLINK"]);
  }

  return paths;
}

function readWindowsRegistryPath(): Promise<string> {
  const keys = [
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "HKCU\\Environment",
  ];

  return Promise.all(
    keys.map(
      (key) =>
        new Promise<string>((resolve) => {
          execFile("reg", ["query", key, "/v", "Path"], { timeout: 3_000 }, (err, stdout) => {
            if (err || !stdout) return resolve("");
            const match = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
            resolve(expandWindowsEnvVars(match?.[1]?.trim() ?? ""));
          });
        })
    )
  ).then((paths) => paths.filter(Boolean).join(path.delimiter));
}

function applyWindowsExtraPaths(currentPath: string): string {
  const extraPaths = getWindowsExtraPaths();
  const existingEntries = currentPath.split(path.delimiter).map((e) => e.toLowerCase());
  const missing = extraPaths.filter(
    (p) => !existingEntries.includes(p.toLowerCase()) && existsSync(p)
  );

  return missing.length ? [...missing, currentPath].join(path.delimiter) : currentPath;
}

export async function refreshPath(): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        if (process.platform === "win32") {
          const registryPath = await readWindowsRegistryPath();
          if (!registryPath) return;
          const withExtras = applyWindowsExtraPaths(registryPath);
          process.env.PATH = deduplicatePath(withExtras, true);
        } else {
          const { shellEnv } = (await import("shell-env")) as {
            shellEnv: () => Promise<Record<string, string>>;
          };
          const env = await shellEnv();
          if (env.PATH) {
            process.env.PATH = deduplicatePath(env.PATH, false);
          }
        }
      })(),
      new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), REFRESH_TIMEOUT_MS);
      }),
    ]);

    if (result === "timeout") {
      console.warn("[refreshPath] Timed out after", REFRESH_TIMEOUT_MS, "ms — using existing PATH");
    }
  } catch {
    // Fallback to current PATH silently
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export const isDemoMode = !app.isPackaged && process.argv.includes("--demo-mode");
export const isSmokeTest = process.argv.includes("--smoke-test");
export const smokeTestStart = isSmokeTest ? Date.now() : 0;

if (isSmokeTest) {
  console.error("[SMOKE] Smoke test mode enabled");
  console.error("[SMOKE] Platform:", process.platform, process.arch);
  console.error("[SMOKE] Electron:", process.versions.electron);
  console.error("[SMOKE] Node:", process.versions.node);
  console.error("[SMOKE] Chrome:", process.versions.chrome);

  // Fail fast on renderer or child process crashes
  app.on("render-process-gone", (_event, _wc, details) => {
    if (details.reason !== "clean-exit") {
      console.error(
        `[SMOKE] FAILED — renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`
      );
      app.exit(1);
    }
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") {
      console.error(
        `[SMOKE] FAILED — child process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`
      );
      if (details.type === "GPU" || details.type === "Utility") {
        app.exit(1);
      }
    }
  });

  // Verify native module (node-pty) loads and bindings work
  try {
    const pty = await import("node-pty");
    const testProc = pty.spawn(process.platform === "win32" ? "cmd.exe" : "echo", ["smoke"], {
      cols: 80,
      rows: 24,
    });
    testProc.kill();
    console.error("[SMOKE] CHECK: node-pty native module — OK");
  } catch (err) {
    console.error("[SMOKE] FAILED — node-pty native module:", (err as Error).message);
    app.exit(1);
  }

  // Verify better-sqlite3 loads and can execute queries
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    const row = db.prepare("SELECT 1 AS n").get() as { n: number };
    db.close();
    if (row?.n !== 1) throw new Error("unexpected query result");
    console.error("[SMOKE] CHECK: better-sqlite3 native module — OK");
  } catch (err) {
    console.error("[SMOKE] FAILED — better-sqlite3 native module:", (err as Error).message);
    app.exit(1);
  }
}

app.enableSandbox();

// Prevent macOS keychain prompt ("Daintree Safe Storage").
// Chromium encrypts cookies/network state via the OS keychain by default.
// We don't rely on Chromium cookie encryption — all secrets are in electron-store.
app.commandLine.appendSwitch("use-mock-keychain");
