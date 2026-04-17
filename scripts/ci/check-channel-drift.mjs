#!/usr/bin/env node
// Verifies the CHANNELS object in electron/preload.cts stays in sync with the
// canonical definition in electron/ipc/channels.ts. The preload ships as
// CommonJS and cannot import from the ESM main process, so its CHANNELS
// block is a hand-maintained inlined copy. Drift here breaks IPC silently:
// a channel added to main but missing from preload throws at runtime the
// first time the renderer calls it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const CHANNELS_FILE = path.join(root, "electron/ipc/channels.ts");
const PRELOAD_FILE = path.join(root, "electron/preload.cts");

// Anchor requires `const CHANNELS = {` at the start of a line (optionally
// prefixed with `export `). This avoids false-matching `CHANNELS = {` inside
// comments (leading `*`), template literals, or string literals.
const CHANNELS_ANCHOR = /(?:^|\n)\s*(?:export\s+)?const\s+CHANNELS\s*=\s*\{/;
const ENTRY_RE = /^\s+([A-Z][A-Z0-9_]*):\s+"([^"]+)",?$/gm;
// Candidate-entry detection: a line inside the CHANNELS body that looks like
// `  IDENT: ...` but didn't match ENTRY_RE. Catches trailing inline comments,
// single-quoted values, template-literal values, or bracketed keys that would
// otherwise be silently skipped.
const CANDIDATE_ENTRY_RE = /^\s+[A-Za-z_[][^:\n]*:/;

// Slice the body of the `CHANNELS = { ... }` object literal out of `src`.
// Walks from the opening `{` to its matching `}`, tracking string/comment state
// so braces inside values or block comments don't throw off the depth counter.
function extractChannelsBody(src, filePath) {
  const anchor = src.match(CHANNELS_ANCHOR);
  if (!anchor) {
    console.error(`::error file=${filePath}::could not locate \`CHANNELS = {\` in source`);
    process.exit(1);
  }
  const openIdx = src.indexOf("{", anchor.index);
  let depth = 1;
  let i = openIdx + 1;
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
    } else if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
    } else if (inString) {
      if (ch === "\\") {
        i++;
      } else if (ch === stringQuote) {
        inString = false;
      }
    } else if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringQuote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
    i++;
  }
  console.error(`::error file=${filePath}::unterminated \`CHANNELS = {\` — missing closing brace`);
  process.exit(1);
}

function parseChannels(src, filePath) {
  const body = extractChannelsBody(src, filePath);
  const map = new Map();
  const re = new RegExp(ENTRY_RE.source, ENTRY_RE.flags);
  let m;
  while ((m = re.exec(body)) !== null) {
    if (map.has(m[1])) {
      console.error(`::error file=${filePath}::duplicate channel key ${m[1]}`);
      process.exit(1);
    }
    map.set(m[1], m[2]);
  }
  // Flag any line that looks like a channel entry but didn't match ENTRY_RE
  // (trailing comments, single quotes, template literals, etc.). Better a
  // loud failure than a silently missed entry.
  const lines = body.split("\n");
  let inBlockComment = false;
  for (const rawLine of lines) {
    let line = rawLine;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      const blockEnd = line.indexOf("*/", blockStart + 2);
      if (blockEnd === -1) {
        line = line.slice(0, blockStart);
        inBlockComment = true;
      } else {
        line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
      }
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    if (!CANDIDATE_ENTRY_RE.test(line)) continue;
    if (!/^\s+([A-Z][A-Z0-9_]*):\s+"([^"]+)",?\s*$/.test(line)) {
      console.error(
        `::error file=${filePath}::unrecognized entry syntax in CHANNELS block: ${rawLine.trim()}`
      );
      process.exit(1);
    }
  }
  if (map.size === 0) {
    console.error(
      `::error file=${filePath}::parsed zero channel entries from CHANNELS block — file format may have changed`
    );
    process.exit(1);
  }
  return map;
}

const channelsMap = parseChannels(readFileSync(CHANNELS_FILE, "utf8"), CHANNELS_FILE);
const preloadMap = parseChannels(readFileSync(PRELOAD_FILE, "utf8"), PRELOAD_FILE);

let failures = 0;

for (const [key, val] of channelsMap) {
  if (!preloadMap.has(key)) {
    console.error(
      `::error file=${PRELOAD_FILE}::missing channel in preload: ${key} (expected "${val}")`
    );
    failures++;
  }
}

for (const [key, val] of preloadMap) {
  if (!channelsMap.has(key)) {
    console.error(
      `::error file=${CHANNELS_FILE}::extra channel in preload (not in channels.ts): ${key} (value "${val}")`
    );
    failures++;
  }
}

for (const [key, val] of channelsMap) {
  const preloadVal = preloadMap.get(key);
  if (preloadVal !== undefined && preloadVal !== val) {
    console.error(
      `::error file=${PRELOAD_FILE}::value mismatch for ${key}: channels.ts="${val}" preload.cts="${preloadVal}"`
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(
    `\nchannel drift detected: ${failures} issue(s). Update electron/preload.cts to match electron/ipc/channels.ts.`
  );
  process.exit(1);
}

console.log(`[check-channel-drift] OK — ${channelsMap.size} channels match`);
