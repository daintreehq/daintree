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

  console.log("[afterPack] Complete - native modules validated");
};
