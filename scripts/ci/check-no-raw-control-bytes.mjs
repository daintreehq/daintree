#!/usr/bin/env node
// Fails when a tracked text file contains a raw C0 control byte other than
// TAB, LF, or CR. A single raw NUL makes ripgrep (and every tool built on it)
// classify the whole file as binary and silently drop every match after the
// byte, which hid thousands of lines from search in #13543. `git grep` only
// sniffs the first 8 KB, so nobody noticed. Write the escape (`\x00`, `\x1b`)
// instead; it produces the identical string.
//
// Binary assets are excluded by extension rather than by sniffing content:
// any content heuristic ("contains a NUL → binary") would exempt exactly the
// files this guard exists to catch, and `.gitattributes` marks some binaries
// (`Assets.car`) as `text: auto`.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export const BINARY_EXTENSIONS = new Set([
  ".car",
  ".gif",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export function isBinaryPath(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Returns `{ line, column, byte }` (1-based line/column) for every raw C0
 * control byte other than TAB (0x09), LF (0x0a), and CR (0x0d) in `buffer`.
 */
export function findControlBytes(buffer) {
  const hits = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte === 0x0a) {
      line++;
      lineStart = i + 1;
      continue;
    }
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0d) {
      hits.push({ line, column: i - lineStart + 1, byte });
    }
  }
  return hits;
}

export function formatByte(byte) {
  return `0x${byte.toString(16).padStart(2, "0")}`;
}

// Paths stay as raw bytes: git allows filenames that are not valid UTF-8, and
// decoding them would point lstat at a different, nonexistent path.
function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const paths = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0) continue;
    if (i > start) paths.push(out.subarray(start, i));
    start = i + 1;
  }
  return paths;
}

function main() {
  let failures = 0;
  let scanned = 0;
  const rootPrefix = Buffer.from(root + path.sep);
  for (const relBytes of listTrackedFiles()) {
    const rel = relBytes.toString("utf8");
    if (isBinaryPath(rel)) continue;
    const abs = Buffer.concat([rootPrefix, relBytes]);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; // tracked but deleted in the working tree
      throw error;
    }
    if (!stat.isFile()) continue; // symlinks, submodule gitlinks
    scanned++;
    for (const hit of findControlBytes(readFileSync(abs))) {
      failures++;
      const escape = `\\x${hit.byte.toString(16).padStart(2, "0")}`;
      console.error(
        `${rel}:${hit.line}:${hit.column}: raw control byte ${formatByte(hit.byte)} — write it as the escape "${escape}"`
      );
    }
  }

  if (failures > 0) {
    console.error(
      `\n${failures} raw control byte(s) in tracked text files. They make ripgrep treat the file as binary and hide its contents from search.` +
        ` If the file is a genuine binary asset, add its extension to BINARY_EXTENSIONS in scripts/ci/check-no-raw-control-bytes.mjs.`
    );
    process.exit(1);
  }

  console.log(
    `[check-control-bytes] OK — ${scanned} tracked text files contain no raw control bytes`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
