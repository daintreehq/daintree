const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const { resignHelpers } = require("./resign-helpers-macos.cjs");

const NOTARIZATION_STATE_FILE = ".notarization-state.json";
const WAIT_TIMEOUT_SECONDS = 1800;
const STAPLE_RETRY_DELAYS_MS = [15000, 30000, 60000];

function readState(outDir) {
  const statePath = path.join(outDir, NOTARIZATION_STATE_FILE);
  if (!fs.existsSync(statePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {
    console.warn("[notarize-macos] Could not parse notarization state file — starting fresh");
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[notarize-macos] Notarization state file is not an object — starting fresh");
    return null;
  }
  return parsed;
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

// The main executable's code directory hash seals Info.plist and CodeResources,
// which in turn lists the cdhash of every nested binary, so it identifies the
// whole signed bundle. It is also what stapler looks the ticket up by, so a
// stored submission only applies to a bundle with the same CDHash. `codesign
// -d` prints its details to stderr, hence spawnSync.
function readBundleCdhash(appPath) {
  const result = spawnSync("codesign", ["-dvvv", appPath], { encoding: "utf-8", timeout: 60000 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const match = !result.error && result.status === 0 && output.match(/^CDHash=([0-9a-f]+)$/m);
  if (!match) {
    const detail = result.error ? result.error.message : output.trim() || `exit ${result.status}`;
    console.warn(`[notarize-macos] Could not read the code signature of ${appPath}: ${detail}`);
    return null;
  }
  return match[1];
}

function timeoutError(submissionId) {
  return new Error(
    `[notarize-macos] Notarization wait timed out (${WAIT_TIMEOUT_SECONDS}s). ` +
      `Submission ID: ${submissionId}; it continues on Apple's side, check it with ` +
      `\`xcrun notarytool info ${submissionId}\` (or \`notarytool log\`). A re-run on a fresh CI ` +
      `runner rebuilds and submits again; only a re-run in this out dir with an identically ` +
      `signed bundle reattaches to this submission.`
  );
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

  // Re-sign the spawned helper executables with empty entitlements before
  // notarization (#9775). This is a signing concern independent of
  // notarization, so it runs even when DAINTREE_SKIP_NOTARIZATION is set. The
  // function self-guards on CSC_LINK and platform.
  await resignHelpers(context);

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
  const cdhash = readBundleCdhash(appPath);
  const entry = state[archKey];
  const resumable =
    entry?.submissionId && (entry.status === "accepted" || entry.status === "submitted");

  if (resumable && (!cdhash || entry.cdhash !== cdhash)) {
    console.log(
      `[notarize-macos] Not resuming ${entry.status} submission ${entry.submissionId} (arch ${archKey}): ` +
        `it was recorded for ${entry.cdhash ? `bundle CDHash ${entry.cdhash}` : "an unidentified bundle"}, ` +
        `the bundle at ${appPath} is ${cdhash ? `CDHash ${cdhash}` : "unidentified"} — submitting fresh`
    );
    await submitAndWait(state, archKey, appPath, appName, outDir, cdhash);
  } else if (resumable && entry.status === "accepted") {
    await stapleApp(appPath, appName, archKey);
    state[archKey] = { ...entry, status: "stapled", timestamp: new Date().toISOString() };
    writeState(outDir, state);
  } else if (resumable) {
    await reattachAndWait(state, archKey, appPath, appName, outDir, cdhash);
  } else {
    await submitAndWait(state, archKey, appPath, appName, outDir, cdhash);
  }
};

async function reattachAndWait(state, archKey, appPath, appName, outDir, cdhash) {
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
    state[archKey] = {
      submissionId,
      status: "accepted",
      cdhash,
      timestamp: new Date().toISOString(),
    };
    writeState(outDir, state);
  } catch (err) {
    if (err.status === 124) {
      console.log(
        `[notarize-macos] Wait timed out for ${submissionId} — submission continues server-side`
      );
      throw timeoutError(submissionId);
    }
    throw err;
  }

  await stapleApp(appPath, appName, archKey);
  state[archKey] = { ...state[archKey], status: "stapled", timestamp: new Date().toISOString() };
  writeState(outDir, state);
}

async function submitAndWait(state, archKey, appPath, appName, outDir, cdhash) {
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

  state[archKey] = {
    submissionId,
    status: "submitted",
    cdhash,
    timestamp: new Date().toISOString(),
  };
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
      throw timeoutError(submissionId);
    }
    throw err;
  }

  state[archKey] = {
    submissionId,
    status: "accepted",
    cdhash,
    timestamp: new Date().toISOString(),
  };
  writeState(outDir, state);

  await stapleApp(appPath, appName, archKey);
  state[archKey] = { ...state[archKey], status: "stapled", timestamp: new Date().toISOString() };
  writeState(outDir, state);
}

async function stapleApp(appPath, appName, archKey) {
  // stapler fetches the issued ticket from Apple's CloudKit, which drops CI
  // runner connections often enough to fail a release on its own; the ticket
  // already exists, so a retry is safe.
  for (let attempt = 0; ; attempt++) {
    console.log(`[notarize-macos] Stapling ${appPath}`);
    try {
      execFileSync("xcrun", ["stapler", "staple", appPath], { encoding: "utf-8", timeout: 120000 });
      break;
    } catch (err) {
      // stapler reports its failures on stdout; the message carries stderr and
      // any spawn timeout.
      const detail = [err.message, err.stdout].filter(Boolean).join("\n").trim();
      if (attempt >= STAPLE_RETRY_DELAYS_MS.length) {
        throw new Error(`[notarize-macos] Stapling failed for ${appPath}: ${detail}`);
      }
      const delayMs = STAPLE_RETRY_DELAYS_MS[attempt];
      console.warn(
        `[notarize-macos] Stapling attempt ${attempt + 1} failed, retrying in ${delayMs / 1000}s: ${detail}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  console.log(`[notarize-macos] Complete — ${appName} notarized and stapled (arch ${archKey})`);
}
