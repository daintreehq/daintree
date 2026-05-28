const path = require("path");
const fs = require("fs");

/**
 * Validate that win_job_object.node loads and exports its primary binding.
 *
 * win-job-object is an N-API addon, so its compiled binary has a stable ABI
 * across Node.js and Electron versions — unlike better-sqlite3, the inverse
 * dlopen trick does not apply (a correctly-built N-API binary always loads
 * under Node). The probe is a forward load + export-shape check: dlopen the
 * .node file directly and confirm `assignProcessToHelpJob` is wired up. This
 * catches the realistic Windows failure modes — missing VCRUNTIME140.dll,
 * arch mismatch (x64 vs arm64), truncated binary — all of which surface as
 * thrown errors from `process.dlopen`.
 */
function validateWinJobObjectLoadable(nativeBinaryPath) {
  const testModule = { exports: {} };
  try {
    process.dlopen(testModule, nativeBinaryPath);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(
      `[afterPack] CRITICAL: win-job-object failed to load: ${msg}. ` +
        "Help-session crash-safe reaping (#7526) will be broken. " +
        "Check that VCRUNTIME140.dll is present and the binary architecture matches the target (x64 vs arm64)."
    );
  }
  if (typeof testModule.exports.assignProcessToHelpJob !== "function") {
    throw new Error(
      `[afterPack] CRITICAL: win-job-object loaded but assignProcessToHelpJob export is missing or not a function. ` +
        "Help-session crash-safe reaping (#7526) will be broken."
    );
  }
  console.log("[afterPack] win-job-object ABI check passed (N-API forward load OK)");
}

/**
 * Validate that better_sqlite3.node has Electron ABI, not Node ABI.
 *
 * better-sqlite3 uses the raw V8/NAN C++ API (not N-API), so the binary is
 * ABI-specific. Whether the binary was downloaded via prebuild-install or
 * compiled from source, a Node-ABI binary will load successfully under Node
 * (which runs afterPack) but crash at Electron runtime with a
 * NODE_MODULE_VERSION mismatch. We exploit this: if dlopen succeeds here
 * (under Node), the binary is wrong; if it fails with an ABI mismatch error,
 * the binary has the correct Electron ABI.
 */
function validateBetterSqliteAbi(nativeBinaryPath) {
  const testModule = { exports: {} };
  try {
    process.dlopen(testModule, nativeBinaryPath);
    // Loaded under Node.js — this means it was compiled for Node ABI, not Electron
    throw new Error(
      `[afterPack] CRITICAL: better_sqlite3.node was compiled for Node.js ABI (MODULE_VERSION ${process.versions.modules}), not Electron. ` +
        'Run "npm run rebuild" to recompile for Electron. Path: ' +
        nativeBinaryPath
    );
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("compiled for Node.js ABI")) throw err;
    if (
      msg.includes("NODE_MODULE_VERSION") ||
      msg.includes("was compiled against a different Node.js version") ||
      msg.includes("invalid ELF header") ||
      msg.includes("not a valid Win32 application")
    ) {
      console.log("[afterPack] better-sqlite3 ABI check passed (Electron-ABI binary confirmed)");
      return;
    }
    // Unknown error — warn but don't fail (e.g. missing DLL dependency on Windows)
    console.warn(`[afterPack] Warning: better-sqlite3 ABI probe inconclusive: ${msg}`);
  }
}

/**
 * Get the path to unpacked resources for the platform
 */
function getUnpackedResourcesPath(appOutDir, electronPlatformName, appName) {
  if (electronPlatformName === "darwin") {
    return path.join(appOutDir, `${appName}.app`, "Contents/Resources/app.asar.unpacked");
  }
  // Windows and Linux
  return path.join(appOutDir, "resources/app.asar.unpacked");
}

/**
 * electron-builder afterPack hook.
 * Validates that the node-pty native module is properly unpacked.
 * Fuses are configured via the native electronFuses config in package.json.
 */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const appName = packager.appInfo.productFilename;

  console.log(`[afterPack] Platform: ${electronPlatformName}`);
  console.log(`[afterPack] Output directory: ${appOutDir}`);

  const unpackedPath = getUnpackedResourcesPath(appOutDir, electronPlatformName, appName);
  const nodePtyPath = path.join(unpackedPath, "node_modules/node-pty");

  if (!fs.existsSync(nodePtyPath)) {
    throw new Error(
      `[afterPack] CRITICAL: node-pty not found at ${nodePtyPath}. ` +
        "Terminal functionality will not work. Check asarUnpack configuration."
    );
  }

  console.log(`[afterPack] node-pty found at: ${nodePtyPath}`);

  if (electronPlatformName === "win32") {
    // electron-builder passes `context.arch` as an integer from the `Arch` enum
    // (ia32=0, x64=1, armv7l=2, arm64=3, universal=5). Map to the conpty
    // distribution folder name used by node-pty's third_party layout.
    const conptyArchFolder = context.arch === 3 ? "win10-arm64" : "win10-x64";
    console.log(`[afterPack] Windows arch: ${context.arch} (conpty folder: ${conptyArchFolder})`);

    // Windows uses ConPTY exclusively (winpty removed in node-pty 1.2.0-beta)
    const compiledBinaries = ["conpty.node", "conpty_console_list.node"];
    const postInstallBinaries = ["conpty/conpty.dll", "conpty/OpenConsole.exe"];
    for (const bin of compiledBinaries) {
      const binPath = path.join(nodePtyPath, "build/Release", bin);
      if (!fs.existsSync(binPath)) {
        throw new Error(
          `[afterPack] CRITICAL: Windows node-pty compiled binary not found: ${binPath}. ` +
            "Ensure node-pty was rebuilt on a Windows runner with VS 2022 Build Tools."
        );
      }
    }

    // electron-rebuild runs node-gyp rebuild which wipes build/Release/,
    // deleting the conpty/ subdirectory created by node-pty's post-install.
    // If missing, copy from third_party as a fallback.
    const conptyDestDir = path.join(nodePtyPath, "build/Release/conpty");
    const conptyMissing = postInstallBinaries.some(
      (bin) => !fs.existsSync(path.join(nodePtyPath, "build/Release", bin))
    );
    if (conptyMissing) {
      console.log(
        "[afterPack] conpty binaries missing from build/Release — copying from third_party"
      );
      const thirdPartyDir = path.join(nodePtyPath, "third_party/conpty");
      if (!fs.existsSync(thirdPartyDir)) {
        throw new Error(
          `[afterPack] CRITICAL: third_party/conpty not found at ${thirdPartyDir}. ` +
            "Cannot recover missing conpty binaries."
        );
      }
      // node-pty's third_party/conpty contains zero-padded date-stamped
      // version folders (e.g. `1.25.260303002`). Sort lexicographically and
      // pick the latest so a stale folder from a previous node-pty version
      // can't silently override the current one.
      const versionFolder = fs.readdirSync(thirdPartyDir).sort().at(-1);
      if (!versionFolder) {
        throw new Error(
          `[afterPack] CRITICAL: third_party/conpty exists but is empty at ${thirdPartyDir}.`
        );
      }
      const sourceDir = path.join(thirdPartyDir, versionFolder, conptyArchFolder);
      if (!fs.existsSync(sourceDir)) {
        throw new Error(
          `[afterPack] CRITICAL: conpty source directory not found for arch ${context.arch}: ${sourceDir}. ` +
            "Ensure node-pty's post-install ran with the correct npm_config_arch."
        );
      }
      fs.mkdirSync(conptyDestDir, { recursive: true });
      for (const file of ["conpty.dll", "OpenConsole.exe"]) {
        const src = path.join(sourceDir, file);
        const dest = path.join(conptyDestDir, file);
        console.log(`[afterPack] Copying ${src} -> ${dest}`);
        fs.copyFileSync(src, dest);
      }
    }

    // Final validation
    for (const bin of postInstallBinaries) {
      const binPath = path.join(nodePtyPath, "build/Release", bin);
      if (!fs.existsSync(binPath)) {
        throw new Error(
          `[afterPack] CRITICAL: Windows node-pty post-install binary not found: ${binPath}. ` +
            "Both postinstall and afterPack fallback copy failed."
        );
      }
    }
    console.log(
      "[afterPack] Windows node-pty binaries verified (conpty.node, conpty_console_list.node, conpty/conpty.dll, conpty/OpenConsole.exe)"
    );

    // win-job-object: help-session PTY tree reaping (#7526). Source-only
    // addon — must be compiled on a Windows runner with VS 2022 Build Tools.
    const winJobObjectBinary = path.join(
      unpackedPath,
      "node_modules/win-job-object/build/Release/win_job_object.node"
    );
    if (!fs.existsSync(winJobObjectBinary)) {
      throw new Error(
        `[afterPack] CRITICAL: win-job-object native binary not found at ${winJobObjectBinary}. ` +
          'Help-session crash-safe reaping (#7526) will be disabled. Run "npm run rebuild" on a Windows runner with VS 2022 Build Tools.'
      );
    }
    validateWinJobObjectLoadable(winJobObjectBinary);
    console.log(`[afterPack] win-job-object verified: ${winJobObjectBinary}`);
  } else {
    // macOS and Linux use pty.node
    const nativeBinaryPath = path.join(nodePtyPath, "build/Release/pty.node");
    if (!fs.existsSync(nativeBinaryPath)) {
      throw new Error(
        `[afterPack] CRITICAL: node-pty native binary not found at ${nativeBinaryPath}. ` +
          'Run "npm run rebuild" to build the native module.'
      );
    }
    console.log(`[afterPack] Native binary verified: ${nativeBinaryPath}`);

    // posix-pty-reaper: help-session PTY tree reaping (#8769). Source-only
    // executable — compiled by electron-rebuild during postinstall on the
    // macOS / Linux runner. Mirrors the win-job-object check on Windows.
    const posixReaperBinary = path.join(
      unpackedPath,
      "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
    );
    if (!fs.existsSync(posixReaperBinary)) {
      throw new Error(
        `[afterPack] CRITICAL: posix-pty-reaper supervisor binary not found at ${posixReaperBinary}. ` +
          'Help-session crash-safe reaping (#8769) will be disabled. Run "npm run rebuild".'
      );
    }
    // posix-pty-reaper is a compiled C executable (not a .node addon) with no
    // safe `--version` probe — its main() enters a blocking read loop on stdin.
    // Verify the executable bit is set so the supervisor can actually be spawned
    // at runtime; this mirrors the wrapper's own isAvailable() check.
    try {
      fs.accessSync(posixReaperBinary, fs.constants.X_OK);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(
        `[afterPack] CRITICAL: posix-pty-reaper supervisor exists but is not executable at ${posixReaperBinary}: ${msg}. ` +
          'Help-session crash-safe reaping (#8769) will be broken. Run "npm run rebuild".'
      );
    }
    console.log(`[afterPack] posix-pty-reaper verified: ${posixReaperBinary}`);

    if (electronPlatformName === "darwin") {
      // Inject pre-compiled Assets.car for macOS 26+ Liquid Glass icon.
      // The .car was compiled from build/AppIcon.icon via actool on a machine
      // with Xcode 26, so CI runners don't need Xcode installed.
      const assetsCar = path.join(__dirname, "..", "build", "icon-compiled", "Assets.car");
      if (fs.existsSync(assetsCar)) {
        const resourcesDir = path.join(appOutDir, `${appName}.app`, "Contents/Resources");
        const dest = path.join(resourcesDir, "Assets.car");
        fs.copyFileSync(assetsCar, dest);
        console.log(`[afterPack] Injected Assets.car into ${dest}`);
      } else {
        console.log("[afterPack] No pre-compiled Assets.car found, skipping Liquid Glass icon");
      }

      console.log("[afterPack] Native modules will be signed during code signing phase");
    }
  }

  const betterSqlitePath = path.join(unpackedPath, "node_modules/better-sqlite3");

  if (!fs.existsSync(betterSqlitePath)) {
    throw new Error(
      `[afterPack] CRITICAL: better-sqlite3 not found at ${betterSqlitePath}. ` +
        "Database functionality will not work. Check asarUnpack configuration."
    );
  }

  const betterSqliteNative = path.join(betterSqlitePath, "build/Release/better_sqlite3.node");
  if (!fs.existsSync(betterSqliteNative)) {
    throw new Error(
      `[afterPack] CRITICAL: better-sqlite3 native binary not found at ${betterSqliteNative}. ` +
        'Run "npm run rebuild" to build the native module.'
    );
  }

  validateBetterSqliteAbi(betterSqliteNative);

  console.log(`[afterPack] better-sqlite3 verified: ${betterSqliteNative}`);

  console.log("[afterPack] Complete - native modules validated");
};
