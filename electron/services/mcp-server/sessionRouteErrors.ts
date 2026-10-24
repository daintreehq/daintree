import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { SESSION_BINDING_GONE, SESSION_GONE, buildMcpErrorPayload } from "./shared.js";
import { McpRouteBindingError } from "./rendererBridge.js";
import { createLogger } from "../../utils/logger.js";
import { createKeyedLogLimiter } from "../../utils/keyedLogLimiter.js";

const bindingLogger = createLogger("main:McpSessionServer");
const bindingGoneLogLimiter = createKeyedLogLimiter();

/**
 * Refusal for a request whose session no longer exists (#11799). Static, and
 * names the only recovery there is: nothing about this session can be retried,
 * so a client must open a new one.
 */
export const SESSION_GONE_MESSAGE =
  "This MCP session is no longer active. Reconnect to start a new session before retrying.";

/**
 * The `McpError` form of {@link SESSION_GONE_MESSAGE}, for the request paths
 * that signal failure by throwing (discovery and resources) rather than by
 * returning an `isError` tool result. `InternalError` matches how the sibling
 * structural failure `SESSION_BINDING_GONE` is already raised on `tools/list`,
 * so a client reads one JSON-RPC shape for both — the `data.code` is what
 * separates them.
 */
export function sessionGoneError(): McpError {
  return new McpError(
    ErrorCode.InternalError,
    SESSION_GONE_MESSAGE,
    buildMcpErrorPayload({ code: SESSION_GONE, message: SESSION_GONE_MESSAGE })
  );
}

/**
 * The code a route-binding failure reaches the client as, noted in the log on
 * the way: the client's own transcript is otherwise the only place a refusal
 * like this shows. A session retrying one call logs it once a window.
 */
export function bindingGoneCode(err: McpRouteBindingError): typeof SESSION_BINDING_GONE {
  const suppressedCount = bindingGoneLogLimiter.take(`${err.constructor.name}:${err.retriable}`);
  if (suppressedCount !== null) {
    bindingLogger.info("MCP session binding is gone", {
      code: SESSION_BINDING_GONE,
      kind: err.constructor.name,
      retriable: err.retriable,
      suppressedCount,
    });
  }
  return SESSION_BINDING_GONE;
}

/**
 * The structured envelope a route-binding failure must reach the client as
 * (#12082).
 *
 * `McpRouteBindingError` is one of ours: it carries a string `code` and no
 * `data`, and the SDK only preserves numeric codes and explicit `error.data`,
 * so letting one escape a handler serializes it as a bare `-32603` with the
 * `SESSION_BINDING_GONE` reason and the `retriable` verdict both stripped. Every
 * surface that can raise one converts it here, so a client reads one shape
 * whichever request hit it.
 */
export function routeBindingMcpError(err: unknown): McpError | null {
  if (!(err instanceof McpRouteBindingError)) return null;
  return new McpError(
    ErrorCode.InternalError,
    err.message,
    buildMcpErrorPayload({
      code: bindingGoneCode(err),
      message: err.message,
      retriable: err.retriable,
    })
  );
}
