/**
 * Daintree signals its own children too — dispose backstops, health-check
 * force-kills, force-restarting an unresponsive view. Owners note the intent
 * just before signalling, so the resulting `killed` death is attributed to
 * Daintree instead of reading as an external kill. Utility processes are
 * keyed by service name (`child-process-gone` carries no pid), renderers by
 * webContents id, which survives the renderer's death and reload.
 */
const INTENT_TTL_MS = 10_000;

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

export function resetTerminationIntentsForTesting(): void {
  intents.clear();
}
