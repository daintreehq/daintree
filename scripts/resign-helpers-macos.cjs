const path = require("path");
const fs = require("fs");
const { execFileSync, spawnSync } = require("child_process");

const LOG = "[resign-helpers-macos]";

// The spawned helper executables that amfid validates against their claimed
// entitlements. electron-builder signs these via mac.binaries[] with the full
// app plist inherited (entitlementsInherit), which leaks the restricted
// com.apple.security.device.audio-input entitlement onto them. macOS 26 (Tahoe)
// kills any spawned executable claiming a restricted entitlement without an
// embedded provisioning profile (#9775). Paths mirror mac.binaries[] in
// electron-builder.config.cjs and the afterPack.cjs presence checks.
const HELPER_RELATIVE_PATHS = [
  "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
  "Contents/Resources/app.asar.unpacked/node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor",
  // The Daintree Assistant engine. It is spawned like any other helper, so it hits
  // exactly the same Tahoe rule: signed through mac.binaries[] it inherits the app
  // plist, including the restricted audio-input entitlement it has no use for, and
  // amfid kills it at spawn. The app would sign and notarize cleanly and the
  // assistant would simply never start — the worst shape of failure, because every
  // gate reports success.
  "Contents/Resources/assistant/daintree-assistant",
];

// Parse the signing identity from the already-signed .app. `codesign -dvv`
// prints the signature details (including the Authority chain) to stderr and
// exits 0; spawnSync lets us read stderr directly (execFileSync only returns
// stdout). The leaf "Developer ID Application: ..." authority is the identity
// string codesign --sign expects, and matches whatever cert electron-builder
// just used — covering both CI (CSC_LINK keychain import) and local keychains.
function detectSigningIdentity(appPath) {
  const result = spawnSync("codesign", ["-dvv", appPath], {
    encoding: "utf-8",
    timeout: 60000,
  });
  if (result.error) {
    throw new Error(`${LOG} Failed to inspect signature of ${appPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${LOG} codesign -dvv exited ${result.status} for ${appPath}: ${(result.stderr || "").trim()}. ` +
        "The .app must be signed before the helpers can be re-signed."
    );
  }
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  const match = combined.match(/^Authority=(Developer ID Application:.*)$/m);
  if (!match) {
    throw new Error(
      `${LOG} Could not determine the "Developer ID Application" signing identity from ${appPath}. ` +
        "The .app must be signed before the helpers can be re-signed."
    );
  }
  return match[1];
}

function codesign(args) {
  execFileSync("codesign", args, { encoding: "utf-8", stdio: "inherit", timeout: 120000 });
}

/**
 * electron-builder afterSign hook step. Re-signs the spawned helper executables
 * with an empty entitlement set so macOS 26's amfid no longer kills them, then
 * repairs the outer bundle seal (re-signing inner binaries changes their cdhash,
 * which invalidates the .app seal and would otherwise fail notarization).
 *
 * Runs only on macOS signed builds (gated on CSC_LINK, the same signal
 * electron-builder.config.cjs uses to enable signing-only behaviour). It must
 * run BEFORE notarization and even when DAINTREE_SKIP_NOTARIZATION is set, since
 * helper entitlements are a signing property independent of notarization.
 */
async function resignHelpers(context) {
  if (process.platform !== "darwin") return;

  if (!process.env.CSC_LINK) {
    console.log(
      `${LOG} No signing certificate configured (CSC_LINK unset) — skipping helper re-sign`
    );
    return;
  }

  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`${LOG} App bundle not found: ${appPath}`);
  }

  const helperPaths = HELPER_RELATIVE_PATHS.map((rel) => path.join(appPath, rel));
  for (const helperPath of helperPaths) {
    if (!fs.existsSync(helperPath)) {
      throw new Error(
        `${LOG} Helper executable not found: ${helperPath}. ` +
          "Packaging layout drifted — the binaries[] paths in electron-builder.config.cjs must match."
      );
    }
  }

  const identity = detectSigningIdentity(appPath);
  console.log(`${LOG} Re-signing helpers with identity: ${identity}`);

  const entitlements = path.join(__dirname, "..", "build", "entitlements.helpers.plist");

  for (const helperPath of helperPaths) {
    console.log(`${LOG} Re-signing ${helperPath} with minimal entitlements`);
    codesign([
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      entitlements,
      helperPath,
    ]);
  }

  // Repair the outer bundle seal broken by re-signing the inner helpers.
  // --preserve-metadata keeps the app's own entitlements (audio-input, etc.),
  // CFBundleIdentifier, and the hardened-runtime flag intact on the reseal.
  console.log(`${LOG} Repairing bundle seal: ${appPath}`);
  codesign([
    "--force",
    "--sign",
    identity,
    "--timestamp",
    "--preserve-metadata=identifier,entitlements,flags",
    appPath,
  ]);

  console.log(
    `${LOG} Complete — helpers re-signed with empty entitlements and bundle seal repaired`
  );
}

module.exports = { resignHelpers };
