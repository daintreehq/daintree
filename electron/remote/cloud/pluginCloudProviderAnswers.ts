import {
  cloudLocationsFrom,
  type CloudAccountCheckResult,
  type CloudAccountScopeChoice,
  type CloudBillingScope,
  type CloudMachineState,
  type CloudMachineType,
} from "../../../shared/types/cloudHosts.js";
import type { ProviderCatalog, ProviderResource, ProviderSshAccess } from "./provider.js";

/**
 * What a plugin's provider answered, projected onto exactly the shapes the
 * cloud runtime reads (#17351). A plugin can send back anything, so each
 * reader copies only the declared fields of an answer it can use, and returns
 * null for one it can't. A field left out reads as unknown where the contract
 * allows null; a field present with the wrong shape fails the whole answer,
 * because null means something (no deadline, not stopped) that a malformed
 * value doesn't. The answer's size is bounded where it crosses the port.
 */

const MAX_TEXT = 512;
const MAX_ID = 256;
const MAX_IDENTITY = 1024;
const MAX_LABELS = 64;
/** Labels Daintree sets and finds machines by; kept whatever else the machine carries. */
const DAINTREE_LABEL_PREFIX = "daintree-";

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
const SCOPE_KINDS: ReadonlySet<string> = new Set<CloudBillingScope["kind"]>([
  "personal",
  "organization",
  "workspace",
  "project",
  "account",
]);
const STOP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "failing",
  "completed",
  "superseded",
  "unknown",
]);

type Fields = Record<string, unknown>;

/** A field that is there but isn't what the contract says. */
const MALFORMED = Symbol("malformed");

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

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

function count(value: unknown): number | null | typeof MALFORMED {
  if (absent(value)) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : MALFORMED;
}

function timestamp(value: unknown): string | null | typeof MALFORMED {
  if (absent(value)) return null;
  if (typeof value !== "string" || value.length > 64) return MALFORMED;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : MALFORMED;
}

/** Who the credentials sign in as: a string, or null for nobody in particular. Left out is malformed. */
function identity(raw: Fields): string | null | typeof MALFORMED {
  if (!Object.hasOwn(raw, "identity")) return MALFORMED;
  if (raw.identity === null) return null;
  return typeof raw.identity === "string" && raw.identity.length <= MAX_IDENTITY
    ? raw.identity
    : MALFORMED;
}

function labels(value: unknown): Record<string, string> {
  const raw = record(value);
  const result: Record<string, string> = {};
  if (!raw) return result;
  let kept = 0;
  for (const [key, entry] of Object.entries(raw)) {
    if (key.length === 0 || key.length > MAX_ID || key in Object.prototype) continue;
    const ours = key.startsWith(DAINTREE_LABEL_PREFIX);
    if (!ours && kept >= MAX_LABELS) continue;
    const label = text(entry, MAX_ID);
    if (label === null) continue;
    result[key] = label;
    if (!ours) kept++;
  }
  return result;
}

function stop(value: unknown): ProviderResource["stop"] | typeof MALFORMED {
  if (absent(value)) return null;
  const raw = record(value);
  const stopId = raw ? text(raw.id) : null;
  if (!raw || !stopId || typeof raw.status !== "string" || !STOP_STATUSES.has(raw.status)) {
    return MALFORMED;
  }
  if (!absent(raw.error) && typeof raw.error !== "string") return MALFORMED;
  return {
    id: stopId,
    status: raw.status as NonNullable<ProviderResource["stop"]>["status"],
    // A long diagnostic is still the provider's word on a failing save: kept, cut short.
    error: typeof raw.error === "string" ? raw.error.slice(0, MAX_TEXT) : null,
  };
}

/** Left out reads as not asleep; anything but a boolean is malformed. */
function asleep(value: unknown): boolean | undefined | typeof MALFORMED {
  if (absent(value)) return undefined;
  return typeof value === "boolean" ? value : MALFORMED;
}

/** Left out reads as the declared lifetime holding; one that is there must say both. */
function idleSleep(value: unknown): ProviderResource["idleSleep"] | typeof MALFORMED {
  if (absent(value)) return undefined;
  const raw = record(value);
  if (!raw || typeof raw.enabled !== "boolean") return MALFORMED;
  const idleSeconds = count(raw.idleSeconds);
  if (idleSeconds === MALFORMED) return MALFORMED;
  return { enabled: raw.enabled, idleSeconds };
}

export function readResource(value: unknown): ProviderResource | null {
  const raw = record(value);
  if (!raw) return null;
  const resourceId = id(raw.resourceId);
  if (resourceId === null || typeof raw.machine !== "string" || !MACHINE_STATES.has(raw.machine)) {
    return null;
  }
  // What decides whether a stop is safe, or the machine usable, is never guessed.
  if (
    typeof raw.dataExpired !== "boolean" ||
    typeof raw.snapshotsDisabled !== "boolean" ||
    typeof raw.restricted !== "boolean"
  ) {
    return null;
  }
  const vcpu = count(raw.vcpu);
  const memoryGB = count(raw.memoryGB);
  const lifetimeSeconds = count(raw.lifetimeSeconds);
  const autoStopAt = timestamp(raw.autoStopAt);
  const stoppedAt = timestamp(raw.stoppedAt);
  const createdAt = timestamp(raw.createdAt);
  const lastSnapshotAt = timestamp(raw.lastSnapshotAt);
  const stopped = stop(raw.stop);
  const sleeping = asleep(raw.asleep);
  const sleeps = idleSleep(raw.idleSleep);
  if (
    vcpu === MALFORMED ||
    memoryGB === MALFORMED ||
    lifetimeSeconds === MALFORMED ||
    autoStopAt === MALFORMED ||
    stoppedAt === MALFORMED ||
    createdAt === MALFORMED ||
    lastSnapshotAt === MALFORMED ||
    stopped === MALFORMED ||
    sleeping === MALFORMED ||
    sleeps === MALFORMED
  ) {
    return null;
  }
  return {
    resourceId,
    name: text(raw.name, MAX_ID) ?? resourceId,
    machine: raw.machine as CloudMachineState,
    rawState: text(raw.rawState, MAX_ID) ?? raw.machine,
    machineType: id(raw.machineType),
    vcpu,
    memoryGB,
    autoStopAt,
    lifetimeSeconds,
    stoppedAt,
    createdAt,
    stop: stopped,
    lastSnapshotAt,
    dataExpired: raw.dataExpired,
    snapshotsDisabled: raw.snapshotsDisabled,
    labels: labels(raw.labels),
    restricted: raw.restricted,
    error: text(raw.error),
    ...(sleeping !== undefined ? { asleep: sleeping } : {}),
    ...(sleeps !== undefined ? { idleSleep: sleeps } : {}),
  };
}

export function readResources(value: unknown): ProviderResource[] | null {
  if (!Array.isArray(value)) return null;
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
  if (!raw || !Array.isArray(raw.scopes)) return null;
  const who = identity(raw);
  if (who === MALFORMED) return null;
  const scopes: CloudAccountScopeChoice[] = [];
  const seen = new Set<string>();
  for (const entry of raw.scopes) {
    const choice = record(entry);
    const scope = choice ? record(choice.scope) : null;
    const scopeId = scope ? id(scope.id) : null;
    if (!scope || scopeId === null || seen.has(scopeId)) return null;
    if (typeof scope.kind !== "string" || !SCOPE_KINDS.has(scope.kind)) return null;
    seen.add(scopeId);
    scopes.push({
      scope: {
        kind: scope.kind as CloudBillingScope["kind"],
        id: scopeId,
        name: text(scope.name, MAX_ID) ?? scopeId,
      },
      active: choice!.active === true,
    });
  }
  return { identity: who, scopes };
}

export function readIdentity(value: unknown): { identity: string | null } | null {
  const raw = record(value);
  const who = raw ? identity(raw) : MALFORMED;
  return who === MALFORMED ? null : { identity: who };
}

function readMachineType(value: unknown): CloudMachineType | null {
  const raw = record(value);
  const typeId = raw ? id(raw.id) : null;
  if (!raw || typeId === null) return null;
  const vcpu = count(raw.vcpu);
  const memoryGB = count(raw.memoryGB);
  const hourlyDollars = count(raw.hourlyDollars);
  if (vcpu === MALFORMED || memoryGB === MALFORMED || hourlyDollars === MALFORMED) return null;
  return {
    id: typeId,
    label: text(raw.label, MAX_ID) ?? typeId,
    vcpu,
    memoryGB,
    hourlyDollars,
    available: raw.available === true,
    reason: text(raw.reason),
    ...(raw.locations === undefined ? {} : { locations: cloudLocationsFrom(raw.locations) }),
  };
}

export function readCatalog(value: unknown): ProviderCatalog | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.machineTypes)) return null;
  const machineTypes: CloudMachineType[] = [];
  const seen = new Set<string>();
  for (const entry of raw.machineTypes) {
    const type = readMachineType(entry);
    if (!type) return null;
    if (seen.has(type.id)) continue;
    seen.add(type.id);
    machineTypes.push(type);
  }
  const included = count(raw.includedHoursRemaining);
  const starts = count(raw.startsRemaining);
  const saved = count(raw.savedSnapshotDayDollars);
  if (included === MALFORMED || starts === MALFORMED || saved === MALFORMED) return null;
  const provisioning = record(raw.provisioning);
  return {
    machineTypes,
    canStart: raw.canStart === true,
    includedHoursRemaining: included,
    startsRemaining: starts,
    savedSnapshotDayDollars: saved,
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
