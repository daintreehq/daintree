/**
 * electron-builder beforeBuild hook.
 * Skips native module rebuild on Windows where node-pty ships complete
 * N-API prebuilds. On macOS/Linux, allows the default rebuild to run
 * (Linux prebuilds lack spawn-helper, macOS build/Release is needed
 * for code signing).
 *
 * Returning false tells electron-builder that node_modules are handled
 * externally; returning undefined allows the default rebuild.
 */
exports.default = async function beforeBuild(context) {
  const platformName = context.platform.nodeName;
  if (platformName === "win32") {
    console.log(
      "[beforeBuild] Windows detected — skipping native module rebuild (using prebuilds)"
    );
    return false;
  }
  console.log(`[beforeBuild] Platform: ${platformName} — allowing native module rebuild`);
};
