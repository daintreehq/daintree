import type { DecisionsSettings } from "../../../shared/types/decisions.js";

/** The relay protocol's id shape: what a relay mints for installations and devices. */
const RELAY_ID = /^[A-Za-z0-9_-]{8,64}$/;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** The slice of the settings store these touch; the app's `store` is one. */
export interface DecisionsStore {
  get(key: "decisions"): unknown;
  set(key: "decisions", value: DecisionsSettings): void;
}

export function defaultDecisionsSettings(): DecisionsSettings {
  return {
    enabled: false,
    relayOrigin: null,
    installationId: null,
    deviceId: null,
    hostId: null,
    proxyAllowlisted: false,
    consentedAt: null,
    revokedAt: null,
  };
}

/**
 * A relay origin the client library would accept, reduced to the origin: https,
 * or plain http on loopback for a relay under development. Anything else, a
 * path, query or userinfo included, never survives a load.
 */
export function normalizeRelayOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!secure && !loopback) return null;
  return url.origin;
}

/** A consent or revocation time is a positive epoch-ms number; anything else is none. */
export function consentTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** An id in the shape a relay mints, so the setting's sanitiser keeps it. */
export function isRelayId(value: unknown): value is string {
  return typeof value === "string" && RELAY_ID.test(value);
}

function relayId(value: unknown): string | null {
  return isRelayId(value) ? value : null;
}

/** Absent is a relay not set up yet; anything else that didn't read is damage. */
function unreadable(value: unknown, read: string | null): boolean {
  return value !== undefined && value !== null && read === null;
}

/**
 * What was on disk, with anything malformed read as its default and anything
 * unknown dropped, so a value nobody declared (a secret included) never
 * survives a rewrite. A relay origin or id that is there but unreadable turns
 * Decisions off; an unread one is just not set up yet. Never throws.
 */
export function sanitizeDecisionsSettings(raw: unknown): DecisionsSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultDecisionsSettings();
  }
  const value = raw as Partial<Record<keyof DecisionsSettings, unknown>>;
  const relayOrigin = normalizeRelayOrigin(value.relayOrigin);
  const installationId = relayId(value.installationId);
  const deviceId = relayId(value.deviceId);
  const hostId = relayId(value.hostId);
  const damaged =
    unreadable(value.relayOrigin, relayOrigin) ||
    unreadable(value.installationId, installationId) ||
    unreadable(value.deviceId, deviceId) ||
    unreadable(value.hostId, hostId);
  // A revocation belongs to the identity it was observed for, so it goes with
  // the relay's ids; without them there is nothing it could still refer to.
  const identified = relayOrigin !== null && installationId !== null && deviceId !== null;
  return {
    enabled: value.enabled === true && !damaged,
    relayOrigin,
    installationId,
    deviceId,
    hostId,
    proxyAllowlisted: value.proxyAllowlisted === true,
    consentedAt: consentTime(value.consentedAt),
    revokedAt: identified ? consentTime(value.revokedAt) : null,
  };
}

/** The setting as every reader sees it. Reading never writes. */
export function readDecisionsSettings(store: DecisionsStore): DecisionsSettings {
  return sanitizeDecisionsSettings(store.get("decisions"));
}

/** Replaces the whole setting with its sanitised form, and returns what was stored. */
export function writeDecisionsSettings(
  store: DecisionsStore,
  next: DecisionsSettings
): DecisionsSettings {
  const stored = sanitizeDecisionsSettings(next);
  store.set("decisions", stored);
  return stored;
}
