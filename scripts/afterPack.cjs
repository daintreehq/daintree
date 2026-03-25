const path = require("path");
const fs = require("fs");

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
    // Windows uses N-API prebuilds (node-pty 1.2.0-beta.12+).
    // No source compilation needed — prebuilds are ABI-stable across Electron versions.
    const arch = context.arch || "x64";
    const prebuildDir = `prebuilds/win32-${arch}`;
    const requiredFiles = [
      `${prebuildDir}/conpty.node`,
      `${prebuildDir}/conpty_console_list.node`,
      `${prebuildDir}/conpty/conpty.dll`,
      `${prebuildDir}/conpty/OpenConsole.exe`,
    ];
    for (const file of requiredFiles) {
      const filePath = path.join(nodePtyPath, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `[afterPack] CRITICAL: Windows node-pty prebuild not found: ${filePath}. ` +
            "Ensure node-pty prebuilds are included (check build.files in package.json)."
        );
      }
    }
    console.log(
      "[afterPack] Windows node-pty prebuilds verified (conpty.node, conpty_console_list.node, conpty/conpty.dll, conpty/OpenConsole.exe)"
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

  console.log(`[afterPack] better-sqlite3 verified: ${betterSqliteNative}`);

  console.log("[afterPack] Complete - native modules validated");
};
