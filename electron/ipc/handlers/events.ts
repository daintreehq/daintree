import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { DaintreeEventMap } from "../../services/events.js";
import type { IpcEventBusMap } from "../../../shared/types/ipc/maps.js";
import { broadcastToRenderer, typedHandle } from "../utils.js";

const ALLOWED_RENDERER_EVENTS: ReadonlySet<keyof DaintreeEventMap> = new Set(["action:dispatched"]);

/**
 * Manifest of bridged events. The `satisfies Record<keyof IpcEventBusMap, true>`
 * clause makes tsc fail if `IpcEventBusMap` grows and a key is not added here —
 * forcing the main-side bridge to stay in lockstep with the renderer-facing type.
 */
const EVENT_BUS_BRIDGED_MANIFEST = {
  "agent:state-changed": true,
} as const satisfies Record<keyof IpcEventBusMap, true>;

const EVENT_BUS_BRIDGED_EVENTS = Object.keys(EVENT_BUS_BRIDGED_MANIFEST) as Array<
  keyof IpcEventBusMap
>;

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

  return {
    actionId,
    args: safeArgs,
    source,
    context,
    timestamp,
    category,
    durationMs,
    ...(safeBreadcrumbArgs ? { safeArgs: safeBreadcrumbArgs } : {}),
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

  // Bridge selected TypedEventBus events to the renderer via the multiplexed
  // `events:push` channel. The renderer subscribes via
  // `window.electron.events.on(name, callback)`.
  if (events) {
    for (const name of EVENT_BUS_BRIDGED_EVENTS) {
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
