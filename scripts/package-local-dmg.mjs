#!/usr/bin/env node
// Builds a local Mac build for testing, stamped with a dev version one minor
// above the current package.json version (e.g. 0.16.0 -> 0.17.0-dev).
// Defaults to a .dmg; pass --dir for an unpackaged .app directory instead.
//
// Signing is automatic, driven by a gitignored .env in the repo root:
//   - CSC_LINK set (Developer ID .p12) -> SIGNED build. Fuses are flipped
//     normally; electron-builder re-signs afterward, so the signature stays
//     valid. Notarization is skipped unless APPLE_API_ISSUER is also set
//     (local builds aren't internet-quarantined, so signed-only launches fine).
//   - CSC_LINK absent -> UNSIGNED build. Signing is disabled AND fuse-flipping
//     is skipped, because flipping fuses patches the Electron Framework binary
//     and invalidates its prebuilt signature; with nothing to re-sign it, the
//     kernel SIGKILLs the app on Apple Silicon (CODESIGNING / Invalid Page in
//     IsRunAsNodeEnabled). Leaving fuses untouched keeps Electron's original
//     valid signature, so the unsigned build still launches.
//
// The version bump is applied via extraMetadata only — package.json is untouched.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import {
  readFileSync as read,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Concurrency guard: two local builds writing to release/ and the shared
// Electron cache at once corrupt each other ("ENOENT app.asar" / "corrupted
// Electron dist"). Refuse to start if another build is already running.
const lockPath = join(root, ".local-build.lock");
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but unsignalable = alive; ESRCH = dead
  }
};
if (existsSync(lockPath)) {
  const prev = Number(readFileSync(lockPath, "utf8").trim());
  if (prev && prev !== process.pid && pidAlive(prev)) {
    console.error(
      `A local build is already running (pid ${prev}). Wait for it to finish — ` +
        `concurrent builds corrupt release/ and the Electron cache.`
    );
    process.exit(1);
  }
}
writeFileSync(lockPath, String(process.pid));
process.on("exit", () => {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // best-effort
  }
});

// Load gitignored signing credentials, if present, into process.env (inherited
// by the electron-builder child below).
const envPath = join(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const { version } = JSON.parse(read(join(root, "package.json"), "utf8"));
const [major, minor] = version.split("-")[0].split(".").map(Number);
// Date-stamp the dev version so each local build is distinguishable, e.g.
// 0.16.0 -> 0.17.0-dev.20260603. Local build time (not UTC).
const now = new Date();
const stamp =
  `${now.getFullYear()}` +
  `${String(now.getMonth() + 1).padStart(2, "0")}` +
  `${String(now.getDate()).padStart(2, "0")}`;
const devVersion = `${major}.${minor + 1}.0-dev.${stamp}`;

const passthrough = process.argv.slice(2);
const dirIdx = passthrough.indexOf("--dir");
const isDir = dirIdx !== -1;
if (isDir) passthrough.splice(dirIdx, 1);
const target = isDir ? "--dir" : "dmg";

// `--install` copies the freshly built app into /Applications and relaunches it.
const installIdx = passthrough.indexOf("--install");
const doInstall = installIdx !== -1;
if (doInstall) passthrough.splice(installIdx, 1);

// `--clean` also nukes the global Electron caches (forces a re-download). Only
// needed if those ever get corrupted; not part of a normal build.
const cleanIdx = passthrough.indexOf("--clean");
const deepClean = cleanIdx !== -1;
if (deepClean) passthrough.splice(cleanIdx, 1);

// Always start from clean build outputs so stale/half-written artifacts can't
// poison the package (the `release/` app.asar corruption seen during races).
console.log("Cleaning build outputs (release/, dist/, dist-electron/)…");
for (const d of ["release", "dist", "dist-electron"]) {
  rmSync(join(root, d), { recursive: true, force: true });
}
if (deepClean) {
  console.log("Deep clean: clearing Electron caches (will re-download Electron)…");
  for (const c of ["electron", "electron-builder"]) {
    rmSync(join(homedir(), "Library", "Caches", c), { recursive: true, force: true });
  }
}

// Signed iff a code-signing cert is configured and the file exists. Resolve
// CSC_LINK to an absolute path so electron-builder finds it regardless of cwd.
let signed = false;
if (process.env.CSC_LINK) {
  const cscPath = isAbsolute(process.env.CSC_LINK)
    ? process.env.CSC_LINK
    : resolve(root, process.env.CSC_LINK);
  if (existsSync(cscPath)) {
    process.env.CSC_LINK = cscPath;
    signed = true;
  } else {
    console.warn(`CSC_LINK set but file not found at ${cscPath} — falling back to UNSIGNED build`);
  }
}

// Never notarize locally unless the issuer is explicitly configured. The
// afterSign hook also auto-skips when Apple API creds are absent, but setting
// this avoids it even attempting to zip the bundle.
if (!process.env.APPLE_API_ISSUER) process.env.DAINTREE_SKIP_NOTARIZATION = "true";

let builderConfig = "electron-builder.config.cjs";
if (!signed) {
  const tmpDir = join(root, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  builderConfig = join(tmpDir, "electron-builder.local-unsigned.cjs");
  writeFileSync(
    builderConfig,
    `const baseFactory = require("../electron-builder.config.cjs");

module.exports = async function localUnsignedConfig(context) {
  const base = await baseFactory(context);
  return {
    ...base,
    electronFuses: null,
    mac: {
      ...base.mac,
      identity: null,
      forceCodeSigning: false,
      notarize: false,
    },
  };
};
`,
    "utf8"
  );
  process.on("exit", () => {
    try {
      rmSync(builderConfig, { force: true });
    } catch {
      // best-effort
    }
  });
}

console.log(
  `Packaging local ${isDir ? "app dir" : "dmg"} as v${devVersion} ` +
    `(${signed ? "signed: Developer ID" : "unsigned"}; working tree stays v${version})`
);

const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });

run("npm", ["run", "build"]);
run("npx", [
  "electron-builder",
  // electron-builder does not auto-detect the `.config.cjs` infix, so the full
  // config (appId, asar, files, protocols, output dir) is only applied when
  // passed explicitly — same as the release workflows. Without this the build
  // falls back to defaults and lands in dist/ instead of release/.
  "--config",
  builderConfig,
  "--mac",
  target,
  "-c.mac.notarize=false",
  `-c.extraMetadata.version=${devVersion}`,
  ...passthrough,
]);

if (doInstall) {
  const { installApp } = await import("./install-local.mjs");
  await installApp(root, { relaunch: true });
}
