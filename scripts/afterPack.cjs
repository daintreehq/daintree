const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { getRawHeader } = require("@electron/asar");

// electron-builder passes `context.arch` as an integer from the `Arch` enum
// in builder-util (ia32=0, x64=1, armv7l=2, arm64=3, universal=4).
const ARCH_ENUM_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64" };

// Not in ARCH_ENUM_NAMES: universal is a merge of two slices, not a target
// triple, so it has no prebuild directory name of its own. afterPack.test.ts
// pins this against the real `Arch` enum so a renumbering upstream fails the
// suite instead of silently downgrading the checks below to a single arch.
const UNIVERSAL_ARCH = 4;

/**
 * The prebuild arches a package must carry. A macOS universal package merges
 * both slices, so both darwin prebuilds must be present; otherwise the single
 * target arch (falling back to the runner arch when electron-builder passes
 * no arch, e.g. in tests).
 */
function getBetterSqlitePrebuildArches(contextArch) {
  if (contextArch === UNIVERSAL_ARCH) return ["x64", "arm64"];
  const name = ARCH_ENUM_NAMES[contextArch];
  return [name || process.arch];
}

/**
 * Every top-level entry `app.asar` may contain, derived from `baseFiles()` in
 * electron-builder.config.cjs: `dist/**` and `dist-electron/**` (the built
 * renderer and main bundles), `electron/` (only
 * services/persistence/migrations survives the allowlist), the production
 * `node_modules` tree, and the `package.json` electron-builder always injects.
 *
 * asarUnpack does not change this set — unpacked files stay listed in the asar
 * header under their normal roots, with the bytes on disk beside the archive.
 */
const APP_ASAR_ROOT_ENTRIES = ["dist", "dist-electron", "electron", "node_modules", "package.json"];

/**
 * ~3x headroom over the ~40MB the allowlist produces today. Native modules are
 * asarUnpack'd, so this archive is the JS bundles plus a handful of small
 * runtime packages and does not track native-binary growth. A build that
 * legitimately crosses this line wants investigating, not a bigger number.
 */
const MAX_APP_ASAR_BYTES = 120 * 1024 * 1024;

const asMiB = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

function getAppAsarPath(appOutDir, electronPlatformName, appName) {
  if (electronPlatformName === "darwin") {
    return path.join(appOutDir, `${appName}.app`, "Contents/Resources/app.asar");
  }
  return path.join(appOutDir, "resources/app.asar");
}

/**
 * Validate the packaged archive's size and top-level shape (#11475).
 *
 * A platform-level `files` array replaces the top-level one rather than
 * merging with it, so a platform override that forgets to spread `baseFiles()`
 * silently drops the whole allowlist and electron-builder falls back to
 * `**\/*` — packing the entire source tree (601MB vs 39.8MB) and breaking the
 * macOS universal merge on the per-arch node-gyp metadata it drags in. Nothing
 * else in this hook notices: every native-module check below reads
 * app.asar.unpacked, which stays correct while app.asar bloats.
 *
 * The two assertions catch different shapes of the same class: the root-entry
 * set catches "wrong things packed" even when the total stays small, the size
 * ceiling catches "right things packed" when one of them balloons. Both are
 * hard failures — a shipped 601MB archive breaks notarization and distribution,
 * so this must fail the build rather than warn.
 *
 * Reads only the asar header, which is O(header) regardless of archive size —
 * but the size gate still runs first, because a runaway archive's header is
 * proportionally runaway too.
 */
function validateAppAsar(asarPath) {
  let size;
  try {
    size = fs.statSync(asarPath).size;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(
      `[afterPack] CRITICAL: app.asar could not be read at ${asarPath}: ${msg}. ` +
        "The application archive is missing or unreadable — the package is not shippable."
    );
  }

  if (size > MAX_APP_ASAR_BYTES) {
    throw new Error(
      `[afterPack] CRITICAL: app.asar is ${asMiB(size)} MiB, over the ${asMiB(MAX_APP_ASAR_BYTES)} MiB ceiling. ` +
        "A platform `files` override that does not spread baseFiles() drops the whole " +
        "allowlist and packs the entire source tree (#11475). Path: " +
        asarPath
    );
  }

  let header;
  try {
    header = getRawHeader(asarPath).header;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(
      `[afterPack] CRITICAL: app.asar header could not be parsed at ${asarPath}: ${msg}. ` +
        "The application archive is corrupt — the package is not shippable."
    );
  }

  const roots = Object.keys((header && header.files) || {});
  const unexpected = roots.filter((entry) => !APP_ASAR_ROOT_ENTRIES.includes(entry));
  const missing = APP_ASAR_ROOT_ENTRIES.filter((entry) => !roots.includes(entry));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `[afterPack] CRITICAL: app.asar top-level entries do not match the files allowlist. ` +
        (unexpected.length > 0 ? `Unexpected: ${unexpected.sort().join(", ")}. ` : "") +
        (missing.length > 0 ? `Missing: ${missing.join(", ")}. ` : "") +
        "Unexpected entries mean a platform `files` override stopped spreading baseFiles() " +
        "and electron-builder fell back to packing the source tree (#11475); missing entries " +
        "mean the allowlist dropped something the app needs at runtime. Path: " +
        asarPath
    );
  }

  console.log(
    `[afterPack] app.asar verified: ${asMiB(size)} MiB, ${roots.length} top-level entries`
  );
}

/**
 * Validate better-sqlite3's packaged prebuild. Since v13, better-sqlite3 is an
 * N-API addon loaded from prebuilds/<platform>-<arch>.node shipped inside the
 * package — install-time compilation is suppressed while a prebuild exists, so
 * build/Release/ never contains a binary. N-API is ABI-stable: the same
 * prebuild loads under Node (which runs afterPack) and Electron, so a
 * successful dlopen proves the binary is sound — the same polarity as
 * validateWinJobObjectAbi, and the OPPOSITE of the pre-v13 raw-V8 ABI probe
 * this replaces. The load probe only runs when the prebuild targets the
 * runner's own platform and arch; cross-target packages get a presence check.
 */
function validateBetterSqlitePrebuilds(betterSqlitePath, electronPlatformName, contextArch) {
  for (const arch of getBetterSqlitePrebuildArches(contextArch)) {
    const prebuildPath = path.join(
      betterSqlitePath,
      "prebuilds",
      `${electronPlatformName}-${arch}.node`
    );
    if (!fs.existsSync(prebuildPath)) {
      throw new Error(
        `[afterPack] CRITICAL: better-sqlite3 prebuild not found at ${prebuildPath}. ` +
          "Database functionality will not work. Check that the packaged prebuild " +
          "survived the files/asarUnpack configuration."
      );
    }
    if (electronPlatformName !== process.platform || arch !== process.arch) {
      console.log(`[afterPack] better-sqlite3 prebuild present (cross-target): ${prebuildPath}`);
      continue;
    }
    const testModule = { exports: {} };
    try {
      process.dlopen(testModule, prebuildPath);
      console.log(`[afterPack] better-sqlite3 load check passed: ${prebuildPath}`);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(
        `[afterPack] CRITICAL: better-sqlite3 prebuild failed to load: ${msg}. ` +
          "Database functionality will not work. Path: " +
          prebuildPath
      );
    }
  }
}

/**
 * Validate that win_job_object.node loads with all transitive dependencies
 * resolved. Unlike better-sqlite3, win-job-object is an N-API addon — N-API is
 * ABI-stable (the binary embeds NODE_MODULE_VERSION -1, which Node skips), so a
 * correctly built addon loads under both Node (afterPack) and Electron. A
 * successful dlopen here therefore proves every transitive dependency resolved
 * (e.g. VCRUNTIME140.dll on Windows); a failure means a missing dependency or a
 * wrong-arch binary that would otherwise compile, pack, sign, ship, and
 * silently disable help-session crash-safe reaping (#7526) at first use.
 *
 * The polarity is the OPPOSITE of validateBetterSqliteAbi: there, a successful
 * dlopen under Node means the (NAN/V8-raw) binary was wrongly built for Node;
 * here, a successful dlopen means the (N-API) binary is good. Loading is
 * side-effect-free — the addon's module init only registers exports; the Job
 * Object is created lazily on the first assignProcessToHelpJob call.
 */
function validateWinJobObjectAbi(nativeBinaryPath) {
  const testModule = { exports: {} };
  try {
    process.dlopen(testModule, nativeBinaryPath);
    console.log(
      "[afterPack] win-job-object load check passed (all transitive dependencies resolved)"
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(
      `[afterPack] CRITICAL: win-job-object failed to load: ${msg}. ` +
        "A transitive dependency (e.g. VCRUNTIME140.dll) may be missing or the binary is the wrong arch. " +
        'Run "npm run rebuild" on a Windows runner with VS 2022 Build Tools. Path: ' +
        nativeBinaryPath
    );
  }
}

function getWindowsPackageArch(contextArch) {
  if (contextArch === 0) return "ia32";
  if (contextArch === 1) return "x64";
  if (contextArch === 3) return "arm64";
  return null;
}

function canLoadWindowsPackageNativeAddons(contextArch) {
  const packageArch = getWindowsPackageArch(contextArch);
  return packageArch === null || packageArch === process.arch;
}

/**
 * Whether a packaged binary targets the runner and can therefore be run here.
 *
 * A macOS universal build packs each slice separately before merging, so this
 * hook fires once for the x64 tree and once for the arm64 tree — one of which
 * is always foreign to the runner. Executing that slice fails with EBADARCH
 * ("Unknown system error -86") on a perfectly good package, so the exec probe
 * has to be skipped rather than the build failed. The merged universal binary
 * carries both slices and runs anywhere, so it is still probed.
 *
 * Arch only, not platform: each OS releases from its own runner, so a foreign
 * `electronPlatformName` never reaches this path, while the foreign arch does
 * on every universal build. Mirrors validateBetterSqlitePrebuilds' cross-target
 * skip and canLoadWindowsPackageNativeAddons.
 */
function isRunnerExecutableArch(contextArch) {
  if (contextArch === undefined || contextArch === UNIVERSAL_ARCH) return true;
  return ARCH_ENUM_NAMES[contextArch] === process.arch;
}

/**
 * Validate that the posix-pty-reaper supervisor executable can actually exec —
 * catching a missing shared library, wrong arch, or bad interpreter that the
 * executable-bit check alone misses. The binary takes no flags and blocks
 * reading its stdin until EOF, so we hand it an empty stdin (`input: ""`): it
 * receives an immediate EOF, runs its reap pass over zero registered pids (a
 * no-op, since none were added), and exits 0 in well under a millisecond. A
 * spawn error or non-zero exit means the binary won't run at runtime and
 * help-session crash-safe reaping (#8769) would silently break.
 */
function validatePosixReaperExec(binaryPath) {
  const result = spawnSync(binaryPath, [], {
    input: "",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  });
  if (result.error) {
    throw new Error(
      `[afterPack] CRITICAL: posix-pty-reaper supervisor failed to exec: ${result.error.message}. ` +
        "A shared library may be missing or the binary is the wrong arch. " +
        'Run "npm run rebuild". Path: ' +
        binaryPath
    );
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : "";
    throw new Error(
      `[afterPack] CRITICAL: posix-pty-reaper supervisor exited with status ${result.status}. ` +
        (stderr ? `stderr: ${stderr}. ` : "") +
        'Run "npm run rebuild". Path: ' +
        binaryPath
    );
  }
  console.log("[afterPack] posix-pty-reaper exec check passed");
}

/**
 * Validate that the Silero VAD side-chain's native dependencies (#9177) were
 * unpacked from the ASAR. `onnxruntime-node` ships per-platform native binaries
 * (.node/.dll/.dylib/.so) that require real filesystem access for the N-API
 * load, and `avr-vad` reads its bundled silero_vad_v5.onnx via `fs` relative to
 * its own dir — both must live outside `app.asar`. A missing directory means a
 * broken `asarUnpack` config: VAD-driven segmentation would fall back to the
 * backstop timer for every user. A presence check (not a load probe) keeps this
 * portable across the cross-arch packaging matrix; the app itself degrades
 * gracefully if the runtime load ever fails.
 */
function validateOnnxRuntime(unpackedPath) {
  for (const mod of ["onnxruntime-node", "avr-vad"]) {
    const modPath = path.join(unpackedPath, "node_modules", mod);
    if (!fs.existsSync(modPath)) {
      throw new Error(
        `[afterPack] CRITICAL: ${mod} not found at ${modPath}. ` +
          "Voice VAD segmentation (#9177) will be disabled. Check asarUnpack configuration."
      );
    }
    console.log(`[afterPack] ${mod} verified: ${modPath}`);
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

  // First: every check below reads app.asar.unpacked and stays green on a
  // bloated archive, so a packaging regression would otherwise surface as a
  // signing or notarization failure much later. Deliberately not arch-gated —
  // a mac universal build fires afterPack three times (x64 and arm64
  // intermediates, then the merged output) and the invariant holds for all of
  // them.
  validateAppAsar(getAppAsarPath(appOutDir, electronPlatformName, appName));

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
    // Map `context.arch` (the builder-util `Arch` enum) to the conpty
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
    console.log(`[afterPack] win-job-object verified: ${winJobObjectBinary}`);

    if (canLoadWindowsPackageNativeAddons(context.arch)) {
      validateWinJobObjectAbi(winJobObjectBinary);
    } else {
      console.warn(
        `[afterPack] Skipping win-job-object load check for ${getWindowsPackageArch(
          context.arch
        )} package on ${process.arch} runner`
      );
    }
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
    console.log(`[afterPack] posix-pty-reaper verified: ${posixReaperBinary}`);

    if (isRunnerExecutableArch(context.arch)) {
      validatePosixReaperExec(posixReaperBinary);
    } else {
      console.warn(
        `[afterPack] Skipping posix-pty-reaper exec check for ${ARCH_ENUM_NAMES[context.arch]} slice on ${process.arch} runner`
      );
    }

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

  validateBetterSqlitePrebuilds(betterSqlitePath, electronPlatformName, context.arch);

  console.log(`[afterPack] better-sqlite3 verified: ${betterSqlitePath}`);

  validateOnnxRuntime(unpackedPath);

  console.log("[afterPack] Complete - native modules validated");
};
