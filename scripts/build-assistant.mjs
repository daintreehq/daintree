#!/usr/bin/env node
/**
 * Builds the vendored Daintree Assistant engine (`vendor/daintree-assistant`, a Go
 * submodule) into `resources/assistant/`, from where electron-builder ships it as an
 * extraResource and `resolveAssistantBinary` finds it at runtime.
 *
 * Why a bundled binary rather than a PATH lookup: the assistant IS the product's
 * engine, and its wire protocol moves in lockstep with Daintree's host code. A
 * separately-installed copy on PATH is free to be any version, which is exactly how
 * the v1/v2 protocol skew happened. The submodule SHA pins them together.
 *
 * Why Go is cheap to bundle: the engine is CGO-free (pure-Go SQLite, no cgo deps), so
 * every target cross-compiles from one machine in seconds with no toolchain beyond Go
 * itself. `-ldflags "-s -w"` strips ~38% off the result.
 *
 * Usage:
 *   node scripts/build-assistant.mjs                # host platform
 *   node scripts/build-assistant.mjs --all          # every shipped target
 *   node scripts/build-assistant.mjs --platform darwin --arch arm64
 *   node scripts/build-assistant.mjs --check        # report only, build nothing
 *   node scripts/build-assistant.mjs --dev          # host target, never fatal
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import enginePin from "./assistantEnginePin.cjs";

const { readEnginePin } = enginePin;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUBMODULE = path.join(ROOT, "vendor", "daintree-assistant");
const OUT_DIR = path.join(ROOT, "resources", "assistant");
const CMD_PKG = "./cmd/daintree-assistant";

/** Every target Daintree ships. All are CGO-free, so one runner produces the lot. */
const TARGETS = [
  { platform: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64" },
  { platform: "darwin", arch: "x64", goos: "darwin", goarch: "amd64" },
  { platform: "linux", arch: "x64", goos: "linux", goarch: "amd64" },
  { platform: "linux", arch: "arm64", goos: "linux", goarch: "arm64" },
  { platform: "win32", arch: "x64", goos: "windows", goarch: "amd64" },
  { platform: "win32", arch: "arm64", goos: "windows", goarch: "arm64" },
];

/**
 * The on-disk name for a target's binary. Kept in ONE place because
 * `resolveAssistantBinary` in the main process derives the same name from
 * `process.platform`/`process.arch` — a mismatch is a runtime "binary missing" that
 * only shows up in a packaged build.
 */
export function assistantBinaryName(platform, arch) {
  const ext = platform === "win32" ? ".exe" : "";
  return `daintree-assistant-${platform}-${arch}${ext}`;
}

function log(msg) {
  process.stdout.write(`[assistant] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[assistant] ERROR: ${msg}\n`);
  process.exit(1);
}

function goVersion() {
  const res = spawnSync("go", ["version"], { encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  return res.stdout.trim();
}

function buildTarget({ platform, arch, goos, goarch }, { version }) {
  const outName = assistantBinaryName(platform, arch);
  const outPath = path.join(OUT_DIR, outName);
  const started = Date.now();

  execFileSync(
    "go",
    [
      "build",
      // Strip the symbol table and DWARF. The engine is shipped, not debugged in
      // place — a crash is diagnosed from its own structured debug log, not a
      // backtrace against the packaged binary.
      "-ldflags",
      `-s -w -X main.version=${version}`,
      "-o",
      outPath,
      CMD_PKG,
    ],
    {
      cwd: SUBMODULE,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        // CGO off is load-bearing, not an optimization: it is what makes every
        // target buildable from one machine. Turning it on silently reintroduces a
        // per-platform toolchain requirement.
        CGO_ENABLED: "0",
        GOOS: goos,
        GOARCH: goarch,
      },
    }
  );

  const mb = (statSync(outPath).size / 1048576).toFixed(1);
  log(`${outName.padEnd(42)} ${mb} MB  (${Date.now() - started}ms)`);
  return outPath;
}

/**
 * The version the binary reports: the pinned submodule SHA, plus `-dirty` when the
 * submodule has uncommitted changes.
 *
 * The suffix matters because this string is what the panel's masthead shows and what a
 * pasted transcript is read against. Without it, an engine built from edited sources
 * reports the SHA it was branched from, and two binaries that behave differently claim
 * to be the same build — which is exactly the confusion this whole vendoring scheme
 * exists to prevent.
 *
 * Resolved through `assistantEnginePin.cjs` rather than formatted here, because
 * `afterPack.cjs` reads this same string back out of the binary it is about to package
 * and refuses a mismatch. Two copies of the format would eventually disagree, and the
 * disagreement would read as a stale engine on a build that was perfectly current.
 */
function resolveVersion() {
  const pin = readEnginePin({ root: ROOT, spawnSync });
  // A pin that cannot be read is not fatal here — `--dev` builds from a submodule that
  // is legitimately ahead of the gitlink all day. It is fatal at PACK time, where
  // afterPack says so with the actionable message. `daintree-dev` keeps that build
  // honest in the masthead meanwhile: it names no commit, so it cannot claim one.
  return pin.version ?? "daintree-dev";
}

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check");
  // `--dev` is the same host build, wired into `npm run dev` AND `npm run build` so the
  // engine cannot silently lag the submodule on either path.
  //
  // It exists because it already went wrong: `resources/assistant/` is written only by
  // an explicit `npm run build:assistant`, so moving the submodule and running the app
  // ran the PREVIOUS engine — with the previous engine's bugs — and nothing anywhere
  // said so. The symptom was a fix that had been made, tested and committed still
  // reproducing.
  //
  // Never fatal, because it is now on the path of every `npm run dev` and `npm run
  // build`: a contributor without Go, or one whose submodule is not checked out, gets a
  // warning and the app they asked for. Only a run with NO usable binary at all is worth
  // stopping.
  const dev = argv.includes("--dev");
  const all = argv.includes("--all");
  const platformArg = argv[argv.indexOf("--platform") + 1];
  const archArg = argv[argv.indexOf("--arch") + 1];

  const hostBinary = path.join(OUT_DIR, assistantBinaryName(process.platform, process.arch));
  // In dev, a problem we can degrade around is a warning; the same problem with nothing
  // already built is still fatal, because then the assistant simply will not start and
  // saying so here beats an inscrutable "binary missing" at first use.
  const softFail = (msg) => {
    if (dev && existsSync(hostBinary)) {
      process.stderr.write(`[assistant] ${msg}\n[assistant] keeping the existing build.\n`);
      process.exit(0);
    }
    fail(msg);
  };

  if (!existsSync(path.join(SUBMODULE, "go.mod"))) {
    softFail(
      `vendor/daintree-assistant is not checked out.\n` +
        `  Run: git submodule update --init --recursive`
    );
  }

  const go = goVersion();
  if (!go) {
    softFail(
      "Go is not on PATH. The assistant engine is a Go binary vendored as a submodule.\n" +
        "  macOS: brew install go   |   Linux: https://go.dev/dl/"
    );
  }
  log(go);

  let targets;
  if (all) {
    targets = TARGETS;
  } else {
    const platform = argv.includes("--platform") ? platformArg : process.platform;
    // `--platform` alone means EVERY arch that platform ships, because that is what
    // packaging one platform needs: `--mac` builds arm64, x64 and the universal merge of
    // both, and `--win nsis` builds x64 and arm64. Naming only the host arch there would
    // leave electron-builder to fail on a missing `from:` for the other one — or worse,
    // for `package` to be the only script that ever built the engine, which is how a
    // stale binary reached a release branch. `--arch` narrows it back to one target.
    const arch = argv.includes("--arch")
      ? archArg
      : argv.includes("--platform")
        ? null
        : process.arch;
    targets = TARGETS.filter((t) => t.platform === platform && (arch === null || t.arch === arch));
    if (targets.length === 0) {
      fail(
        `no assistant target for ${platform}/${arch ?? "*"}. Supported: ` +
          TARGETS.map((t) => `${t.platform}/${t.arch}`).join(", ")
      );
    }
  }

  if (checkOnly) {
    for (const t of targets) {
      const p = path.join(OUT_DIR, assistantBinaryName(t.platform, t.arch));
      log(`${existsSync(p) ? "present" : "MISSING"}  ${p}`);
    }
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const version = resolveVersion();
  try {
    for (const t of targets) {
      buildTarget(t, { version });
    }
  } catch (error) {
    // A compile error in the engine must not take `npm run dev` down with it: the app
    // is still runnable against the last good binary, and the Go error is already on
    // stderr above.
    softFail(`build failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  log(`done → ${path.relative(ROOT, OUT_DIR)}`);
}

/** `--clean` removes previously built binaries (used by `npm run clean`). */
if (process.argv.includes("--clean")) {
  rmSync(OUT_DIR, { recursive: true, force: true });
  log("cleaned");
} else {
  main();
}
