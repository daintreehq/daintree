const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const NOTARIZATION_STATE_FILE = ".notarization-state.json";
const WAIT_TIMEOUT_SECONDS = 1800;

function readState(outDir) {
  const statePath = path.join(outDir, NOTARIZATION_STATE_FILE);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {
    console.warn("[notarize-macos] Could not parse notarization state file — starting fresh");
    return null;
  }
}

function writeState(outDir, state) {
  const statePath = path.join(outDir, NOTARIZATION_STATE_FILE);
  const tmpPath = statePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, statePath);
}

function runNotaryTool(args, options) {
  const fullArgs = [...args, "--output-format", "json"];
  const keyPath = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  if (keyPath) fullArgs.push("--key", keyPath);
  if (keyId) fullArgs.push("--key-id", keyId);
  if (issuer) fullArgs.push("--issuer", issuer);
  return execFileSync("xcrun", fullArgs, { encoding: "utf-8", ...options });
}

function zipApp(appPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-notarize-"));
  const zipName = path.basename(appPath, ".app") + ".zip";
  const zipPath = path.join(tmpDir, zipName);
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], {
    encoding: "utf-8",
    timeout: 300000,
  });
  return { zipPath, tmpDir };
}

exports.default = async function afterSign(context) {
  if (process.platform !== "darwin") return;

  if (process.env.DAINTREE_SKIP_NOTARIZATION === "true") {
    console.log("[notarize-macos] Skipping notarization (DAINTREE_SKIP_NOTARIZATION=true)");
    return;
  }

  const { appOutDir, outDir, packager, arch } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`[notarize-macos] App bundle not found: ${appPath}`);
  }

  const keyPath = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;

  if (!keyPath || !keyId || !issuer) {
    console.warn("[notarize-macos] Apple API credentials not set — skipping notarization");
    return;
  }

  const state = readState(outDir) || {};
  const archKey = String(arch);

  if (state[archKey]?.submissionId && state[archKey]?.status === "accepted") {
    await stapleApp(appPath, appName, archKey);
    state[archKey] = { ...state[archKey], status: "stapled", timestamp: new Date().toISOString() };
    writeState(outDir, state);
  } else if (state[archKey]?.submissionId && state[archKey]?.status === "submitted") {
    await reattachAndWait(state, archKey, appPath, appName, outDir);
  } else {
    await submitAndWait(state, archKey, appPath, appName, outDir);
  }
};

async function reattachAndWait(state, archKey, appPath, appName, outDir) {
  const { submissionId } = state[archKey];
  console.log(`[notarize-macos] Reattaching to submission ${submissionId} (arch ${archKey})`);

  try {
    const output = runNotaryTool(
      ["notarytool", "wait", submissionId, "--timeout", String(WAIT_TIMEOUT_SECONDS)],
      { timeout: WAIT_TIMEOUT_SECONDS * 1000 + 60000 }
    );
    const result = JSON.parse(output);
    if (result.status !== "Accepted") {
      throw new Error(
        `[notarize-macos] Notarization not accepted for ${submissionId}: status=${result.status}`
      );
    }
    state[archKey] = { submissionId, status: "accepted", timestamp: new Date().toISOString() };
    writeState(outDir, state);
  } catch (err) {
    if (err.status === 124) {
      console.log(
        `[notarize-macos] Wait timed out for ${submissionId} — submission continues server-side`
      );
      throw new Error(
        `[notarize-macos] Notarization wait timed out (${WAIT_TIMEOUT_SECONDS}s). ` +
          `Submission ID: ${submissionId}. Re-run the workflow to reattach and staple.`
      );
    }
    throw err;
  }

  await stapleApp(appPath, appName, archKey);
  state[archKey] = { ...state[archKey], status: "stapled", timestamp: new Date().toISOString() };
  writeState(outDir, state);
}

async function submitAndWait(state, archKey, appPath, appName, outDir) {
  console.log(`[notarize-macos] Zipping ${appPath} for submission`);

  let zipPath;
  let tmpDir;
  try {
    const zip = zipApp(appPath);
    zipPath = zip.zipPath;
    tmpDir = zip.tmpDir;
  } catch (err) {
    throw new Error(`[notarize-macos] Failed to zip app bundle: ${err.stderr || err.message}`);
  }

  console.log(`[notarize-macos] Submitting ${zipPath} for notarization (arch ${archKey})`);

  let submitResult;
  try {
    const output = runNotaryTool(["notarytool", "submit", zipPath], { timeout: 120000 });
    submitResult = JSON.parse(output);
  } catch (err) {
    throw new Error(`[notarize-macos] Submission failed: ${err.stderr || err.message}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  const submissionId = submitResult.id;
  if (!submissionId) {
    throw new Error(
      `[notarize-macos] No submission ID in response: ${JSON.stringify(submitResult)}`
    );
  }

  console.log(`[notarize-macos] Submitted: ${submissionId}`);

  state[archKey] = { submissionId, status: "submitted", timestamp: new Date().toISOString() };
  writeState(outDir, state);

  try {
    const waitOutput = runNotaryTool(
      ["notarytool", "wait", submissionId, "--timeout", String(WAIT_TIMEOUT_SECONDS)],
      { timeout: WAIT_TIMEOUT_SECONDS * 1000 + 60000 }
    );
    const waitResult = JSON.parse(waitOutput);
    if (waitResult.status !== "Accepted") {
      throw new Error(
        `[notarize-macos] Notarization not accepted for ${submissionId}: status=${waitResult.status}`
      );
    }
  } catch (err) {
    if (err.status === 124) {
      console.log(
        `[notarize-macos] Wait timed out for ${submissionId} — submission continues server-side`
      );
      throw new Error(
        `[notarize-macos] Notarization wait timed out (${WAIT_TIMEOUT_SECONDS}s). ` +
          `Submission ID: ${submissionId}. Re-run the workflow to reattach and staple.`
      );
    }
    throw err;
  }

  state[archKey] = { submissionId, status: "accepted", timestamp: new Date().toISOString() };
  writeState(outDir, state);

  await stapleApp(appPath, appName, archKey);
  state[archKey] = { ...state[archKey], status: "stapled", timestamp: new Date().toISOString() };
  writeState(outDir, state);
}

async function stapleApp(appPath, appName, archKey) {
  console.log(`[notarize-macos] Stapling ${appPath}`);
  try {
    execFileSync("xcrun", ["stapler", "staple", appPath], { encoding: "utf-8", timeout: 120000 });
  } catch (err) {
    throw new Error(
      `[notarize-macos] Stapling failed for ${appPath}: ${err.stderr || err.message}`
    );
  }
  console.log(`[notarize-macos] Complete — ${appName} notarized and stapled (arch ${archKey})`);
}
