const path = require("path");
const fs = require("fs");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

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
 * Get the path to the Electron binary for fuse flipping
 */
function getElectronBinaryPath(appOutDir, electronPlatformName, appName, executableName) {
  if (electronPlatformName === "darwin") {
    return path.join(appOutDir, `${appName}.app`, "Contents/MacOS", appName);
  } else if (electronPlatformName === "win32") {
    return path.join(appOutDir, `${appName}.exe`);
  } else if (electronPlatformName === "linux") {
    return path.join(appOutDir, executableName);
  } else {
    throw new Error(
      `[afterPack] Unsupported platform: ${electronPlatformName}. ` +
        "Electron fuses can only be configured for darwin, win32, or linux."
    );
  }
}

/**
 * electron-builder afterPack hook for handling native modules.
 * This runs after the app is packed but before it's signed/notarized.
 *
 * Validates that node-pty native module is properly unpacked and exists.
 *
 * @param {Object} context - The electron-builder context
 * @param {string} context.appOutDir - The output directory
 * @param {string} context.electronPlatformName - 'darwin', 'linux', or 'win32'
 * @param {Object} context.packager - The packager instance
 */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const appName = packager.appInfo.productFilename;

  console.log(`[afterPack] Platform: ${electronPlatformName}`);
  console.log(`[afterPack] Output directory: ${appOutDir}`);

  // Get platform-specific unpacked resources path
  const unpackedPath = getUnpackedResourcesPath(appOutDir, electronPlatformName, appName);
  const nodePtyPath = path.join(unpackedPath, "node_modules/node-pty");

  // Verify node-pty exists
  if (!fs.existsSync(nodePtyPath)) {
    throw new Error(
      `[afterPack] CRITICAL: node-pty not found at ${nodePtyPath}. ` +
        "Terminal functionality will not work. Check asarUnpack configuration."
    );
  }

  console.log(`[afterPack] node-pty found at: ${nodePtyPath}`);

  // Verify the native binary exists
  const nativeBinaryPath = path.join(nodePtyPath, "build/Release/pty.node");
  if (!fs.existsSync(nativeBinaryPath)) {
    throw new Error(
      `[afterPack] CRITICAL: node-pty native binary not found at ${nativeBinaryPath}. ` +
        'Run "npm run rebuild" to build the native module.'
    );
  }

  console.log(`[afterPack] Native binary verified: ${nativeBinaryPath}`);

  // On macOS, native modules will be signed during the code signing phase
  if (electronPlatformName === "darwin") {
    console.log("[afterPack] Native modules will be signed during code signing phase");
  }

  // Flip Electron fuses for security hardening
  const executableName = packager.executableName;
  const electronBinaryPath = getElectronBinaryPath(
    appOutDir,
    electronPlatformName,
    appName,
    executableName
  );

  if (!fs.existsSync(electronBinaryPath)) {
    throw new Error(
      `[afterPack] CRITICAL: Electron binary not found at ${electronBinaryPath}. ` +
        "Cannot flip fuses. Check electron-builder output directory structure."
    );
  }

  console.log(`[afterPack] Flipping Electron fuses for: ${electronBinaryPath}`);

  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: electronPlatformName === "darwin",
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });

  console.log("[afterPack] Electron fuses flipped successfully");
  console.log("[afterPack] Complete - native modules validated and fuses configured");
};
