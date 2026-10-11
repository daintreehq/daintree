#!/usr/bin/env node
// Installs a locally-built Daintree.app into /Applications, replacing any
// existing copy. Used for dogfooding the dev build as the daily driver.
//
//   npm run install:local              build then install in one shot
//   npm run install:local:fast         install the most recent release/ build
//
// A running Daintree is left alone — it owns live agent sessions — and picks up
// the new build on its next quit and reopen. Until then it is not fully isolated:
// helpers and utility processes it spawns resolve paths inside the bundle, so a
// respawned pty-host or a new renderer runs the new build's code. Restart soon,
// and promptly after an Electron bump. If nothing is running, the new build is
// launched.
//
// Same bundle ID as production (org.daintree.app), so this overwrites whatever
// Daintree is installed and shares its user data — that's the point: the dev
// build becomes the one Daintree on this machine.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, readdirSync, statSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "Daintree.app";
const INSTALL_PATH = `/Applications/${APP_NAME}`;
const STAGING_PATH = `/Applications/.${APP_NAME}.installing`;
const RETIRED_PATH = `/Applications/.${APP_NAME}.old`;
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

export async function installApp(root, { launchIfNotRunning = true } = {}) {
  const src = findBuiltApp(root);
  if (!src) {
    throw new Error("No built app found under release/. Run `npm run package:local` first.");
  }
  console.log(`Installing ${src} -> ${INSTALL_PATH}`);

  // A previous install interrupted between the two renames leaves the old app
  // only at RETIRED_PATH; put it back before anything deletes it.
  if (!existsSync(INSTALL_PATH) && existsSync(RETIRED_PATH)) {
    renameSync(RETIRED_PATH, INSTALL_PATH);
  }

  // Copy to a staging path first and swap it in with renames, so the running
  // app's bundle path is missing for an instant rather than for the whole copy.
  // `ditto` is macOS's bundle-aware copy: preserves symlinks, xattrs, and the
  // code signature exactly (plain cp can mangle these and break the signature).
  rmSync(STAGING_PATH, { recursive: true, force: true });
  const copy = spawnSync("ditto", [src, STAGING_PATH], { stdio: "inherit" });
  if (copy.status !== 0) {
    rmSync(STAGING_PATH, { recursive: true, force: true });
    throw new Error(`ditto failed copying ${src} to ${STAGING_PATH}`);
  }

  const verify = spawnSync("codesign", ["--verify", "--strict", STAGING_PATH], {
    encoding: "utf8",
  });
  if (verify.status !== 0) {
    console.warn(`Warning: codesign verify failed after copy:\n${verify.stderr}`);
  } else {
    console.log("Signature valid ✅");
  }

  rmSync(RETIRED_PATH, { recursive: true, force: true });
  const hadInstall = existsSync(INSTALL_PATH);
  if (hadInstall) renameSync(INSTALL_PATH, RETIRED_PATH);
  try {
    renameSync(STAGING_PATH, INSTALL_PATH);
  } catch (err) {
    if (hadInstall) renameSync(RETIRED_PATH, INSTALL_PATH);
    throw err;
  }
  console.log(`Installed to ${INSTALL_PATH} ✅`);
  try {
    rmSync(RETIRED_PATH, { recursive: true, force: true });
  } catch (err) {
    console.warn(`Warning: couldn't remove the previous build at ${RETIRED_PATH}: ${err.message}`);
  }

  if (isRunning()) {
    console.log("Daintree is running — quit and reopen it to run the new version.");
  } else if (launchIfNotRunning) {
    const open = spawnSync("open", [INSTALL_PATH], { stdio: "ignore" });
    if (open.status !== 0) {
      console.warn(`Warning: \`open ${INSTALL_PATH}\` failed — launch it manually.`);
      return;
    }
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
  await installApp(root);
}
