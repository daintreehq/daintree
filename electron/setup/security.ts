import { app, ipcMain, session } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { types as utilTypes } from "node:util";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { classifyPartition } from "../utils/webviewCsp.js";
import {
  wrapSuccess,
  wrapError,
  serializeError,
} from "../../shared/utils/ipcErrorSerialization.js";
import { FAULT_MODE_ENABLED, applyInvokeFault, initFaultRegistry } from "../ipc/faultRegistry.js";
import { markIpcSecurityReady } from "../ipc/ipcGuard.js";
import { notifyIpcEnvelopeRejected } from "../ipc/envelopeRejections.js";
import { channelToCategory, type IpcChannelCategory } from "../ipc/utils.js";
import { AppError } from "../utils/errorTypes.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import { getCurrentCorrelationId } from "../services/TelemetryService.js";
import { PLUGIN_INVOKE_MAX_ARGS_BYTES } from "../../shared/config/pluginBudgets.js";
import {
  PluginPayloadTooLargeError,
  estimatePayloadBytes,
} from "../services/plugin/pluginPayloadLimits.js";

/**
 * Coarse cap on the number of arguments a renderer may pass to a handler in a
 * single `ipcMain.invoke` call. Every typed channel in this codebase passes a
 * single structured object; 8 gives ~4x headroom over the realistic max while
 * still defeating `Array.prototype` poisoning / deep-spread variants that try
 * to overwhelm the handler with thousands of args.
 */
export const MAX_IPC_ARG_COUNT = 8;

/** Bounded allowance over the plugin args cap for `plugin:invoke`'s own metadata. */
export const PLUGIN_INVOKE_ENVELOPE_HEADROOM_BYTES = 64 * 1024;

/**
 * Per-category byte budgets enforced after sender-frame validation, before
 * the listener is invoked. Channels not in {@link channelToCategory} fall back
 * to {@link DEFAULT_PAYLOAD_BUDGET}. `JSON.stringify` is used to estimate UTF-8
 * size (cheaper than `v8.serialize` and the established codebase pattern from
 * `electron/utils/performance.ts`); on failure (circular refs, binary buffers)
 * the check is skipped and Mojo's 128 MiB ceiling acts as the backstop.
 */
export const PAYLOAD_BUDGETS: Record<IpcChannelCategory, number> = {
  fileOps: 4 * 1024 * 1024,
  artifactOps: 4 * 1024 * 1024,
  gitOps: 512 * 1024,
  // Spawn carries env-var dictionaries that can include base64 cert bundles
  // (3–8 KiB each) plus accumulated PATH/HOME/PROXY entries; 256 KiB keeps
  // the budget tight while accommodating realistic project env overrides.
  terminalSpawn: 256 * 1024,
  // The plugin's own args cap plus room for the plugin id, channel name and
  // envelope. The handler enforces the exact args cap; this only stops a
  // payload far past it before the handler runs.
  pluginInvoke: PLUGIN_INVOKE_MAX_ARGS_BYTES + PLUGIN_INVOKE_ENVELOPE_HEADROOM_BYTES,
};

export const DEFAULT_PAYLOAD_BUDGET = 1 * 1024 * 1024;

/**
 * Throws an {@link AppError} with a stable {@link AppErrorCode} when the
 * incoming invoke envelope exceeds the arg-count cap or the per-category byte
 * budget. Caller is expected to call this inside the wrapper's try/catch so
 * the existing prod-strip path serialises the error.
 *
 * @internal Exported for testing.
 */
/**
 * Detect values whose JSON-stringified size is an unreliable proxy for the
 * structured-clone wire size, so the byte gate can skip them and defer to
 * Mojo's 128 MiB ceiling. Catches binary buffers (`{"0":...}` overestimates),
 * `Map`/`Set` (serialise to `{}`, underestimates), and walks plain objects
 * and arrays so a buffer nested inside `{ blob: new Uint8Array(...) }` is
 * still caught. Depth-bounded to keep the check cheap on legitimate payloads.
 *
 * @internal Exported for testing.
 */
export function containsBinary(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (value === null || typeof value !== "object") return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (value instanceof Map || value instanceof Set) return true;
  if (Array.isArray(value)) return value.some((v) => containsBinary(v, depth + 1));
  for (const key of Object.keys(value)) {
    if (containsBinary((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

// JSON.stringify throws on BigInt; coerce to string so a single `1n` slipped
// into args cannot silently defeat the byte gate.
function bigintSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// Sentinel thrown from `sizeGuardReplacer` to abort the measuring stringify
// the moment a binary/Map/Set value is encountered — the same payload classes
// `containsBinary` names, detected during the single serialization pass
// instead of a separate pre-walk over every invoke's arguments.
const UNRELIABLE_SIZE_SENTINEL = Symbol("unreliable-json-size");

function sizeGuardReplacer(key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    if (
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer ||
      value instanceof Map ||
      value instanceof Set
    ) {
      throw UNRELIABLE_SIZE_SENTINEL;
    }
  }
  return bigintSafeReplacer(key, value);
}

// Upper bounds on the UTF-8 bytes a value contributes to `JSON.stringify`
// output. A UTF-16 code unit serialises to at most 6 bytes (`\u001f` for
// control characters, `\ud800` for lone surrogates); every other unit is at
// most 3 (a surrogate pair is 4 bytes over 2 units). The longest `String(n)`
// for a finite number is 25 characters (`-0.0000012345678901234567`); NaN and
// Infinity serialise as `null`.
const MAX_JSON_BYTES_PER_CODE_UNIT = 6;
// Without the units this matches — `\uXXXX`-escaped controls and any
// surrogate — every unit is at most 3 bytes: short escapes (`\n`, `\"`, `\\`)
// are 2, U+0080–U+07FF are 2, the rest of the BMP is 3. Only tried on strings
// too long for the 6-byte bound, where the native scan is far cheaper than
// stringify.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const WIDE_JSON_CODE_UNIT = /[\x00-\x07\x0b\x0e-\x1f\ud800-\udfff]/;
const NARROW_MAX_JSON_BYTES_PER_CODE_UNIT = 3;
const MAX_JSON_NUMBER_BYTES = 25;
const FAST_PATH_MAX_DEPTH = 64;

const { isProxy, isBoxedPrimitive } = utilTypes;

/**
 * Budget left after charging `value` its worst-case serialised size, or a
 * negative number when the walk cannot prove the payload fits: the bound
 * crossed the budget, or the value is not plain JSON data (BigInt, symbol,
 * function, Proxy, boxed primitive, anything with a `toJSON`, a prototype
 * other than Object/Array/null, an array hole, or nesting past
 * {@link FAST_PATH_MAX_DEPTH}, which also stops cycles).
 *
 * The walk reads exactly what `JSON.stringify` reads, in the same order —
 * own enumerable string keys, array indices up to `length` — and its checks
 * run no user code. The only user code it can reach is an own accessor
 * property, which structured-clone deserialisation never produces (it
 * materialises data properties), so for IPC arguments the walk sees the same
 * values the exact measurement would. Like that measurement, it trusts the
 * main process's built-ins (`RegExp`, `Object`, `Array`) to be untampered.
 */
function budgetRemainingAfter(value: unknown, remaining: number, depth: number): number {
  switch (typeof value) {
    case "string": {
      const wide = remaining - (value.length * MAX_JSON_BYTES_PER_CODE_UNIT + 2);
      if (wide >= 0) return wide;
      const narrow = remaining - (value.length * NARROW_MAX_JSON_BYTES_PER_CODE_UNIT + 2);
      return narrow >= 0 && !WIDE_JSON_CODE_UNIT.test(value) ? narrow : -1;
    }
    case "number":
      return remaining - MAX_JSON_NUMBER_BYTES;
    case "boolean":
      return remaining - 5;
    case "undefined":
      return remaining - 4;
    case "object":
      break;
    default:
      return -1;
  }
  if (value === null) return remaining - 4;
  if (depth >= FAST_PATH_MAX_DEPTH || isProxy(value) || "toJSON" in value) return -1;

  const proto: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) return -1;
    const length = value.length;
    // Brackets plus one comma per element (one more than needed).
    remaining -= 2 + length;
    for (let i = 0; i < length && remaining >= 0; i++) {
      // A hole reads through the prototype chain; leave it to the exact path
      // rather than reach inherited getters or traps.
      if (!Object.hasOwn(value, i)) return -1;
      remaining = budgetRemainingAfter(value[i], remaining, depth + 1);
    }
    return remaining;
  }
  if ((proto !== Object.prototype && proto !== null) || isBoxedPrimitive(value)) return -1;
  const keys = Object.keys(value);
  // Braces, plus per entry: key quotes, colon and comma. Entries whose value
  // stringify omits (undefined) are still charged.
  remaining -= 2 + keys.length * 4;
  for (let i = 0; i < keys.length && remaining >= 0; i++) {
    const key = keys[i];
    remaining -= key.length * MAX_JSON_BYTES_PER_CODE_UNIT;
    if (remaining < 0) break;
    remaining = budgetRemainingAfter((value as Record<string, unknown>)[key], remaining, depth + 1);
  }
  return remaining;
}

/**
 * True when `args` provably serialises to at most `budget` UTF-8 bytes, so the
 * exact `JSON.stringify` measurement can be skipped. False means only
 * "inconclusive" — the caller must fall back to the exact path.
 *
 * @internal Exported for testing.
 */
export function isProvablyWithinPayloadBudget(args: unknown[], budget: number): boolean {
  try {
    return budgetRemainingAfter(args, budget, 0) >= 0;
  } catch {
    // Only reachable through an own accessor or an uninitialised module
    // binding; the exact path keeps the old fail-open handling for those.
    return false;
  }
}

export function validateIpcInvokeEnvelope(channel: string, args: unknown[]): void {
  if (args.length > MAX_IPC_ARG_COUNT) {
    throw new AppError({
      code: "ARG_COUNT_EXCEEDED",
      message: `IPC argument count exceeded for ${channel}: ${args.length} > ${MAX_IPC_ARG_COUNT}`,
      userMessage: "Request rejected — too many arguments.",
      context: { channel, argCount: args.length, maxArgCount: MAX_IPC_ARG_COUNT },
    });
  }

  const category = channelToCategory[channel];
  const budget = category !== undefined ? PAYLOAD_BUDGETS[category] : DEFAULT_PAYLOAD_BUDGET;

  if (category === "pluginInvoke") {
    validatePluginInvokeEnvelope(args, budget);
    return;
  }

  // Structured-clone payloads are almost always small plain data; a bounded
  // walk proves most of them fit without building the JSON string. When it
  // cannot, the exact measurement below runs exactly as before.
  if (isProvablyWithinPayloadBudget(args, budget)) return;

  // Binary / Map / Set payloads make `JSON.stringify` an unreliable size
  // estimator: the replacer aborts the measuring pass on the first one (or on
  // stringify's own failures, e.g. circular refs), skipping the byte check so
  // Mojo's 128 MiB ceiling and the handler-level caps (clipboard PNG,
  // artifact patch) act as the backstop. Folding detection into the
  // serialization avoids a separate `containsBinary` pre-walk. Unlike the old
  // pre-walk's depth>32 bail-out (which SKIPPED the byte gate, letting a
  // deeply nested oversize payload through unmeasured), deep plain objects are
  // now measured
  // like wide ones always were; past V8's recursion limit stringify throws
  // and the catch below fails open, same as before.
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(args, sizeGuardReplacer), "utf8");
  } catch {
    return;
  }

  if (bytes > budget) {
    throw new AppError({
      code: "PAYLOAD_TOO_LARGE",
      message: `IPC payload too large for ${channel}: ${bytes} > ${budget} bytes`,
      userMessage: "Request rejected — payload exceeds the allowed size.",
      context: { channel, bytes, budget, category: category ?? null },
    });
  }
}

/** Longest plugin id or channel name echoed back in an envelope rejection. */
const MAX_ECHOED_NAME_LENGTH = 256;

function echoedName(value: unknown): string {
  return typeof value === "string" && value.length <= MAX_ECHOED_NAME_LENGTH ? value : "<unknown>";
}

/**
 * `plugin:invoke` is measured with the same structural estimator the handler
 * applies to the plugin's args (bounded work, binary data counted rather than
 * skipped), and rejected with the error plugin code already handles: an
 * `AppError` would reach the plugin as the renderer's encoded
 * `[AppError|PAYLOAD_TOO_LARGE|…]` prefix, while this message is readable as is.
 */
function validatePluginInvokeEnvelope(args: unknown[], budget: number): void {
  const bytes = estimatePayloadBytes(args, budget);
  if (bytes <= budget) return;
  throw new PluginPayloadTooLargeError(
    echoedName(args[0]),
    `arguments to "${echoedName(args[1])}"`,
    budget,
    bytes
  );
}

function sanitizePaths(msg: string): string {
  return msg
    .replace(/\/(?:Users|home|tmp|private|var)\/[^\s:]+/gi, "<path>")
    .replace(/[A-Z]:[/\\](?:Users|Program Files|Windows|ProgramData)[^\s:]*/gi, "<path>")
    .replace(/\\\\(?:[^\s\\]+)\\(?:[^\s:]+)/g, "<path>");
}

/**
 * @internal Exported for testing. Strip filesystem paths and pattern-known
 * secret sigils from an IPC error message before it leaves the main process.
 * Path normalization runs first so a token embedded inside a path is still
 * caught after the path is collapsed to `<path>`.
 */
export function sanitizeErrorForRenderer(msg: string): string {
  return scrubSecrets(sanitizePaths(msg));
}

// Wrap ipcMain.handle globally to enforce sender validation on ALL IPC handlers
// This must run before any handlers are registered
/** {@link validateIpcInvokeEnvelope}, telling the channel's rejection observer when it refuses. */
function validateEnvelopeObserved(
  channel: string,
  event: IpcMainInvokeEvent,
  args: unknown[]
): void {
  try {
    validateIpcInvokeEnvelope(channel, args);
  } catch (error) {
    notifyIpcEnvelopeRejected(channel, event, args, error);
    throw error;
  }
}

export function enforceIpcSenderValidation(): void {
  if (FAULT_MODE_ENABLED) initFaultRegistry();

  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = ipcMain.handleOnce?.bind(ipcMain);

  ipcMain.handle = function (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown
  ) {
    return originalHandle(channel, async (event, ...args) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        return wrapError(
          new Error(
            `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
          )
        );
      }
      try {
        validateEnvelopeObserved(channel, event, args);
        if (FAULT_MODE_ENABLED) {
          const stub = await applyInvokeFault(channel);
          if (stub) return wrapSuccess(stub.value);
        }
        const result = await listener(event, ...args);
        return wrapSuccess(result);
      } catch (error) {
        if (app.isPackaged) {
          const correlationId = getCurrentCorrelationId();
          console.error(`[IPC] Error on channel ${channel} [${correlationId}]:`, error);
          const serialized = serializeError(error);
          if (correlationId !== undefined) {
            serialized.correlationId = correlationId;
          }
          serialized.message = sanitizeErrorForRenderer(serialized.message);
          if (typeof serialized.userMessage === "string") {
            serialized.userMessage = sanitizeErrorForRenderer(serialized.userMessage);
          }
          serialized.stack = undefined;
          serialized.path = undefined;
          serialized.context = undefined;
          serialized.cause = undefined;
          serialized.properties = undefined;
          return { __daintreeIpcEnvelope: true as const, ok: false as const, error: serialized };
        }
        return wrapError(error);
      }
    });
  } as typeof ipcMain.handle;

  if (originalHandleOnce) {
    ipcMain.handleOnce = function (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown
    ) {
      return originalHandleOnce(channel, async (event, ...args) => {
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
          return wrapError(
            new Error(
              `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
            )
          );
        }
        try {
          validateEnvelopeObserved(channel, event, args);
          if (FAULT_MODE_ENABLED) {
            const stub = await applyInvokeFault(channel);
            if (stub) return wrapSuccess(stub.value);
          }
          const result = await listener(event, ...args);
          return wrapSuccess(result);
        } catch (error) {
          if (app.isPackaged) {
            const correlationId = getCurrentCorrelationId();
            console.error(`[IPC] Error on channel ${channel} [${correlationId}]:`, error);
            const serialized = serializeError(error);
            if (correlationId !== undefined) {
              serialized.correlationId = correlationId;
            }
            serialized.message = sanitizeErrorForRenderer(serialized.message);
            if (typeof serialized.userMessage === "string") {
              serialized.userMessage = sanitizeErrorForRenderer(serialized.userMessage);
            }
            serialized.stack = undefined;
            serialized.path = undefined;
            serialized.context = undefined;
            serialized.cause = undefined;
            serialized.properties = undefined;
            return { __daintreeIpcEnvelope: true as const, ok: false as const, error: serialized };
          }
          return wrapError(error);
        }
      });
    } as typeof ipcMain.handleOnce;
  }

  // Extend validation to ipcMain.on (fire-and-forget channels like terminal:input).
  // Unlike handle channels which can throw, on channels silently drop untrusted messages.
  // We maintain a listener map so removeListener/off can find wrapped versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC listeners have heterogeneous signatures
  type IpcOnListener = (...args: any[]) => void;
  const onListenerMap = new Map<string, Map<IpcOnListener, IpcOnListener>>();

  const originalOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = function (channel: string, listener: IpcOnListener) {
    const wrapped = (event: Electron.IpcMainEvent, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        console.warn(
          `[IPC] Rejected ipcMain.on message from untrusted origin: channel=${channel}, url=${senderUrl || "unknown"}`
        );
        return;
      }
      return listener(event, ...args);
    };

    if (!onListenerMap.has(channel)) onListenerMap.set(channel, new Map());
    onListenerMap.get(channel)!.set(listener, wrapped);

    return originalOn(channel, wrapped);
  } as typeof ipcMain.on;

  const originalRemoveListener = ipcMain.removeListener.bind(ipcMain);
  ipcMain.removeListener = function (channel: string, listener: IpcOnListener) {
    const channelMap = onListenerMap.get(channel);
    const wrapped = channelMap?.get(listener);
    if (wrapped) {
      channelMap!.delete(listener);
      if (channelMap!.size === 0) onListenerMap.delete(channel);
      return originalRemoveListener(channel, wrapped as IpcOnListener);
    }
    return originalRemoveListener(channel, listener);
  } as typeof ipcMain.removeListener;

  ipcMain.off = ipcMain.removeListener;

  const originalRemoveAllListeners = ipcMain.removeAllListeners.bind(ipcMain);
  ipcMain.removeAllListeners = function (channel?: string) {
    if (channel !== undefined) {
      onListenerMap.delete(channel);
    } else {
      onListenerMap.clear();
    }
    return originalRemoveAllListeners(channel);
  } as typeof ipcMain.removeAllListeners;

  console.log("[MAIN] IPC sender validation enforced globally (handle + on)");
  markIpcSecurityReady();
}

/**
 * Log a permission denial for debugging.
 * Uses [SECURITY] prefix to distinguish from general [MAIN] logs.
 */
function logPermissionDenial(
  sessionLabel: string,
  handler: "request" | "check",
  permission: string,
  requestingUrl?: string
): void {
  const url = requestingUrl || "unknown";
  console.warn(
    `[SECURITY] Permission denied: ${permission} (session=${sessionLabel}, handler=${handler}, url=${url})`
  );
}

// Electron 41 permission types (from electron.d.ts) — kept as reference for auditing.
// setPermissionRequestHandler: clipboard-read, clipboard-sanitized-write, display-capture,
//   fullscreen, geolocation, idle-detection, media, mediaKeySystem, midi, midiSysex,
//   notifications, pointerLock, keyboardLock, openExternal, speaker-selection,
//   storage-access, top-level-storage-access, window-management, unknown, fileSystem
// setPermissionCheckHandler: clipboard-read, clipboard-sanitized-write, geolocation,
//   fullscreen, hid, idle-detection, media, mediaKeySystem, midi, midiSysex,
//   notifications, openExternal, pointerLock, serial, storage-access,
//   top-level-storage-access, usb, deprecated-sync-clipboard-read, fileSystem

const TRUSTED_SESSION_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "clipboard-read",
  "media",
]);

const PORTAL_SESSION_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

let permissionLockdownInitialized = false;

export function setupPermissionLockdown(): void {
  function lockdownUntrustedPermissions(ses: Electron.Session, label: string): void {
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      logPermissionDenial(label, "request", permission, details?.requestingUrl);
      callback(false);
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      logPermissionDenial(label, "check", permission, requestingOrigin);
      return false;
    });
  }

  function lockdownTrustedPermissions(
    ses: Electron.Session,
    label: string,
    allowed: Set<string>
  ): void {
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const granted = allowed.has(permission);
      if (!granted) {
        logPermissionDenial(label, "request", permission, details?.requestingUrl);
      }
      callback(granted);
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      const granted = allowed.has(permission);
      if (!granted) {
        logPermissionDenial(label, "check", permission, requestingOrigin);
      }
      return granted;
    });
  }

  // Lock down default session (trusted app renderer) with clipboard + media allowlist
  lockdownTrustedPermissions(session.defaultSession, "default", TRUSTED_SESSION_PERMISSIONS);

  // Browser sessions (persist:browser-*) are now per-project and created lazily at
  // will-attach-webview time, so they are locked down by the session-created handler
  // below (which classifies them as "browser" and applies the untrusted lockdown)
  // rather than eagerly here.

  // Portal needs clipboard access for AI chat copy buttons (navigator.clipboard.writeText)
  // but all other permissions (camera, mic, geolocation, etc.) remain denied
  lockdownTrustedPermissions(
    session.fromPartition("persist:portal"),
    "portal",
    PORTAL_SESSION_PERMISSIONS
  );

  // Shared project session — all project views share this single partition for V8 code cache reuse
  lockdownTrustedPermissions(
    session.fromPartition("persist:daintree"),
    "daintree-app",
    TRUSTED_SESSION_PERMISSIONS
  );

  // Catch dynamically created sessions (e.g., persist:browser-*, persist:dev-preview-*)
  // Guard against duplicate listeners when createWindow is called multiple times (macOS dock)
  if (!permissionLockdownInitialized) {
    permissionLockdownInitialized = true;
    app.on("session-created", (ses) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron typing gap: Session.partition is not exposed
      const partition: string = (ses as any).partition ?? "";
      const type = classifyPartition(partition);
      if (type === "project" || type === "portal") {
        return; // already statically locked down above
      }
      lockdownUntrustedPermissions(ses, partition);
      console.log(`[SECURITY] Default-locked new session partition: ${partition || "(none)"}`);
    });
  }
}

/** @internal Reset idempotency guard for testing only. */
export function _resetPermissionLockdownForTesting(): void {
  permissionLockdownInitialized = false;
}
