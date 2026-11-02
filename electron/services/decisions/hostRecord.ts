import type { DecisionsSettings, DecisionsStatus } from "../../../shared/types/decisions.js";
import type {
  DecisionsHostRecord,
  DecisionsHostRuntime,
} from "../../../shared/types/decisionsHosts.js";
import {
  consentTime,
  defaultDecisionsSettings,
  isRelayId,
  normalizeRelayOrigin,
} from "./decisionsSettings.js";

/** The slice of the settings store the Host's record lives in; the app's `store` is one. */
export interface DecisionsHostRecordStore {
  get(key: "decisionsHost"): unknown;
  set(key: "decisionsHost", value: DecisionsHostRecord): void;
}

/**
 * The Host's record as saved, or null when this machine isn't an enrolled
 * Host or the record can't be read whole: a partial record names no device
 * it could run as. Never throws.
 */
export function sanitizeHostRecord(raw: unknown): DecisionsHostRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Partial<Record<keyof DecisionsHostRecord, unknown>>;
  const relayOrigin = normalizeRelayOrigin(value.relayOrigin);
  if (
    relayOrigin === null ||
    !isRelayId(value.installationId) ||
    !isRelayId(value.deviceId) ||
    !isRelayId(value.ownerDeviceId) ||
    !isRelayId(value.hostId)
  ) {
    return null;
  }
  const revokedAt = consentTime(value.revokedAt);
  return {
    relayOrigin,
    installationId: value.installationId,
    deviceId: value.deviceId,
    ownerDeviceId: value.ownerDeviceId,
    hostId: value.hostId,
    ownerOffAt: consentTime(value.ownerOffAt),
    revokedAt,
    // Removal follows a revocation; without one there was nothing to remove.
    credentialsRemovedAt: revokedAt === null ? null : consentTime(value.credentialsRemovedAt),
  };
}

export function readHostRecord(store: DecisionsHostRecordStore): DecisionsHostRecord | null {
  return sanitizeHostRecord(store.get("decisionsHost"));
}

export function writeHostRecord(
  store: DecisionsHostRecordStore,
  next: DecisionsHostRecord
): DecisionsHostRecord {
  const stored = sanitizeHostRecord(next);
  if (stored === null) throw new Error("The Host's Decisions record isn't whole");
  store.set("decisionsHost", stored);
  return stored;
}

/** The Host serves its panes now: neither turned off by its owner nor revoked. */
export function hostRecordServes(record: DecisionsHostRecord | null): boolean {
  return record !== null && record.ownerOffAt === null && record.revokedAt === null;
}

/**
 * The settings a Host's lifetime runs with: its relay identity and host id,
 * and the defaults for everything the owner decides (proxy answers stay
 * off). Never saved: a Host has no switch or relay of its own.
 */
export function hostLifetimeSettings(record: DecisionsHostRecord): DecisionsSettings {
  return {
    ...defaultDecisionsSettings(),
    enabled: true,
    relayOrigin: record.relayOrigin,
    installationId: record.installationId,
    deviceId: record.deviceId,
    hostId: record.hostId,
    revokedAt: record.revokedAt,
  };
}

/** What the Host reports of its own Decisions, from its record and its lifetime's status. */
export function hostRuntimeOf(
  record: DecisionsHostRecord | null,
  status: DecisionsStatus | null
): DecisionsHostRuntime {
  if (record === null) return { state: "not-enrolled" };
  const { deviceId } = record;
  if (record.revokedAt !== null) {
    return {
      state: "revoked",
      deviceId,
      since: record.revokedAt,
      credentialsRemoved: record.credentialsRemovedAt !== null,
    };
  }
  if (record.ownerOffAt !== null) return { state: "owner-off", deviceId, since: record.ownerOffAt };
  const state = status === null || status.state === "off" ? "not-connected" : status.state;
  return {
    state: "running",
    deviceId,
    connection: state,
    ...(status?.nextAttemptAt !== undefined ? { nextAttemptAt: status.nextAttemptAt } : {}),
    ...(status?.problem !== undefined ? { problem: status.problem } : {}),
  };
}
