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

const ENTRY_RE = /^\s+([A-Z][A-Z0-9_]*):\s+"([^"]+)",?$/gm;

function parseChannels(src, filePath) {
  const map = new Map();
  const re = new RegExp(ENTRY_RE.source, ENTRY_RE.flags);
  let m;
  while ((m = re.exec(src)) !== null) {
    map.set(m[1], m[2]);
  }
  if (map.size === 0) {
    console.error(
      `::error file=${filePath}::parsed zero channel entries — file format may have changed`
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
