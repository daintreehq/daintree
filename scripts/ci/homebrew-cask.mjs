#!/usr/bin/env node
// Writes the Homebrew cask for one stable macOS release, published to the
// daintreehq/homebrew-tap repo by the release-macos.yml `publish-homebrew-tap`
// job (#16419).
//
// Checksums come from the DMGs served at the public URL, not the build
// artifact: the monotonic gate skips the R2 upload when a version is already
// live, so a re-run of a release tag rebuilds (and re-signs) a DMG whose bytes
// never reach users.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASES_BASE_URL = "https://updates.daintree.org/releases";

// Homebrew's arch names on the left, electron-builder's DMG arch on the right.
// The universal DMG is left out: each Mac gets the build for its own CPU.
export const CASK_ARCHES = { arm: "arm64", intel: "x64" };

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FETCH_TIMEOUT_MS = 10 * 60_000;
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

export function isStableVersion(version) {
  return typeof version === "string" && STABLE_VERSION.test(version);
}

export function assertStableVersion(version) {
  if (!isStableVersion(version)) {
    throw new Error(
      `Homebrew cask version must be a stable X.Y.Z release, got ${JSON.stringify(version)}`
    );
  }
}

export function dmgUrl(version, dmgArch) {
  return `${RELEASES_BASE_URL}/Daintree-${version}-${dmgArch}.dmg`;
}

export function compareVersions(a, b) {
  assertStableVersion(a);
  assertStableVersion(b);
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** The `version "X.Y.Z"` stanza of an existing cask, or null when it has none. */
export function parseCaskVersion(source) {
  const match = /^\s*version\s+"([^"]+)"\s*$/m.exec(source);
  return match ? match[1] : null;
}

export function renderCask({ version, sha256 }) {
  assertStableVersion(version);
  for (const [arch, dmgArch] of Object.entries(CASK_ARCHES)) {
    if (!SHA256.test(sha256?.[dmgArch] ?? "")) {
      throw new Error(`Missing or malformed sha256 for the ${arch} (${dmgArch}) DMG`);
    }
  }

  return `cask "daintree" do
  arch arm: "${CASK_ARCHES.arm}", intel: "${CASK_ARCHES.intel}"

  version "${version}"
  sha256 arm:   "${sha256[CASK_ARCHES.arm]}",
         intel: "${sha256[CASK_ARCHES.intel]}"

  url "${RELEASES_BASE_URL}/Daintree-#{version}-#{arch}.dmg"
  name "Daintree"
  desc "IDE for orchestrating AI coding agents across git worktrees"
  homepage "https://daintree.org/"

  livecheck do
    url "${RELEASES_BASE_URL}/latest-mac.yml"
    strategy :electron_builder
  end

  auto_updates true
  depends_on macos: :ventura

  app "Daintree.app"

  zap launchctl: "org.daintree.app.host",
      trash:     [
        "~/.daintree",
        "~/Library/Application Support/Daintree",
        "~/Library/Caches/daintree-updater",
        "~/Library/Caches/org.daintree.app",
        "~/Library/Caches/org.daintree.app.helper",
        "~/Library/Caches/org.daintree.app.ShipIt",
        "~/Library/HTTPStorages/org.daintree.app",
        "~/Library/HTTPStorages/org.daintree.app.helper",
        "~/Library/LaunchAgents/org.daintree.app.host.plist",
        "~/Library/LaunchAgents/org.daintree.app.schedules.*.plist",
        "~/Library/Logs/Daintree",
        "~/Library/Preferences/org.daintree.app.plist",
        "~/Library/Saved Application State/org.daintree.app.savedState",
        "~/Library/Services/Open in Daintree.workflow",
      ]
end
`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Streams the body through SHA-256, so a 200 MB DMG never sits in memory. */
export async function sha256OfUrl(
  url,
  {
    fetchImpl = globalThis.fetch,
    attempts = FETCH_ATTEMPTS,
    timeoutMs = FETCH_TIMEOUT_MS,
    retryDelayMs = RETRY_DELAY_MS,
  } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // identity: fetch decodes a compressed body, which would make its
      // Content-Length the size of different bytes from the ones hashed.
      const response = await fetchImpl(url, {
        redirect: "follow",
        headers: { "accept-encoding": "identity" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || !response.body) {
        throw new Error(`GET ${url} returned HTTP ${response.status}`);
      }
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.body) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      const encoding = response.headers.get("content-encoding");
      const expected = Number(response.headers.get("content-length"));
      const unencoded = !encoding || encoding === "identity";
      if (unencoded && Number.isFinite(expected) && expected > 0 && bytes !== expected) {
        throw new Error(`GET ${url} ended after ${bytes} of ${expected} bytes`);
      }
      if (bytes === 0) throw new Error(`GET ${url} returned an empty body`);
      return hash.digest("hex");
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(retryDelayMs);
    }
  }
  throw lastError;
}

/**
 * Renders the cask for `version`, hashing each arch's published DMG. Returns
 * `{ written: false }` without hashing anything when the tap already carries a
 * newer version: a re-run of an older release tag must not roll the tap back.
 * An existing cask whose version can't be read is an error rather than
 * something to overwrite, since the tap is then not in a shape this wrote.
 */
export async function generateCask({ version, existing = null, fetchImpl, retryDelayMs }) {
  assertStableVersion(version);
  let existingVersion = null;
  if (existing !== null) {
    existingVersion = parseCaskVersion(existing);
    if (!isStableVersion(existingVersion)) {
      throw new Error(
        `The tap's existing cask has no stable version stanza (found ${JSON.stringify(existingVersion)}); fix it by hand before publishing`
      );
    }
    if (compareVersions(existingVersion, version) > 0) {
      return { written: false, existingVersion, cask: null };
    }
  }

  const sha256 = {};
  for (const dmgArch of Object.values(CASK_ARCHES)) {
    sha256[dmgArch] = await sha256OfUrl(dmgUrl(version, dmgArch), { fetchImpl, retryDelayMs });
  }
  return { written: true, existingVersion, cask: renderCask({ version, sha256 }) };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!["--version", "--out", "--existing"].includes(key) || i + 1 >= argv.length) {
      throw new Error(
        "Usage: homebrew-cask.mjs --version X.Y.Z --out <cask.rb> [--existing <current cask.rb>]"
      );
    }
    args[key.slice(2)] = argv[++i];
  }
  if (!args.version || !args.out) {
    throw new Error("--version and --out are required");
  }
  return args;
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const existing = args.existing ? await readIfPresent(args.existing) : null;
    const result = await generateCask({ version: args.version, existing });
    if (!result.written) {
      console.log(
        `::notice::Homebrew tap already carries daintree ${result.existingVersion}, newer than ${args.version}; leaving it alone.`
      );
      setOutput("written", "false");
      return;
    }
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, result.cask, "utf8");
    setOutput("written", "true");
    console.log(`[homebrew] wrote ${args.out} for daintree ${args.version}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
