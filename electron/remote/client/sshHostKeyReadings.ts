import type {
  HostSshKey,
  HostSshListenerBaseline,
  HostSshListenerReading,
  HostSshReadOutcome,
} from "../../../shared/types/ipc/remoteHosts.js";
import type { SshHostKeysAnswer } from "../host/linkMethods.js";
import { parsePublicKeyFile } from "../host/sshPublicKey.js";

/** Listeners kept per host: listener ids that stop appearing would otherwise pile up. */
export const MAX_SAVED_SSH_LISTENERS = 32;
const MAX_SAVED_KEYS = 32;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

function byFingerprint(a: HostSshKey, b: HostSshKey): number {
  return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
}

/** One entry per fingerprint, in fingerprint order. */
function keySet(keys: HostSshKey[]): HostSshKey[] {
  const seen = new Map<string, HostSshKey>();
  for (const key of keys) if (!seen.has(key.fingerprint)) seen.set(key.fingerprint, key);
  return [...seen.values()].sort(byFingerprint);
}

function sameKeys(a: HostSshKey[], b: HostSshKey[]): boolean {
  return a.length === b.length && a.every((key, i) => key.fingerprint === b[i]!.fingerprint);
}

/**
 * The key as its own blob says it is: the type and fingerprint worked out
 * here, never taken on the host's word, so a fingerprint shown, compared or
 * matched to a pin is always the one of the key that is copied.
 */
function verifiedKey(key: { type: string; fingerprint: string; publicKey: string }) {
  const parsed = parsePublicKeyFile(key.publicKey);
  if (!parsed || parsed.type !== key.type || parsed.fingerprint !== key.fingerprint) return null;
  return parsed;
}

/** The host's answer, as the renderer reads it. */
export function readOutcome(answer: SshHostKeysAnswer): HostSshReadOutcome {
  if (answer.status !== "reading") return answer;
  const listeners = answer.listeners.map((listener): HostSshListenerReading => {
    const keys: HostSshKey[] = [];
    const keyGaps: HostSshListenerReading["keyGaps"] = [];
    for (const key of listener.keys) {
      const verified = key.outcome === "read" ? verifiedKey(key) : null;
      if (verified) keys.push(verified);
      else {
        keyGaps.push({
          publicKeyPath: key.publicKeyPath,
          reason: key.outcome === "read" ? "invalid" : key.outcome,
        });
      }
    }
    return {
      listenerId: listener.listenerId,
      configFile: listener.configFile,
      listenAddresses: listener.listenAddresses,
      // A key whose blob doesn't bear out its fingerprint leaves the listener short.
      complete: listener.complete && keyGaps.length === 0,
      gaps: listener.gaps,
      keys: keySet(keys),
      keyGaps,
    };
  });
  return {
    status: "reading",
    complete: answer.complete && listeners.every((listener) => listener.complete),
    truncated: answer.truncated,
    listeners,
  };
}

/**
 * The baselines after a reading. Only a complete listener with an identity of
 * its own is compared and kept; a partial or failed read, and a listener that
 * didn't show up this time, leave the last complete reading as it was. A set
 * of fingerprints that differs from the kept one becomes the new baseline and
 * records the old one as its change, so a later window still sees it.
 */
export function applyReading(
  baselines: HostSshListenerBaseline[],
  outcome: HostSshReadOutcome,
  now: number
): HostSshListenerBaseline[] {
  // A truncated answer may have left out a listener sharing an id with one it kept.
  if (outcome.status !== "reading" || outcome.truncated) return baselines;
  const next = new Map(baselines.map((baseline) => [baseline.listenerId, baseline]));
  const ids = outcome.listeners.map((listener) => listener.listenerId);
  for (const listener of outcome.listeners) {
    const id = listener.listenerId;
    // The Host nulls an id another listener shares; a duplicate here is the same doubt.
    if (id === null || !listener.complete || ids.indexOf(id) !== ids.lastIndexOf(id)) continue;
    const keys = keySet(listener.keys);
    if (keys.length === 0) continue;
    const kept = next.get(id);
    const base = {
      listenerId: id,
      configFile: listener.configFile,
      listenAddresses: listener.listenAddresses,
      keys,
      readAt: now,
    };
    if (!kept) next.set(id, { ...base, change: null });
    else if (sameKeys(kept.keys, keys)) next.set(id, { ...base, change: kept.change });
    else next.set(id, { ...base, change: { previous: kept.keys, changedAt: now } });
  }
  return [...next.values()]
    .sort((a, b) => b.readAt - a.readAt)
    .slice(0, MAX_SAVED_SSH_LISTENERS)
    .sort((a, b) => (a.listenerId < b.listenerId ? -1 : a.listenerId > b.listenerId ? 1 : 0));
}

function readKey(raw: unknown): HostSshKey | null {
  if (!raw || typeof raw !== "object") return null;
  const { type, fingerprint, publicKey } = raw as Record<string, unknown>;
  if (typeof type !== "string" || typeof publicKey !== "string") return null;
  if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) return null;
  return verifiedKey({ type, fingerprint, publicKey });
}

function readKeys(raw: unknown): HostSshKey[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SAVED_KEYS) return null;
  const keys = raw.map(readKey);
  return keys.every((key): key is HostSshKey => key !== null) ? keySet(keys) : null;
}

/** Kept baselines as the settings file holds them; anything unusable is dropped. */
export function readBaselines(raw: unknown): HostSshListenerBaseline[] {
  if (!Array.isArray(raw)) return [];
  const out: HostSshListenerBaseline[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_SAVED_SSH_LISTENERS)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const { listenerId, configFile, listenAddresses, readAt, change } = value;
    if (typeof listenerId !== "string" || listenerId.length === 0 || seen.has(listenerId)) continue;
    if (configFile !== null && typeof configFile !== "string") continue;
    if (!Array.isArray(listenAddresses) || !listenAddresses.every((a) => typeof a === "string")) {
      continue;
    }
    if (typeof readAt !== "number" || !Number.isFinite(readAt)) continue;
    const keys = readKeys(value.keys);
    if (!keys) continue;
    let readChange: HostSshListenerBaseline["change"] = null;
    if (change && typeof change === "object") {
      const previous = readKeys((change as Record<string, unknown>).previous);
      const changedAt = (change as Record<string, unknown>).changedAt;
      if (previous && typeof changedAt === "number" && Number.isFinite(changedAt)) {
        readChange = { previous, changedAt };
      }
    }
    seen.add(listenerId);
    out.push({
      listenerId,
      configFile,
      listenAddresses: listenAddresses as string[],
      keys,
      readAt,
      change: readChange,
    });
  }
  return out;
}
