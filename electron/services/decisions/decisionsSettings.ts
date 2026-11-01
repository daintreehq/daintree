import type { DecisionsSettings } from "../../../shared/types/decisions.js";

/** The relay protocol's id shape: what a relay mints for installations and devices. */
const RELAY_ID = /^[A-Za-z0-9_-]{8,64}$/;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function defaultDecisionsSettings(): DecisionsSettings {
  return {
    enabled: false,
    relayOrigin: null,
    installationId: null,
    deviceId: null,
    hostId: null,
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

function relayId(value: unknown): string | null {
  return typeof value === "string" && RELAY_ID.test(value) ? value : null;
}

/**
 * What was on disk, with anything malformed read as its default and anything
 * unknown dropped, so a value nobody declared (a secret included) never
 * survives a rewrite. Never throws.
 */
export function sanitizeDecisionsSettings(raw: unknown): DecisionsSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultDecisionsSettings();
  }
  const value = raw as Partial<Record<keyof DecisionsSettings, unknown>>;
  return {
    enabled: value.enabled === true,
    relayOrigin: normalizeRelayOrigin(value.relayOrigin),
    installationId: relayId(value.installationId),
    deviceId: relayId(value.deviceId),
    hostId: relayId(value.hostId),
  };
}
