import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { DaintreeEventMap } from "../../services/events.js";
import type { IpcEventBusMap } from "../../../shared/types/ipc/maps.js";
import { broadcastToRenderer, typedHandle } from "../utils.js";

const ALLOWED_RENDERER_EVENTS: ReadonlySet<keyof DaintreeEventMap> = new Set(["action:dispatched"]);

/**
 * Manifest classifying how each bus event reaches the renderer.
 *
 * - `"bus"`: relayed here from the main-side `TypedEventBus` (services emit on
 *   `events.emit(name, payload)` and the bridge loop below forwards to every
 *   renderer on `CHANNELS.EVENTS_PUSH`). Must also be a key of `DaintreeEventMap`.
 * - `"external"`: the producer wraps the payload itself and sends on
 *   `CHANNELS.EVENTS_PUSH` via `sendToRenderer`/`webContents.send` (window-scoped)
 *   or `broadcastToRenderer` (global). The bridge loop here does NOT relay these
 *   — double-emission would duplicate renderer delivery.
 *
 * The `satisfies Record<keyof IpcEventBusMap, ...>` clause makes tsc fail if
 * `IpcEventBusMap` grows and a key is not classified here, keeping the main-side
 * bridge in lockstep with the renderer-facing type.
 */
const EVENT_BUS_BRIDGED_MANIFEST = {
  // Agent lifecycle: emitted on TypedEventBus; relayed here.
  "agent:state-changed": "bus",
  // Diagnostic-only: consumed main-side by the event-inspector buffer; the
  // renderer never subscribes, so relaying it to every window was pure waste.
  // Classified "external" to drop it from the relay loop — no producer sends
  // it on EVENTS_PUSH either, so it has no renderer delivery at all.
  "agent:state-transition-dropped": "external",
  "agent:all-clear": "bus",
  "agent:detected": "bus",
  "agent:exited": "bus",
  "agent:fallback-triggered": "bus",

  // Window-scoped events: producers send envelopes directly to the target
  // window's webContents to preserve per-window routing.
  "window:fullscreen-change": "external",
  "window:reclaim-memory": "external",
  "window:destroy-hidden-webviews": "external",
  "window:disk-space-status": "external",
  "window:sample-blink-memory": "external",
  "window:sample-renderer-elu": "external",
  "system:wake": "external",
  "app-agent:dispatch-action-request": "external",
  "app-agent:confirmation-request": "external",
  "plugin-mcp:consent-request": "external",
  "plugin-capability:consent-request": "external",
  "terminal:backend-crashed": "external",
  "terminal:backend-recovering": "external",
  "terminal:backend-ready": "external",
  "watchdog:disabled": "external",
  "watchdog:active": "external",

  // Terminal observability (relayed from TypedEventBus via PtyEventsBridge)
  "terminal:reliability-metric": "bus",
  // Flow-control status reaches the renderer exclusively through the
  // dedicated project-scoped CHANNELS.TERMINAL_STATUS channel; nothing
  // subscribes to the bus relay, which fanned every backpressure transition
  // out to every window. Classified "external" to drop it from the relay
  // loop — it has no EVENTS_PUSH producer, so no renderer delivery at all.
  "terminal:status": "external",

  // Agent session journaled (relayed from TypedEventBus; emitted by the main
  // close paths and bridged from the pty-host's trash-expiry capture)
  "agent-session:recorded": "bus",

  // Global broadcasts emitted externally (no TypedEventBus counterpart).
  "resource:profile-changed": "external",
  "sound:cancel": "external",
  "plugin:actions-changed": "external",
  "plugin:panel-kinds-changed": "external",
  "plugin:toolbar-buttons-changed": "external",
  "plugin:keybindings-changed": "external",
  "plugin:context-menu-items-changed": "external",
  "plugin:agents-changed": "external",
  "plugin:decorations-changed": "external",
  "plugin:panel-badges-changed": "external",
  "plugin:panel-badges-cleared": "external",
  "plugin:provenance-changed": "external",
  "plugin:bg-update-available": "external",
  "run-history:update": "external",
  "plugin:deep-link": "external",
  "terminal:exit": "external",
  "terminal:spawn-result": "external",
} as const satisfies Record<keyof IpcEventBusMap, "bus" | "external">;

const EVENT_BUS_RELAYED_EVENTS = (
  Object.entries(EVENT_BUS_BRIDGED_MANIFEST) as Array<
    [keyof IpcEventBusMap, (typeof EVENT_BUS_BRIDGED_MANIFEST)[keyof IpcEventBusMap]]
  >
)
  .filter(([, mode]) => mode === "bus")
  .map(([name]) => name) as Array<Extract<keyof IpcEventBusMap, keyof DaintreeEventMap>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeJsonSize(value: unknown): number | null {
  try {
    return JSON.stringify(value).length;
  } catch {
    return null;
  }
}

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_ARGS_MAX_BYTES = 1024;

/**
 * Strip a renderer-supplied `safeArgs` blob down to primitives-only with
 * reserved keys removed. The renderer's `ActionService.extractSafeBreadcrumbArgs`
 * already filters by the per-action allowlist; this is a main-process defense
 * in depth — we don't trust the renderer and the main process has no registry
 * to cross-check against.
 */
function sanitizeSafeArgs(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (
      raw === null ||
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean"
    ) {
      result[key] = raw;
    }
  }

  if (Object.keys(result).length === 0) return undefined;
  const size = safeJsonSize(result);
  if (size === null || size > SAFE_ARGS_MAX_BYTES) return undefined;
  return result;
}

function normalizeActionDispatchedPayload(
  payload: unknown
): DaintreeEventMap["action:dispatched"] | null {
  if (!isPlainObject(payload)) return null;

  const actionId = payload.actionId;
  if (typeof actionId !== "string" || !actionId.trim() || actionId.length > 200) return null;

  const source = payload.source;
  if (
    source !== "user" &&
    source !== "keybinding" &&
    source !== "menu" &&
    source !== "agent" &&
    source !== "context-menu"
  ) {
    return null;
  }

  const timestampRaw = payload.timestamp;
  const timestamp =
    typeof timestampRaw === "number" && Number.isFinite(timestampRaw) ? timestampRaw : Date.now();

  const contextRaw = payload.context;
  const context: DaintreeEventMap["action:dispatched"]["context"] = {};
  if (isPlainObject(contextRaw)) {
    if (typeof contextRaw.projectId === "string") context.projectId = contextRaw.projectId;
    if (typeof contextRaw.activeWorktreeId === "string") {
      context.activeWorktreeId = contextRaw.activeWorktreeId;
    }
    if (typeof contextRaw.focusedTerminalId === "string") {
      context.focusedTerminalId = contextRaw.focusedTerminalId;
    }
  }

  const args = payload.args;
  const argsSize = args === undefined ? 0 : safeJsonSize(args);
  const safeArgs =
    args === undefined
      ? undefined
      : argsSize === null
        ? { _redacted: "unserializable" }
        : argsSize > 2048
          ? { _redacted: "payload_too_large", size: argsSize }
          : args;

  const categoryRaw = payload.category;
  const category = typeof categoryRaw === "string" && categoryRaw.length <= 100 ? categoryRaw : "";

  const durationRaw = payload.durationMs;
  const durationMs =
    typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw >= 0
      ? durationRaw
      : 0;

  const safeBreadcrumbArgs = sanitizeSafeArgs(payload.safeArgs);

  const dangerRaw = payload.danger;
  const danger =
    dangerRaw === "safe" || dangerRaw === "confirm" || dangerRaw === "restricted"
      ? dangerRaw
      : "safe";

  const confirmed: boolean | undefined =
    typeof payload.confirmed === "boolean" ? payload.confirmed : undefined;

  // Plugin-action audit fields. Both are renderer-controlled strings crossing
  // a trust boundary, so cap/shape them: `pluginId` to a sane length and
  // `argsHash` to a strict 64-char lowercase-hex SHA-256 digest.
  const pluginIdRaw = payload.pluginId;
  const pluginId =
    typeof pluginIdRaw === "string" && pluginIdRaw.trim().length > 0 && pluginIdRaw.length <= 100
      ? pluginIdRaw
      : undefined;

  const argsHashRaw = payload.argsHash;
  const argsHash =
    typeof argsHashRaw === "string" && /^[0-9a-f]{64}$/.test(argsHashRaw) ? argsHashRaw : undefined;

  return {
    actionId,
    args: safeArgs,
    source,
    context,
    timestamp,
    category,
    durationMs,
    danger,
    ...(safeBreadcrumbArgs ? { safeArgs: safeBreadcrumbArgs } : {}),
    ...(confirmed !== undefined ? { confirmed } : {}),
    ...(pluginId !== undefined ? { pluginId } : {}),
    ...(argsHash !== undefined ? { argsHash } : {}),
  };
}

export function registerEventsHandlers(deps: HandlerDependencies): () => void {
  const { events } = deps;
  const handlers: Array<() => void> = [];

  const handleEventsEmit = async (eventType: string, payload: unknown) => {
    if (!events) {
      console.warn("[IPC] Event bus not available, cannot emit event:", eventType);
      return;
    }

    if (!ALLOWED_RENDERER_EVENTS.has(eventType as keyof DaintreeEventMap)) {
      console.warn("[IPC] Renderer attempted to emit disallowed event:", eventType);
      return;
    }

    if (eventType === "action:dispatched") {
      const normalized = normalizeActionDispatchedPayload(payload);
      if (!normalized) {
        console.warn("[IPC] Invalid action:dispatched payload from renderer");
        return;
      }
      events.emit("action:dispatched", normalized);
      return;
    }

    events.emit(
      eventType as keyof DaintreeEventMap,
      payload as DaintreeEventMap[keyof DaintreeEventMap]
    );
  };
  handlers.push(typedHandle(CHANNELS.EVENTS_EMIT, handleEventsEmit));

  // Bridge events emitted on the main-side `TypedEventBus` to every renderer
  // via the multiplexed `events:push` channel. The renderer subscribes via
  // `window.electron.events.on(name, callback)`.
  //
  // Events marked `"external"` in `EVENT_BUS_BRIDGED_MANIFEST` are NOT relayed
  // here — their producers emit the envelope directly on `CHANNELS.EVENTS_PUSH`
  // via `sendToRenderer` or `broadcastToRenderer`, to preserve window-scoped
  // routing or avoid a `TypedEventBus` hop for channels without a counterpart.
  if (events) {
    for (const name of EVENT_BUS_RELAYED_EVENTS) {
      const unsubscribe = events.on(name, (payload) => {
        broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
          name,
          payload,
        } as { name: typeof name; payload: IpcEventBusMap[typeof name] });
      });
      handlers.push(unsubscribe);
    }
  }

  return () => handlers.forEach((cleanup) => cleanup());
}
