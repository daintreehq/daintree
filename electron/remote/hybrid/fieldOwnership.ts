import type { SettingOwner } from "../../storeOwnership.js";

type Record_ = Record<string, unknown>;

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function asRecord(value: unknown): Record_ {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : {};
}

/**
 * One object from two machines: each classified field from its owner (device
 * fields from this Shell, host fields from the host). A field the table does
 * not name is the host's — it describes the work, and a table that lags a new
 * field must not leak this machine's copy into a remote window.
 */
export function mergeByOwnership<T>(
  device: unknown,
  host: unknown,
  ownership: Readonly<Record<string, SettingOwner>>
): T {
  const fromDevice = asRecord(device);
  const merged: Record_ = { ...asRecord(host) };
  for (const [field, owner] of Object.entries(ownership)) {
    if (owner !== "device") continue;
    if (Object.hasOwn(fromDevice, field)) merged[field] = fromDevice[field];
    else delete merged[field];
  }
  return merged as T;
}

/** A partial update divided by owner; either side may come back empty. */
export function splitByOwnership(
  partial: unknown,
  ownership: Readonly<Record<string, SettingOwner>>
): { device: Record_; host: Record_ } {
  const device: Record_ = {};
  const host: Record_ = {};
  for (const [field, value] of Object.entries(asRecord(partial))) {
    if (RESERVED_KEYS.has(field)) continue;
    if (Object.hasOwn(ownership, field) && ownership[field] === "device") device[field] = value;
    else host[field] = value;
  }
  return { device, host };
}
