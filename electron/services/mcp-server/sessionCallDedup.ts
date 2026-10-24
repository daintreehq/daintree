import {
  MCP_DEDUP_ALLOWLIST,
  MCP_DEDUP_TTL_MS,
  MCP_DEDUP_MAX_ENTRIES_PER_SESSION,
  MCP_DEDUP_KEY_COLLISION_CODE,
  buildToolError,
} from "./shared.js";
import {
  buildDedupKey,
  canonicalArgsHash,
  readDedupCache,
  type CallToolResultLike,
} from "./sessionDedup.js";
import type { SessionStore } from "./sessionStore.js";
import type { CallAuditWriter, CallFacts, CallGate } from "./sessionCallFacts.js";

/**
 * A duplicate of a creation call this session already made, answered without
 * dispatching (#7531): the cached result, the shared in-flight one, or a key
 * collision. Otherwise the key the call registers its own answer under.
 */
export type CallDedupLookup =
  | CallGate<{ readonly dedupKey: string | undefined; readonly argsHash: string | undefined }>
  | { readonly kind: "await"; readonly promise: Promise<CallToolResultLike> };

export function lookupCallDedup(
  sessionStore: Pick<SessionStore, "dedupResultCache" | "dedupInFlight">,
  facts: CallFacts,
  appendAuditRecord: CallAuditWriter
): CallDedupLookup {
  const { sessionId, actionId, args, requestKey, tier, startedAt, capturedTurnId } = facts;
  // Idempotency dedup for the creation-tool allowlist. Same-moment duplicates
  // share the original Promise (singleflight); post-completion duplicates
  // within MCP_DEDUP_TTL_MS return the cached result without redispatching.
  // Keyed by `requestKey` if the caller supplied one, otherwise a hash of
  // `(actionId, args)`. See #7531.
  let dedupKey: string | undefined;
  let argsHash: string | undefined;
  if (MCP_DEDUP_ALLOWLIST.has(actionId)) {
    dedupKey = buildDedupKey(actionId, requestKey, args);
    argsHash = canonicalArgsHash(actionId, args);

    const resultCache = sessionStore.dedupResultCache.get(sessionId);
    if (resultCache) {
      const cachedEntry = readDedupCache(resultCache, dedupKey, Date.now());
      if (cachedEntry) {
        if (cachedEntry.argsHash !== argsHash) {
          try {
            appendAuditRecord({
              toolId: actionId,
              sessionId,
              tier,
              args,
              durationMs: Date.now() - startedAt,
              startedAt,
              outcome: { kind: "collision" },
              capturedTurnId,
            });
          } catch (err) {
            console.error("[MCP] Failed to append audit record:", err);
          }
          return {
            kind: "return",
            result: buildToolError({
              code: MCP_DEDUP_KEY_COLLISION_CODE,
              message:
                "Idempotency key collision: the same requestKey was used with different arguments.",
              details: { actionId, requestKey },
            }),
          };
        }
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            startedAt,
            outcome: { kind: "dedup" },
            capturedTurnId,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
        return { kind: "return", result: cachedEntry.result };
      }
    }

    const inFlightForSession = sessionStore.dedupInFlight.get(sessionId);
    const sharedEntry = inFlightForSession?.get(dedupKey);
    if (sharedEntry) {
      if (sharedEntry.argsHash !== argsHash) {
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            startedAt,
            outcome: { kind: "collision" },
            capturedTurnId,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
        return {
          kind: "return",
          result: buildToolError({
            code: MCP_DEDUP_KEY_COLLISION_CODE,
            message:
              "Idempotency key collision: the same requestKey was used with different arguments.",
            details: { actionId, requestKey },
          }),
        };
      }
      try {
        appendAuditRecord({
          toolId: actionId,
          sessionId,
          tier,
          args,
          durationMs: Date.now() - startedAt,
          startedAt,
          outcome: { kind: "dedup" },
          capturedTurnId,
        });
      } catch (err) {
        console.error("[MCP] Failed to append audit record:", err);
      }
      return { kind: "await", promise: sharedEntry.promise };
    }
  }

  return { kind: "continue", value: { dedupKey, argsHash } };
}

/**
 * Share this call's answer with its duplicates while it runs, and keep it for
 * {@link MCP_DEDUP_TTL_MS} once it succeeds (#7531). `succeeded` is read when
 * the answer settles.
 */
export function registerCallDedup(
  sessionStore: Pick<SessionStore, "dedupResultCache" | "dedupInFlight">,
  sessionId: string,
  dedupKey: string,
  argsHash: string,
  answerPromise: Promise<CallToolResultLike>,
  succeeded: () => boolean
): void {
  let inFlight = sessionStore.dedupInFlight.get(sessionId);
  if (!inFlight) {
    inFlight = new Map();
    sessionStore.dedupInFlight.set(sessionId, inFlight);
  }
  const ownedInFlight = inFlight;
  const cleanupKey = dedupKey;
  const ownedArgsHash = argsHash;
  ownedInFlight.set(cleanupKey, { promise: answerPromise, argsHash: ownedArgsHash });

  answerPromise.then(
    (result) => {
      // Session-liveness guard: drain() clears `dedupInFlight` up-front,
      // so a torn-down session leaves `liveInFlight` undefined and we
      // skip both cleanup and caching. Same protection if the session
      // was recreated under the same id (different Map identity).
      const liveInFlight = sessionStore.dedupInFlight.get(sessionId);
      if (liveInFlight !== ownedInFlight) return;

      ownedInFlight.delete(cleanupKey);
      if (ownedInFlight.size === 0) {
        sessionStore.dedupInFlight.delete(sessionId);
      }

      // Cache only successful results — transient failures must retry.
      if (succeeded()) {
        let cache = sessionStore.dedupResultCache.get(sessionId);
        if (!cache) {
          cache = new Map();
          sessionStore.dedupResultCache.set(sessionId, cache);
        }
        cache.set(cleanupKey, {
          result,
          expiresAt: Date.now() + MCP_DEDUP_TTL_MS,
          argsHash: ownedArgsHash,
        });
        // FIFO-evict the oldest entries when the per-session cap is
        // exceeded. Map iteration is insertion-order, so the first key
        // returned by `.keys()` is the oldest still-living entry.
        while (cache.size > MCP_DEDUP_MAX_ENTRIES_PER_SESSION) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey === undefined) break;
          cache.delete(oldestKey);
        }
      }
    },
    () => {
      const liveInFlight = sessionStore.dedupInFlight.get(sessionId);
      if (liveInFlight !== ownedInFlight) return;
      ownedInFlight.delete(cleanupKey);
      if (ownedInFlight.size === 0) {
        sessionStore.dedupInFlight.delete(sessionId);
      }
    }
  );
}
