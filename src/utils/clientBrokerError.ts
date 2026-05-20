/**
 * Renderer-side mirror of `BrokerError` (electron/services/rpc/RequestResponseBroker).
 *
 * The `RequestResponseBroker` lives in the main / preload realm. When it
 * rejects a request that crosses the contextBridge boundary (worktree port
 * disconnect, host exit, app shutdown, request timeout), Electron's structured
 * clone strips all custom Error properties — including `name` and `code`.
 * The preload encodes the discriminant into the message prefix
 * `[BrokerError|<code>] <original message>`. This guard decodes that prefix
 * so renderer callers can pattern-match on `code` instead of substring-matching
 * `e.message`.
 *
 * `instanceof ClientBrokerError` is unreliable across realm boundaries — use
 * `isClientBrokerError`.
 */

export type BrokerErrorCode = "HOST_EXITED" | "APP_SHUTDOWN" | "TIMEOUT";

export class ClientBrokerError extends Error {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode, message: string) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    Object.setPrototypeOf(this, ClientBrokerError.prototype);
  }
}

const VALID_CODES: ReadonlySet<BrokerErrorCode> = new Set([
  "HOST_EXITED",
  "APP_SHUTDOWN",
  "TIMEOUT",
]);

const ENCODED_BROKER_ERROR_PATTERN = /^\[BrokerError\|([A-Z_]+)\] (.*)$/s;

function isBrokerErrorCode(value: string): value is BrokerErrorCode {
  return (VALID_CODES as ReadonlySet<string>).has(value);
}

/**
 * Realm-safe guard. Decodes the `[BrokerError|<code>] message` prefix that
 * the preload injects when a broker rejection crosses the contextBridge.
 * As a side effect, restores `name`, `code`, and the cleaned `message` on
 * the caught error so callers can read them directly.
 *
 * Falls back to duck-typing on `name === "BrokerError" && code is BrokerErrorCode`
 * for errors originating inside the renderer realm.
 */
export function isClientBrokerError(e: unknown): e is Error & { code: BrokerErrorCode } {
  if (!(e instanceof Error)) return false;

  // Preferred path: decode the prefix the preload injected.
  const match = ENCODED_BROKER_ERROR_PATTERN.exec(e.message);
  if (match) {
    const rawCode = match[1];
    const originalMessage = match[2];
    if (rawCode === undefined || !isBrokerErrorCode(rawCode)) return false;
    const target = e as Error & { code?: string };
    target.name = "BrokerError";
    target.code = rawCode;
    e.message = originalMessage ?? e.message;
    return true;
  }

  // Same-realm fallback (no contextBridge crossing).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type narrowed by guard checks below
  const candidate = e as { code?: unknown };
  return (
    e.name === "BrokerError" &&
    typeof candidate.code === "string" &&
    isBrokerErrorCode(candidate.code)
  );
}
