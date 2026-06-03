#!/usr/bin/env node
// Installs a locally-built Daintree.app into /Applications, replacing any
// existing copy, then relaunches it. Used for dogfooding the dev build as the
// daily driver.
//
//   npm run install:local              install the most recent release/ build
//   npm run package:local -- --install build then install in one shot
//
// Same bundle ID as production (org.daintree.app), so this overwrites whatever
// Daintree is installed and shares its user data — that's the point: the dev
// build becomes the one Daintree on this machine.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "Daintree.app";
const INSTALL_PATH = `/Applications/${APP_NAME}`;
// Matches the running main process regardless of where it was launched from.
const PROC_MATCH = "Daintree.app/Contents/MacOS/Daintree";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRunning = () => spawnSync("pgrep", ["-f", PROC_MATCH], { stdio: "ignore" }).status === 0;

// Locate the freshly built .app. electron-builder emits to release/mac-arm64
// (or mac/mac-universal for other arches); pick the most recently modified.
export function findBuiltApp(root) {
  const releaseDir = join(root, "release");
  if (!existsSync(releaseDir)) return null;
  const apps = readdirSync(releaseDir)
    .filter((d) => d.startsWith("mac"))
    .map((d) => join(releaseDir, d, APP_NAME))
    .filter((p) => existsSync(p));
  if (apps.length === 0) return null;
  apps.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return apps[0];
}

// Gracefully quit a running instance (it owns PTYs/child processes, so a hard
// kill would orphan them). Fall back to pkill only if it won't quit in time.
async function quitRunning() {
  if (!isRunning()) return;
  console.log("Quitting running Daintree…");
  spawnSync("osascript", ["-e", 'quit app "Daintree"'], { stdio: "ignore" });
  for (let i = 0; i < 50 && isRunning(); i++) await sleep(200); // up to ~10s
  if (isRunning()) {
    console.log("Graceful quit timed out — force-killing…");
    spawnSync("pkill", ["-f", PROC_MATCH], { stdio: "ignore" });
    for (let i = 0; i < 25 && isRunning(); i++) await sleep(200); // up to ~5s
  }
}

export async function installApp(root, { relaunch = true } = {}) {
  const src = findBuiltApp(root);
  if (!src) {
    throw new Error("No built app found under release/. Run `npm run package:local` first.");
  }
  console.log(`Installing ${src} -> ${INSTALL_PATH}`);
  await quitRunning();
  rmSync(INSTALL_PATH, { recursive: true, force: true });
  // `ditto` is macOS's bundle-aware copy: preserves symlinks, xattrs, and the
  // code signature exactly (plain cp can mangle these and break the signature).
  const copy = spawnSync("ditto", [src, INSTALL_PATH], { stdio: "inherit" });
  if (copy.status !== 0) throw new Error(`ditto failed copying ${src} to ${INSTALL_PATH}`);

  const verify = spawnSync("codesign", ["--verify", "--strict", INSTALL_PATH], {
    encoding: "utf8",
  });
  if (verify.status !== 0) {
    console.warn(`Warning: codesign verify failed after copy:\n${verify.stderr}`);
  } else {
    console.log("Signature valid in /Applications ✅");
  }

  if (relaunch) {
    spawnSync("open", [INSTALL_PATH], { stdio: "ignore" });
    await sleep(3000);
    console.log(
      isRunning() ? "Launched — Daintree is running ✅" : "Launched (process not detected)"
    );
  }
}

// Direct invocation: `node scripts/install-local.mjs`
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  await installApp(root, { relaunch: true });
}
