/**
 * The one key inside a panel's `extensionState` an external MCP client may
 * write, and the bounds on what it may put there (#12340).
 *
 * The store this reserves already existed — `extensionState` is opaque, capped,
 * merged, and rides the panel record into the layout, so it survives a restart.
 * It was sealed to plugin panels, which left every external orchestrator keeping
 * its own on-disk sidecar mapping panel ids to whatever that panel was for. A
 * sidecar dies with the client process, is invisible to every other client, and
 * silently desynchronises when the user closes a panel — so the association is
 * wrong exactly when a reconnecting client reads it to reconcile.
 *
 * Namespacing is the whole of the isolation, deliberately. Daintree mints one
 * external API key and every client config is built from it, so every external
 * caller hashes to the same bearer entry and there is no durable client identity
 * to scope by. The prior art agrees: Kubernetes annotations and Docker labels
 * are namespaced and globally readable. Two clients driving one Daintree share
 * this bag and see each other's writes; last writer wins.
 */
export const MCP_CLIENT_METADATA_KEY = "mcp";

/**
 * Ceiling on the reserved slice, as serialized JSON bytes.
 *
 * Deliberately far below the 64KB whole-bag cap, for two independent reasons.
 * The bag is shared with panel state this slice must not be able to starve —
 * `presetEnv` already lives there on terminals. And the read rides
 * `terminal.list`, whose response is capped at 50KB by the MCP transport: at
 * 2KB a client can carry correlation state on ~20 terminals and still read them
 * back in a single call, which is the reconcile this feature exists for. What
 * it holds is an association — a session id, a role, a task label — measured in
 * hundreds of bytes, so this is roughly ten times what the use case costs.
 */
export const MAX_CLIENT_METADATA_BYTES = 2 * 1024;

/**
 * Nesting ceiling on the reserved slice.
 *
 * Not a style rule: `buildToolCallTextResult` drops `structuredContent`
 * outright for a payload deeper than `MAX_STRUCTURED_DEPTH` (100), and 2KB of
 * `[[[[…]]]]` nests about a thousand deep. Without this a single pathological
 * value would cost every subsequent listing its structured half — a failure
 * landing on a tool the writer never called. 16 is past anything a correlation
 * record is shaped like and an order of magnitude under the transport's limit.
 */
export const MAX_CLIENT_METADATA_DEPTH = 16;

/** Why a client-metadata write could not be stored. */
export type ClientMetadataRejection =
  | "not-found"
  | "not-eligible"
  | "invalid-json"
  | "too-deep"
  | "metadata-too-large"
  | "state-too-large";

/**
 * Whether a value nests deeper than `MAX_CLIENT_METADATA_DEPTH`.
 *
 * Iterative rather than recursive: the input is caller-supplied, and a
 * thousand-deep array would otherwise blow the stack before the check that
 * exists to reject it could return.
 */
export function exceedsClientMetadataDepth(value: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const current = entry.value;
    if (current === null || typeof current !== "object") continue;
    if (entry.depth > MAX_CLIENT_METADATA_DEPTH) return true;
    for (const child of Object.values(current as Record<string, unknown>)) {
      stack.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return false;
}

/**
 * Narrow a panel's stored reserved slice for the wire.
 *
 * Returns null for anything that is not a plain object, which covers a bag
 * hand-edited on disk as much as one this module never wrote. The caller reads
 * ONLY this key: handing back the whole `extensionState` would put `presetEnv`
 * — a real subprocess environment, session-scoped secrets included — on a
 * listing every external client can call.
 */
export function readClientMetadata(
  extensionState: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  const raw = extensionState?.[MCP_CLIENT_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}
