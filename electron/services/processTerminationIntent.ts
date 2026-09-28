/**
 * Daintree signals its own children too — dispose backstops, health-check
 * force-kills, force-restarting an unresponsive view. Owners note the intent
 * just before signalling, so the resulting `killed` death is attributed to
 * Daintree instead of reading as an external kill. Utility processes are
 * keyed by service name (`child-process-gone` carries no pid), renderers by
 * webContents id, which survives the renderer's death and reload.
 */
const INTENT_TTL_MS = 10_000;
const SETTLED_GRACE_MS = 2_000;

type Target = { serviceName: string } | { webContentsId: number };

const intents = new Map<string, { reason: string; at: number }>();

function keyOf(target: Target): string {
  return "serviceName" in target
    ? `utility:${target.serviceName}`
    : `renderer:${target.webContentsId}`;
}

export function noteTerminationIntent(target: Target, reason: string, now = Date.now()): void {
  intents.set(keyOf(target), { reason, at: now });
}

/** The reason Daintree gave for terminating this process recently, if any. */
export function getTerminationIntent(target: Target, now = Date.now()): string | null {
  const key = keyOf(target);
  const intent = intents.get(key);
  if (!intent) return null;
  if (now - intent.at > INTENT_TTL_MS) {
    intents.delete(key);
    return null;
  }
  return intent.reason;
}

/**
 * The death an intent was noted for has been seen. Keep it just long enough
 * for the owner's own exit handling to read it, so it can't be pinned on a
 * later death of a replacement with the same service name or webContents.
 */
export function settleTerminationIntent(target: Target, now = Date.now()): void {
  const key = keyOf(target);
  const intent = intents.get(key);
  if (!intent) return;
  intent.at = Math.min(intent.at, now - INTENT_TTL_MS + SETTLED_GRACE_MS);
}

export function resetTerminationIntentsForTesting(): void {
  intents.clear();
}
