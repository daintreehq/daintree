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

  it("preload imports CHANNELS from channels.ts — no hand-maintained inline copy", async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");

    // esbuild bundles the preload, so it can (and must) consume the canonical
    // CHANNELS export from electron/ipc/channels.ts. If the inline copy
    // reappears, drift is possible again. #5691.
    expect(
      source,
      'electron/preload.cts must `import { CHANNELS } from "./ipc/channels.js"` ' +
        "rather than inlining a duplicate CHANNELS declaration."
    ).toMatch(/^import\s*\{[^}]*\bCHANNELS\b[^}]*\}\s*from\s*["']\.\/ipc\/channels\.js["'];?$/m);

    expect(
      /\bconst\s+CHANNELS\s*=\s*\{/.test(source),
      "electron/preload.cts must not declare its own `const CHANNELS = { ... }` — " +
        "the single source of truth lives in electron/ipc/channels.ts."
    ).toBe(false);
  });
});
