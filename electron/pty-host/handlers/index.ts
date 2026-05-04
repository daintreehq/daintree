import type { MessagePort } from "node:worker_threads";
import { createBackpressureHandlers } from "./backpressure.js";
import { createConnectionHandlers } from "./connection.js";
import { createLifecycleHandlers } from "./lifecycle.js";
import { createResourceConfigHandlers } from "./resourceConfig.js";
import { createStateConfigHandlers } from "./stateConfig.js";
import { createTerminalIOHandlers } from "./terminalIO.js";
import { createTerminalQueryHandlers } from "./terminalQueries.js";
import type { HandlerMap, HostContext, PtyHostHandler } from "./types.js";

export type { HandlerMap, HostContext, PtyHostHandler, RendererConnection } from "./types.js";
export { mapTerminalInfo, narrowDetectedAgentId } from "./terminalInfo.js";

/**
 * Build the unified message dispatcher for the pty-host's `port.on("message")`
 * handler. Each handler family exports a `create*Handlers(ctx)` factory; we
 * merge their maps into a single lookup. Unknown message types are logged.
 *
 * The dispatcher itself is synchronous — handlers that perform async work
 * (`graceful-kill`, `wake-terminal`) return a promise that the dispatcher
 * awaits before returning, so the wrapper at the call site can route handler
 * errors through a single `try/catch`. Handlers that intentionally fire and
 * forget (`get-serialized-state`) wrap their work in `void (async () => …)()`
 * internally so the dispatcher does not block on them.
 */
export function createPtyHostMessageDispatcher(
  ctx: HostContext
): (msg: any, ports?: MessagePort[]) => void | Promise<void> {
  // Use a null-prototype map so message types that collide with
  // Object.prototype keys (e.g. "constructor", "toString") fall through to
  // the unknown-message warning rather than silently dispatching to an
  // inherited method. The original switch had no such cases either.
  const handlers: HandlerMap = Object.assign(Object.create(null) as HandlerMap, {
    ...createConnectionHandlers(ctx),
    ...createLifecycleHandlers(ctx),
    ...createTerminalIOHandlers(ctx),
    ...createBackpressureHandlers(ctx),
    ...createTerminalQueryHandlers(ctx),
    ...createStateConfigHandlers(ctx),
    ...createResourceConfigHandlers(ctx),
  });

  return (msg: any, ports?: MessagePort[]) => {
    const type = msg?.type;
    const handler: PtyHostHandler | undefined =
      typeof type === "string" ? handlers[type] : undefined;
    if (!handler) {
      console.warn("[PtyHost] Unknown message type:", type);
      return;
    }
    return handler(msg, ports);
  };
}
