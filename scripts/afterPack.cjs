const path = require("path");
const fs = require("fs");

/**
 * Validate that better_sqlite3.node was compiled for Electron's ABI, not Node's.
 *
 * better-sqlite3 uses the raw V8/NAN C++ API (not N-API), so the compiled
 * binary is ABI-specific. A binary compiled for Node.js will load successfully
 * under Node (which runs afterPack), but crash at Electron runtime with a
 * NODE_MODULE_VERSION mismatch. We exploit this: if dlopen succeeds here
 * (under Node), the binary is wrong; if it fails with an ABI mismatch error,
 * the binary was correctly compiled for Electron.
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
      console.log("[afterPack] better-sqlite3 ABI check passed (compiled for Electron, not Node)");
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
      const versionFolder = fs.readdirSync(thirdPartyDir)[0];
      const sourceDir = path.join(thirdPartyDir, versionFolder, "win10-x64");
      if (!fs.existsSync(sourceDir)) {
        throw new Error(`[afterPack] CRITICAL: conpty source directory not found: ${sourceDir}`);
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
