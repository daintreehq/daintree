import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "../channels.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAPS_TS = path.join(REPO_ROOT, "shared", "types", "ipc", "maps.ts");
const PRELOAD_CTS = path.join(REPO_ROOT, "electron", "preload.cts");

/**
 * IpcInvokeMap keys that intentionally do NOT correspond to a CHANNELS value.
 * Adding a key here should be rare and require a comment in `maps.ts` explaining why.
 */
const INVOKE_MAP_CHANNEL_ALLOWLIST = new Set<string>([]);

/**
 * Strings inside the `IpcInvokeMap` block that are NOT channel names — e.g. literal
 * union members inside `args`/`result` types. The drift scanner works at line
 * granularity and only matches property keys at the left margin (two spaces + quote),
 * but this set is available as an escape hatch if a new spurious match appears.
 */
const INVOKE_MAP_STRING_IGNORE = new Set<string>([]);

/**
 * Extract the `IpcInvokeMap` block from `maps.ts` and return the channel-string
 * literals used as property keys. Greps lines that look like `  "foo:bar": {`.
 */
async function extractInvokeMapKeys(): Promise<string[]> {
  const source = await readFile(MAPS_TS, "utf8");
  const start = source.indexOf("export interface IpcInvokeMap {");
  if (start === -1) throw new Error("Could not locate IpcInvokeMap in maps.ts");
  const end = source.indexOf("\n}", start);
  if (end === -1) throw new Error("Could not locate IpcInvokeMap closing brace");
  const block = source.slice(start, end);

  const keys = new Set<string>();
  for (const line of block.split("\n")) {
    const match = line.match(/^ {2}"([^"]+)":\s*\{\s*$/);
    if (!match) continue;
    const key = match[1]!;
    if (INVOKE_MAP_STRING_IGNORE.has(key)) continue;
    keys.add(key);
  }
  return [...keys];
}

/**
 * Extract the inlined `const CHANNELS = { ... } as const;` block from preload.cts
 * and return its key→value map. The preload copy must mirror channels.ts by hand
 * (per lesson #4893 — the preload is bundled separately so it cannot import).
 */
async function extractPreloadChannels(): Promise<Record<string, string>> {
  const source = await readFile(PRELOAD_CTS, "utf8");
  const start = source.indexOf("const CHANNELS = {");
  if (start === -1) throw new Error("Could not locate inlined CHANNELS in preload.cts");
  const end = source.indexOf("} as const;", start);
  if (end === -1) throw new Error("Could not locate inlined CHANNELS closing brace");
  const block = source.slice(start, end);

  const entries: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^\s{2}([A-Z0-9_]+):\s*"([^"]+)",?\s*$/);
    if (!match) continue;
    entries[match[1]!] = match[2]!;
  }
  return entries;
}

describe("IPC channel drift guardrails", () => {
  it("every IpcInvokeMap key resolves to a declared CHANNELS value", async () => {
    const invokeKeys = await extractInvokeMapKeys();
    const channelValues = new Set<string>(Object.values(CHANNELS));

    expect(invokeKeys.length).toBeGreaterThan(0);

    const orphans = invokeKeys.filter(
      (k) => !channelValues.has(k) && !INVOKE_MAP_CHANNEL_ALLOWLIST.has(k)
    );

    expect(
      orphans,
      "IpcInvokeMap keys without a matching CHANNELS value. Either add the channel " +
        "to electron/ipc/channels.ts or, if intentional, to INVOKE_MAP_CHANNEL_ALLOWLIST " +
        "with a documented reason."
    ).toEqual([]);
  });

  it("preload inline CHANNELS mirrors electron/ipc/channels.ts key-for-key", async () => {
    const preloadChannels = await extractPreloadChannels();
    const canonical = CHANNELS as Readonly<Record<string, string>>;

    const canonicalKeys = new Set(Object.keys(canonical));
    const preloadKeys = new Set(Object.keys(preloadChannels));

    const missingInPreload = [...canonicalKeys].filter((k) => !preloadKeys.has(k));
    const extraInPreload = [...preloadKeys].filter((k) => !canonicalKeys.has(k));

    expect(
      missingInPreload,
      "Channels declared in electron/ipc/channels.ts but missing from the inlined " +
        "CHANNELS object in electron/preload.cts. Add them there too — the preload is " +
        "bundled separately and cannot import at runtime (see lesson #4893)."
    ).toEqual([]);

    expect(
      extraInPreload,
      "Channels present in the preload inline copy but not in electron/ipc/channels.ts. " +
        "Remove them from preload.cts or add them to channels.ts."
    ).toEqual([]);

    const valueMismatches: Array<{ key: string; canonical: string; preload: string }> = [];
    for (const key of canonicalKeys) {
      if (!preloadKeys.has(key)) continue;
      if (canonical[key] !== preloadChannels[key]) {
        valueMismatches.push({
          key,
          canonical: canonical[key]!,
          preload: preloadChannels[key]!,
        });
      }
    }

    expect(
      valueMismatches,
      "Channel string values differ between channels.ts and preload.cts inline copy."
    ).toEqual([]);
  });
});
