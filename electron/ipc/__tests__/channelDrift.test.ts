import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "../channels.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAPS_TS = path.join(REPO_ROOT, "shared", "types", "ipc", "maps.ts");
const GENERATED_TS = path.join(REPO_ROOT, "shared", "types", "ipc", "generated.ts");
const PRELOAD_CTS = path.join(REPO_ROOT, "electron", "preload.cts");

/**
 * IpcInvokeMap keys that intentionally do NOT correspond to a CHANNELS value.
 * Adding a key here should be rare and require a comment in `maps.ts` explaining why.
 */
const INVOKE_MAP_CHANNEL_ALLOWLIST = new Set<string>([]);

/**
 * IpcEventMap keys that intentionally do NOT correspond to a CHANNELS value.
 * Adding a key here should be rare and require a comment in `maps.ts` explaining why.
 */
const EVENT_MAP_CHANNEL_ALLOWLIST = new Set<string>([]);

/**
 * Strings inside the `IpcInvokeMap` block that are NOT channel names — e.g. literal
 * union members inside `args`/`result` types. The drift scanner works at line
 * granularity and only matches property keys at the left margin (two spaces + quote),
 * but this set is available as an escape hatch if a new spurious match appears.
 */
const INVOKE_MAP_STRING_IGNORE = new Set<string>([]);

/**
 * CHANNELS values that intentionally appear in neither IpcInvokeMap nor IpcEventMap.
 *
 * Each entry is one of three legitimate exception categories — keep the inline
 * comment so future readers know why the channel skipped typing:
 *   - `// fire-and-forget` — renderer→main `ipcRenderer.send` (no return value, no
 *     event reply); typing it through IpcInvokeMap would force a Promise round-trip.
 *   - `// raw invoke` — main-side handler is registered with `ipcMain.handle` rather
 *     than `typedHandle*` because the call shape can't be expressed through the
 *     IpcInvokeMap schema (e.g. variadic args, dynamic origin trust, multi-window
 *     bootstrap).
 *   - `// main-internal` — handshake or request/response channel used between main
 *     processes only (no preload surface, no renderer binding).
 *
 * Removing an entry here means: the channel now has a proper map entry. Adding an
 * entry here means: review the channel and pick one of the three categories above,
 * or — preferably — add the missing map entry.
 */
const DEAD_CHANNEL_ALLOWLIST = new Set<string>([
  // fire-and-forget — renderer→main `ipcRenderer.send` reply for the MCP
  // request/response bridge (rendererBridge.ts). Paired with the request event
  // declared in IpcEventMap.
  "app-agent:confirmation-response",
  "app-agent:dispatch-action-response",

  // fire-and-forget — renderer→main `ipcRenderer.send` reveal signal from
  // public/skeleton-ready.js, consumed by a WebContents-scoped `ipc.once`
  // in createWindow.ts loadRenderer.
  "app:skeleton-parsed",
  "mcp:dispatch-action-response",
  "mcp:get-manifest-response",
  "plugin:dispatch-action-response",
  // fire-and-forget — renderer→main `ipcRenderer.send` replies carrying the
  // projected built-in action catalog / single entry (#10561). Paired with the
  // `plugin:actions-list-request` / `plugin:actions-get-request` events declared
  // in IpcEventMap.
  "plugin:actions-list-response",
  "plugin:actions-get-response",
  // fire-and-forget — renderer→main `ipcRenderer.send` reply carrying the user's
  // answer to an imperative plugin UI prompt (#10522). Paired with the
  // `plugin:ui-prompt-request` event declared in IpcEventMap.
  "plugin:ui-prompt-response",

  // fire-and-forget — main→renderer broadcast for in-app demo command
  // forwarding (`sendCommandAndAwait` in handlers/demo.ts). The renderer
  // subscribes through `demo.onExecCommand(channelName, handler)` — a generic
  // bridge wrapper whose channel argument is dynamic, so the preload-on check
  // can't see them. Migration: type each via IpcEventMap once the dynamic
  // dispatch is replaced.
  "demo:capture-chunk",
  "demo:capture-stop",
  "demo:command-done",
  "demo:exec-annotate",
  "demo:exec-dismiss-annotation",
  "demo:exec-dismiss-spotlight",
  "demo:exec-drag",
  "demo:exec-press-key",
  "demo:exec-scroll",
  "demo:exec-spotlight",
  "demo:exec-start-capture",
  "demo:exec-stop-capture",
  "demo:exec-wait-for-idle",
  "demo:exec-send-key-to-terminal",
  "demo:exec-type-in-terminal",

  // fire-and-forget — renderer→main `ipcRenderer.send` handled by
  // `ipcMain.on(CHANNELS.ERROR_RETRY_CANCEL)` in errorHandlers.ts.
  "error:retry-cancel",

  // fire-and-forget — renderer→main subscription toggles for streaming
  // observability channels (event inspector, telemetry preview).
  "event-inspector:subscribe",
  "event-inspector:unsubscribe",
  "telemetry:preview-subscribe",
  "telemetry:preview-unsubscribe",

  // fire-and-forget — renderer→main `ipcRenderer.send` for notification
  // bookkeeping (acknowledge/mute/sync paths in the notification store).
  "notification:session-mute-set",
  "notification:show-native",
  "notification:show-watch",
  "notification:sync-watched",
  "notification:waiting-acknowledge",
  "notification:working-pulse-acknowledge",

  // fire-and-forget — renderer→main perf timeline flush.
  "perf:flush-renderer-marks",

  // fire-and-forget — high-frequency renderer→main terminal input / control
  // path. Typing through IpcInvokeMap would force a Promise round-trip per
  // keystroke; the send-only contract is deliberate.
  "terminal:acknowledge-data",
  "terminal:agent-title-state",
  "terminal:batch-double-escape",
  "terminal:broadcast-write",
  "terminal:input",
  "terminal:resize",
  "terminal:set-activity-tier",
  "terminal:update-observed-title",

  // fire-and-forget — high-frequency renderer→main streaming audio chunks
  // for voice input. Same rationale as the terminal input channels.
  "voice-input:audio-chunk",

  // fire-and-forget — main→renderer broadcast emitted by
  // `WorkspaceHostPool.sendToEntryWindows`. The preload subscribes via a
  // string-literal `"worktree:host-disconnected"` (not `CHANNELS.X`) so the
  // preload-on check can't see it. Migration: switch the preload listener to
  // `_typedOn(CHANNELS.WORKTREE_HOST_DISCONNECTED, …)` and add a matching
  // `IpcEventMap` entry; that lets this entry come out.
  "worktree:host-disconnected",

  // raw invoke — main-side handler uses raw `ipcMain.handle` instead of
  // `typedHandle` (see `RAW_HANDLE_ALLOWLIST` in ipcHandleCoverage.test.ts
  // and the corresponding `PRELOAD_INVOKE_WITHOUT_MAP_ALLOWLIST` below).
  "plugin:invoke",
  "update:dismiss-toast",
  "window:new",
]);

/**
 * Preload `_typedOn` / `ipcRenderer.on` channels that legitimately do not have a
 * corresponding IpcEventMap entry. Should be empty under normal operation; this
 * exists as an escape hatch only.
 */
const PRELOAD_ON_WITHOUT_EVENT_MAP_ALLOWLIST = new Set<string>([]);

/**
 * Preload invoke-style channels (`_unwrappingInvoke`, `ipcRenderer.invoke`) that
 * legitimately do not have a corresponding IpcInvokeMap entry. Used for channels
 * whose main-side handler is registered via raw `ipcMain.handle` (see
 * `RAW_HANDLE_ALLOWLIST` in ipcHandleCoverage.test.ts).
 */
const PRELOAD_INVOKE_WITHOUT_MAP_ALLOWLIST = new Set<string>([
  // plugin:invoke — variadic ...args + senderFrame.url trust check is
  // incompatible with IpcInvokeMap typing; see electron/ipc/handlers/plugin.ts
  // and RAW_HANDLE_ALLOWLIST in ipcHandleCoverage.test.ts.
  "plugin:invoke",

  // update:dismiss-toast — registered via raw `ipcMain.handle` (no typed
  // counterpart yet); see electron/ipc/handlers/update.ts.
  "update:dismiss-toast",

  // window:new — registered via raw `ipcMain.handle` in
  // electron/window/createWindow.ts because the handler needs direct
  // `BrowserWindow` access at multi-window bootstrap time, before the
  // typed-handle infrastructure is wired.
  "window:new",
]);

/**
 * Extract channel-string property keys from a TypeScript interface block.
 * Greps lines that look like `  "foo:bar": {` within the named interface.
 */
function extractKeysFromBlock(source: string, interfaceMarker: string): Set<string> {
  const start = source.indexOf(interfaceMarker);
  if (start === -1) {
    throw new Error(`Could not locate "${interfaceMarker}"`);
  }
  const end = source.indexOf("\n}", start);
  if (end === -1) {
    throw new Error(`Could not locate closing brace for "${interfaceMarker}"`);
  }
  const block = source.slice(start, end);

  const keys = new Set<string>();
  for (const line of block.split("\n")) {
    const match = line.match(/^ {2}"([^"]+)":\s*\{\s*$/);
    if (!match) continue;
    const key = match[1]!;
    if (INVOKE_MAP_STRING_IGNORE.has(key)) continue;
    keys.add(key);
  }
  return keys;
}

/**
 * Extract event-map property keys. Unlike IpcInvokeMap (where every value is an
 * object literal beginning with `{` on the same line), IpcEventMap values can be
 * `Type`, `void`, `Type[]`, tuple syntax, or a brace-opened object — anything
 * after the colon. The regex matches the property-key half only.
 */
function extractEventMapKeys(source: string): Set<string> {
  const start = source.indexOf("export interface IpcEventMap");
  if (start === -1) {
    throw new Error('Could not locate "export interface IpcEventMap"');
  }
  const end = source.indexOf("\n}", start);
  if (end === -1) {
    throw new Error('Could not locate closing brace for "export interface IpcEventMap"');
  }
  const block = source.slice(start, end);

  const keys = new Set<string>();
  for (const line of block.split("\n")) {
    const match = line.match(/^ {2}"([^"]+)":/);
    if (!match) continue;
    keys.add(match[1]!);
  }
  return keys;
}

/**
 * Extract the `IpcEventBusMap` subset — the IpcEventMap keys multiplexed through
 * the single `CHANNELS.EVENTS_PUSH` envelope and dispatched by `name` in the
 * renderer. These names are NOT required to have their own CHANNELS entry; the
 * envelope's `CHANNELS.EVENTS_PUSH` carries them. The drift checks treat the
 * bus members as a separate set so the IpcEventMap→CHANNELS orphan list stays
 * accurate.
 *
 * Parses the `Pick<IpcEventMap, "X" | "Y" | "Z">` union — each `| "key"` line.
 */
function extractEventBusMapKeys(source: string): Set<string> {
  const start = source.indexOf("export type IpcEventBusMap = Pick<");
  if (start === -1) {
    throw new Error('Could not locate "export type IpcEventBusMap = Pick<"');
  }
  const end = source.indexOf(">;", start);
  if (end === -1) {
    throw new Error('Could not locate closing ">;" for IpcEventBusMap Pick<>');
  }
  const block = source.slice(start, end);

  const keys = new Set<string>();
  for (const line of block.split("\n")) {
    const match = line.match(/^\s*\|\s*"([^"]+)"\s*$/);
    if (!match) continue;
    keys.add(match[1]!);
  }
  return keys;
}

/**
 * Extract `IpcInvokeMap` channel keys, taking the union of hand-maintained
 * entries in `maps.ts` and codegen-emitted entries in `generated.ts`. The
 * `IpcInvokeMap` interface extends `GeneratedIpcInvokeMap`, so both
 * contribute keys and either source can drift from `CHANNELS`.
 */
async function extractInvokeMapKeys(): Promise<Set<string>> {
  const mapsSrc = await readFile(MAPS_TS, "utf8");
  const generatedSrc = await readFile(GENERATED_TS, "utf8");
  const handMaintained = extractKeysFromBlock(mapsSrc, "export interface IpcInvokeMap");
  const generated = extractKeysFromBlock(generatedSrc, "export interface GeneratedIpcInvokeMap");
  return new Set<string>([...handMaintained, ...generated]);
}

/**
 * Find every `CALLEE(CHANNELS.MEMBER` occurrence in `source` and resolve each
 * member name to its concrete channel string via the imported `CHANNELS`
 * object. Returns `{ channel, member, line }` per match so failure messages
 * can name both the runtime channel string and the source-level constant.
 *
 * `callees` is a list of bare identifiers (`ipcRenderer.on`, `_typedOn`, etc.);
 * the regex anchors on word boundary + dotted path + `(`.
 *
 * Scans the whole source as one string (not line-by-line) so multi-line call
 * expressions like `_unwrappingInvoke(\n  CHANNELS.WEBVIEW_OAUTH_LOOPBACK,\n
 *   …)` are not silently skipped. `\s` matches newlines in JS regex, so the
 * same pattern works.
 */
function extractChannelCallSites(
  source: string,
  callees: readonly string[]
): Array<{ channel: string; member: string; line: number }> {
  const channelsLookup = CHANNELS as Record<string, string>;
  const calleePattern = callees.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // (?<![\w$.]) ensures we don't match `foo._typedOn(` or `Bar.ipcRenderer.on(`
  // — only the bare wrapper or top-level Electron API. The character class
  // includes `.` so e.g. `ipcRenderer.on` after `something.` is rejected.
  const re = new RegExp(`(?<![\\w$.])(?:${calleePattern})\\s*\\(\\s*CHANNELS\\.(\\w+)`, "g");

  const matches: Array<{ channel: string; member: string; line: number }> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const member = m[1]!;
    // Recover the line number from the match index — splitting up to the
    // match offset and counting newlines is O(n) per match but the source
    // is small (preload is ~1.6k lines) and only runs once at test time.
    const line = source.slice(0, m.index).split("\n").length;
    const channel = channelsLookup[member];
    if (typeof channel !== "string") {
      // Caller resolves these — see `unresolvedMembers()`. We still emit the
      // entry so the test can report the unresolved member with line context.
      matches.push({ channel: "", member, line });
      continue;
    }
    matches.push({ channel, member, line });
  }
  return matches;
}

function uniqueChannels(
  matches: ReadonlyArray<{ channel: string; member: string; line: number }>
): Set<string> {
  const out = new Set<string>();
  for (const m of matches) {
    if (m.channel) out.add(m.channel);
  }
  return out;
}

function unresolvedMembers(
  matches: ReadonlyArray<{ channel: string; member: string; line: number }>
): Array<{ member: string; line: number }> {
  return matches.filter((m) => !m.channel).map((m) => ({ member: m.member, line: m.line }));
}

describe("IPC channel drift guardrails", () => {
  it("every IpcInvokeMap key resolves to a declared CHANNELS value", async () => {
    const invokeKeys = await extractInvokeMapKeys();
    const channelValues = new Set<string>(Object.values(CHANNELS));

    expect(invokeKeys.size).toBeGreaterThan(0);

    const orphans = [...invokeKeys].filter(
      (k) => !channelValues.has(k) && !INVOKE_MAP_CHANNEL_ALLOWLIST.has(k)
    );

    expect(
      orphans,
      "IpcInvokeMap keys without a matching CHANNELS value. Either add the channel " +
        "to electron/ipc/channels.ts or, if intentional, to INVOKE_MAP_CHANNEL_ALLOWLIST " +
        "with a documented reason."
    ).toEqual([]);
  });

  it("no IpcInvokeMap key appears in GeneratedIpcInvokeMap (half-migrated channels)", async () => {
    const mapsSrc = await readFile(MAPS_TS, "utf8");
    const generatedSrc = await readFile(GENERATED_TS, "utf8");
    const handMaintained = extractKeysFromBlock(mapsSrc, "export interface IpcInvokeMap");
    const generated = extractKeysFromBlock(generatedSrc, "export interface GeneratedIpcInvokeMap");

    expect(handMaintained.size).toBeGreaterThan(0);
    expect(generated.size).toBeGreaterThan(0);

    const duplicates = [...handMaintained].filter((k) => generated.has(k)).sort();

    expect(
      duplicates,
      "These channels appear in both IpcInvokeMap (maps.ts) and GeneratedIpcInvokeMap " +
        "(generated.ts). A defineIpcNamespace migration was left half-done — delete the " +
        "hand-written entry from maps.ts once codegen owns the channel, and lower the count " +
        "in ipc-handwritten-baseline.json to match."
    ).toEqual([]);
  });

  it("duplicate guard fires when a hand-written key is re-introduced (negative control)", () => {
    // Proves the intersection logic above would actually catch a regression,
    // independent of the live files' current clean state.
    const mapsSrc = [
      "export interface IpcInvokeMap {",
      '  "project:clone-cancel": {',
      "    args: [];",
      "    result: void;",
      "  };",
      "}",
    ].join("\n");
    const generatedSrc = [
      "export interface GeneratedIpcInvokeMap {",
      '  "project:clone-cancel": {',
      "    args: [];",
      "    result: void;",
      "  };",
      "}",
    ].join("\n");
    const handMaintained = extractKeysFromBlock(mapsSrc, "export interface IpcInvokeMap");
    const generated = extractKeysFromBlock(generatedSrc, "export interface GeneratedIpcInvokeMap");
    const duplicates = [...handMaintained].filter((k) => generated.has(k)).sort();

    expect(duplicates).toEqual(["project:clone-cancel"]);
  });

  it("every IpcEventMap key resolves to a declared CHANNELS value", async () => {
    const mapsSrc = await readFile(MAPS_TS, "utf8");
    const eventKeys = extractEventMapKeys(mapsSrc);
    const busKeys = extractEventBusMapKeys(mapsSrc);
    const channelValues = new Set<string>(Object.values(CHANNELS));

    expect(eventKeys.size).toBeGreaterThan(0);
    expect(busKeys.size).toBeGreaterThan(0);

    // IpcEventBusMap entries ride the multiplexed `CHANNELS.EVENTS_PUSH`
    // envelope and are dispatched by `name` — they don't need their own
    // CHANNELS entry.
    const orphans = [...eventKeys].filter(
      (k) => !channelValues.has(k) && !busKeys.has(k) && !EVENT_MAP_CHANNEL_ALLOWLIST.has(k)
    );

    expect(
      orphans,
      "IpcEventMap keys without a matching CHANNELS value (excluding the IpcEventBusMap " +
        "multiplexed subset). Either add the channel to electron/ipc/channels.ts, add it " +
        "to IpcEventBusMap if it should ride the events:push envelope, or — if intentional — " +
        "add it to EVENT_MAP_CHANNEL_ALLOWLIST with a documented reason."
    ).toEqual([]);
  });

  it("every CHANNELS value appears in IpcInvokeMap or IpcEventMap", async () => {
    const mapsSrc = await readFile(MAPS_TS, "utf8");
    const invokeKeys = await extractInvokeMapKeys();
    const eventKeys = extractEventMapKeys(mapsSrc);
    const typedKeys = new Set<string>([...invokeKeys, ...eventKeys]);

    const channelValues = Object.values(CHANNELS);
    expect(channelValues.length).toBeGreaterThan(0);

    const dead = channelValues
      .filter((v) => !typedKeys.has(v) && !DEAD_CHANNEL_ALLOWLIST.has(v))
      .sort();

    expect(
      dead,
      "CHANNELS values declared in electron/ipc/channels.ts but absent from both " +
        "IpcInvokeMap and IpcEventMap. Either type the channel in shared/types/ipc/maps.ts " +
        "or, if it's a fire-and-forget send / raw invoke / main-internal channel, add it " +
        "to DEAD_CHANNEL_ALLOWLIST with the matching `// fire-and-forget`, `// raw invoke`, " +
        "or `// main-internal` comment."
    ).toEqual([]);
  });

  it("preload event subscriptions reference channels declared in IpcEventMap", async () => {
    const preloadSrc = await readFile(PRELOAD_CTS, "utf8");
    const mapsSrc = await readFile(MAPS_TS, "utf8");
    const eventKeys = extractEventMapKeys(mapsSrc);

    const matches = extractChannelCallSites(preloadSrc, ["_typedOn", "ipcRenderer.on"]);

    const unresolved = unresolvedMembers(matches);
    expect(
      unresolved,
      "preload event subscriptions reference CHANNELS members that don't exist on the " +
        "imported CHANNELS object. Likely a typo in the member name or a recently removed " +
        "channel — fix electron/preload.cts."
    ).toEqual([]);

    const channels = uniqueChannels(matches);
    const orphans = [...channels]
      .filter((c) => !eventKeys.has(c) && !PRELOAD_ON_WITHOUT_EVENT_MAP_ALLOWLIST.has(c))
      .sort();

    expect(
      orphans,
      "preload subscribes via `_typedOn` / `ipcRenderer.on(CHANNELS.X)` to channels not " +
        "declared in IpcEventMap (shared/types/ipc/maps.ts). Add the channel to IpcEventMap " +
        "with its payload type, or — only if structurally exceptional — to " +
        "PRELOAD_ON_WITHOUT_EVENT_MAP_ALLOWLIST with a documented reason."
    ).toEqual([]);
  });

  it("preload invoke calls reference channels declared in IpcInvokeMap", async () => {
    const preloadSrc = await readFile(PRELOAD_CTS, "utf8");
    const invokeKeys = await extractInvokeMapKeys();

    const matches = extractChannelCallSites(preloadSrc, [
      "_unwrappingInvoke",
      "ipcRenderer.invoke",
    ]);

    const unresolved = unresolvedMembers(matches);
    expect(
      unresolved,
      "preload invoke calls reference CHANNELS members that don't exist on the imported " +
        "CHANNELS object. Likely a typo in the member name or a recently removed channel — " +
        "fix electron/preload.cts."
    ).toEqual([]);

    const channels = uniqueChannels(matches);
    const orphans = [...channels]
      .filter((c) => !invokeKeys.has(c) && !PRELOAD_INVOKE_WITHOUT_MAP_ALLOWLIST.has(c))
      .sort();

    expect(
      orphans,
      "preload invokes (`_unwrappingInvoke` / `ipcRenderer.invoke(CHANNELS.X)`) target " +
        "channels not declared in IpcInvokeMap (shared/types/ipc/maps.ts). Add the channel " +
        "to IpcInvokeMap with its `args` and `result` types, or — if the main-side handler " +
        "uses raw `ipcMain.handle` for documented reasons (see RAW_HANDLE_ALLOWLIST in " +
        "ipcHandleCoverage.test.ts) — add it to PRELOAD_INVOKE_WITHOUT_MAP_ALLOWLIST."
    ).toEqual([]);
  });

  it("preload string-literal channels stay in sync with CHANNELS", async () => {
    // A handful of preload listeners use raw string literals instead of
    // `CHANNELS.X` member access — they're outside the static drift scan
    // above. Guard against a typo silently subscribing to a ghost channel
    // by asserting the literal still equals the canonical CHANNELS value.
    const preloadSrc = await readFile(PRELOAD_CTS, "utf8");
    const literalChecks: Array<{ literal: string; constant: string }> = [
      // worktree port disconnect — `WorkspaceHostPool.sendToEntryWindows`
      // pushes on this channel; the preload listener is the only consumer.
      // Migration target: switch to `_typedOn(CHANNELS.WORKTREE_HOST_DISCONNECTED, …)`.
      { literal: '"worktree:host-disconnected"', constant: CHANNELS.WORKTREE_HOST_DISCONNECTED },
    ];
    for (const { literal, constant } of literalChecks) {
      expect(
        preloadSrc.includes(literal),
        `electron/preload.cts is expected to subscribe to the literal ${literal}, ` +
          `which must equal CHANNELS value ${JSON.stringify(constant)}. If the channel ` +
          `string was renamed, update the preload literal — or, preferably, switch the ` +
          `listener to a CHANNELS.* reference so the regex scan catches future drift.`
      ).toBe(true);
      expect(literal.slice(1, -1), `literal ${literal} must equal CHANNELS constant`).toBe(
        constant
      );
    }
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
