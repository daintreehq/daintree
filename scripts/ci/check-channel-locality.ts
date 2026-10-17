/**
 * Every IPC channel must declare which machine answers it when a window is
 * attached to a remote host (see electron/ipc/channelLocality.ts). CHANNELS is
 * covered by the type system; this check covers channel strings that live
 * elsewhere: the invoke and event maps, and `*.preload.ts` method maps.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "../../electron/ipc/channels.js";
import {
  CHANNEL_LOCALITY,
  NAMESPACE_LOCALITY,
  getChannelLocality,
} from "../../electron/ipc/channelLocality.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const CHANNEL_KEY = /^\s+"([a-z0-9-]+:[a-z0-9:.-]+)"\s*:/gm;
const PRELOAD_VALUE = /:\s*"([a-z0-9-]+:[a-z0-9:.-]+)"/g;

function collect(file: string, re: RegExp): string[] {
  const src = readFileSync(path.join(root, file), "utf8");
  return [...src.matchAll(re)].map((m) => m[1]!);
}

const sources = new Map<string, string>();
for (const file of ["shared/types/ipc/maps.ts", "shared/types/ipc/generated.ts"]) {
  for (const ch of collect(file, CHANNEL_KEY)) sources.set(ch, file);
}
// Typed-bus events multiplexed over events:push, named in the Pick<> union.
{
  const maps = readFileSync(path.join(root, "shared/types/ipc/maps.ts"), "utf8");
  const pick = /export type IpcEventBusMap = Pick<([\s\S]*?)>;/.exec(maps);
  if (!pick) throw new Error("Could not find the IpcEventBusMap Pick<> union in maps.ts");
  for (const m of pick[1]!.matchAll(/"([^"]+)"/g))
    sources.set(m[1]!, "shared/types/ipc/maps.ts (event bus)");
}
const handlersDir = "electron/ipc/handlers";
for (const name of readdirSync(path.join(root, handlersDir))) {
  if (!name.endsWith(".preload.ts")) continue;
  const file = `${handlersDir}/${name}`;
  for (const ch of collect(file, PRELOAD_VALUE)) sources.set(ch, file);
}
for (const ch of Object.values(CHANNELS)) sources.set(ch, "electron/ipc/channels.ts");

// Raw string-literal registrations and sends (most sites use CHANNELS.X,
// which is already covered above).
const RAW_SITE =
  /(?:ipcMain\.(?:on|once|handle|handleOnce)|\.ipc\.(?:on|once|handle|handleOnce)|ipcRenderer\.(?:send|invoke|on|once))\(\s*["'`]([a-z0-9-]+:[a-z0-9:.-]+)["'`]/g;
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(c?ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}
for (const file of walk("electron")) {
  for (const ch of collect(file, RAW_SITE)) sources.set(ch, file);
}

const failures: string[] = [];
for (const [ch, file] of sources) {
  if (getChannelLocality(ch) === null) {
    failures.push(
      `${ch} (${file}) has no locality. Classify it in electron/ipc/channelLocality.ts.`
    );
  }
}

// An exact entry inside a namespace prefix must agree with the namespace.
for (const [ch, locality] of Object.entries(CHANNEL_LOCALITY)) {
  for (const rule of NAMESPACE_LOCALITY) {
    if (ch.startsWith(rule.prefix) && locality !== rule.locality) {
      failures.push(
        `${ch} is classified "${locality}" but its namespace "${rule.prefix}" is "${rule.locality}".`
      );
    }
  }
}
for (const rule of NAMESPACE_LOCALITY) {
  if (!rule.prefix.endsWith(":"))
    failures.push(`Namespace prefix "${rule.prefix}" must end in ":".`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error(`\nchannel locality: ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`[check-channel-locality] OK — ${sources.size} channels classified`);
