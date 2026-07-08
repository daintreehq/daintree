/**
 * PtyHostRpcFacade - Thin wrapper for the repeated
 * `generateId -> register -> send` triad every PtyClient RPC method performs
 * against a {@link PtyShard}'s broker.
 *
 * Deliberately does NOT own fallback/error-handling policy: callers keep
 * their own `.catch()`/`.then()` on the returned promise. Fallback behavior
 * differs per call site (e.g. `PtyClient.gracefulKill`'s forced-kill
 * escalation on a live-host timeout vs. every other method's plain
 * `.catch(() => defaultValue)`), so flattening it into this facade would
 * silently change behavior. See #11007.
 */

import type { PtyHostRequest } from "../../../shared/types/pty-host.js";
import type { RegisterOptions } from "../rpc/index.js";
import type { PtyShard } from "./PtyShard.js";

/**
 * Generate a request id (via `shard.broker.generateId(idSuffix)`), register
 * it with the broker, send the built request, and return the broker's
 * promise. Register-before-send ordering is preserved exactly — the host can
 * resolve synchronously on some paths, so listeners must be live before the
 * message is sent (#5434).
 */
export function sendPtyHostRpc<T>(
  shard: PtyShard,
  idSuffix: string,
  buildRequest: (requestId: string) => PtyHostRequest,
  registerOptions?: RegisterOptions
): Promise<T> {
  const requestId = shard.broker.generateId(idSuffix);
  // Always pass an options object (never omit the arg) to stay on the
  // `options: RegisterOptions` overload — `register<T>(id, {})` normalizes
  // identically to the zero-arg call (both yield method/timeoutMs undefined).
  const promise = shard.broker.register<T>(requestId, registerOptions ?? {});
  shard.send(buildRequest(requestId));
  return promise;
}
