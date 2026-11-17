import type {
  CloudAccountCheckResult,
  CloudAccountScopeChoice,
  CloudMachineState,
  CloudMachineType,
} from "../../../shared/types/cloudHosts.js";
import type { ProviderCatalog, ProviderResource, ProviderSshAccess } from "./provider.js";

/**
 * What a plugin's provider answered, projected onto exactly the shapes the
 * cloud runtime reads (#17351). A plugin can send back anything, so each
 * reader returns null for an answer it can't use, and copies only the
 * declared fields of one it can; a field that is merely odd (a timestamp
 * that doesn't parse) reads as unknown rather than failing the answer.
 */

const MAX_TEXT = 512;
const MAX_ID = 256;
const MAX_LIST = 1000;
const MAX_LABELS = 64;
const MAX_SCOPES = 64;
const MAX_MACHINE_TYPES = 200;

const MACHINE_STATES: ReadonlySet<string> = new Set<CloudMachineState>([
  "not-created",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
  "deleted",
  "unknown",
]);
const STOP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "failing",
  "completed",
  "superseded",
  "unknown",
]);

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID ? value : null;
}

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function labels(value: unknown): Record<string, string> {
  const raw = record(value);
  const result: Record<string, string> = {};
  if (!raw) return result;
  let kept = 0;
  for (const [key, entry] of Object.entries(raw)) {
    if (kept >= MAX_LABELS) break;
    if (key.length === 0 || key.length > MAX_ID || key in Object.prototype) continue;
    const label = text(entry, MAX_ID);
    if (label === null) continue;
    result[key] = label;
    kept++;
  }
  return result;
}

export function readResource(value: unknown): ProviderResource | null {
  const raw = record(value);
  if (!raw) return null;
  const resourceId = id(raw.resourceId);
  if (resourceId === null || typeof raw.machine !== "string" || !MACHINE_STATES.has(raw.machine)) {
    return null;
  }
  const stopRaw = record(raw.stop);
  const stopId = stopRaw ? id(stopRaw.id) : null;
  return {
    resourceId,
    name: text(raw.name, MAX_ID) ?? resourceId,
    machine: raw.machine as CloudMachineState,
    rawState: text(raw.rawState, MAX_ID) ?? raw.machine,
    machineType: id(raw.machineType),
    vcpu: count(raw.vcpu),
    memoryGB: count(raw.memoryGB),
    autoStopAt: timestamp(raw.autoStopAt),
    lifetimeSeconds: count(raw.lifetimeSeconds),
    stoppedAt: timestamp(raw.stoppedAt),
    createdAt: timestamp(raw.createdAt),
    stop:
      stopRaw && stopId !== null
        ? {
            id: stopId,
            status:
              typeof stopRaw.status === "string" && STOP_STATUSES.has(stopRaw.status)
                ? (stopRaw.status as NonNullable<ProviderResource["stop"]>["status"])
                : "unknown",
            error: text(stopRaw.error),
          }
        : null,
    lastSnapshotAt: timestamp(raw.lastSnapshotAt),
    dataExpired: raw.dataExpired === true,
    snapshotsDisabled: raw.snapshotsDisabled === true,
    labels: labels(raw.labels),
    restricted: raw.restricted === true,
    error: text(raw.error),
  };
}

export function readResources(value: unknown): ProviderResource[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST) return null;
  const resources: ProviderResource[] = [];
  for (const entry of value) {
    const resource = readResource(entry);
    if (!resource) return null;
    resources.push(resource);
  }
  return resources;
}

export function readCheckResult(value: unknown): CloudAccountCheckResult | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.scopes) || raw.scopes.length > MAX_SCOPES) return null;
  const scopes: CloudAccountScopeChoice[] = [];
  const seen = new Set<string>();
  for (const entry of raw.scopes) {
    const choice = record(entry);
    const scope = choice ? record(choice.scope) : null;
    const scopeId = scope ? id(scope.id) : null;
    if (!scope || scopeId === null || seen.has(scopeId)) return null;
    if (scope.kind !== "personal" && scope.kind !== "organization") return null;
    seen.add(scopeId);
    scopes.push({
      scope: { kind: scope.kind, id: scopeId, name: text(scope.name, MAX_ID) ?? scopeId },
      active: choice!.active === true,
    });
  }
  return { identity: text(raw.identity, MAX_ID), scopes };
}

export function readIdentity(value: unknown): { identity: string | null } | null {
  const raw = record(value);
  return raw ? { identity: text(raw.identity, MAX_ID) } : null;
}

function readMachineType(value: unknown): CloudMachineType | null {
  const raw = record(value);
  const typeId = raw ? id(raw.id) : null;
  if (!raw || typeId === null) return null;
  return {
    id: typeId,
    label: text(raw.label, MAX_ID) ?? typeId,
    vcpu: count(raw.vcpu),
    memoryGB: count(raw.memoryGB),
    hourlyDollars: count(raw.hourlyDollars),
    available: raw.available === true,
    reason: text(raw.reason),
  };
}

export function readCatalog(value: unknown): ProviderCatalog | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.machineTypes) || raw.machineTypes.length > MAX_MACHINE_TYPES) {
    return null;
  }
  const machineTypes: CloudMachineType[] = [];
  const seen = new Set<string>();
  for (const entry of raw.machineTypes) {
    const type = readMachineType(entry);
    if (!type) return null;
    if (seen.has(type.id)) continue;
    seen.add(type.id);
    machineTypes.push(type);
  }
  const provisioning = record(raw.provisioning);
  return {
    machineTypes,
    canStart: raw.canStart === true,
    includedHoursRemaining: count(raw.includedHoursRemaining),
    startsRemaining: count(raw.startsRemaining),
    savedSnapshotDayDollars: count(raw.savedSnapshotDayDollars),
    // Its choices are distrusted where they're read (`normalizeProvisioning`).
    ...(provisioning ? { provisioning: provisioning as ProviderCatalog["provisioning"] } : {}),
  };
}

/** Its shape only: whether the address and key can be used is the lifecycle's check. */
export function readSshAccess(value: unknown): ProviderSshAccess | null {
  const raw = record(value);
  const endpoint = raw ? record(raw.endpoint) : null;
  if (!raw || !endpoint || typeof raw.user !== "string") return null;
  if (typeof endpoint.host !== "string" || typeof endpoint.port !== "number") return null;
  return {
    user: raw.user,
    endpoint: { host: endpoint.host, port: endpoint.port },
    hostKey: typeof raw.hostKey === "string" ? raw.hostKey : null,
  };
}
