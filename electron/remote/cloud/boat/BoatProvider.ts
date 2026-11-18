import type {
  CloudAccountCheckResult,
  CloudCredentialValues,
  CloudHostError,
  CloudMachineType,
  CloudProviderInfo,
} from "../../../../shared/types/cloudHosts.js";
import {
  CLOUD_HOSTS_UNSUPPORTED_ON_WINDOWS,
  UnusableMachineKeyError,
  type CloudProvider,
  type IssuedMachineKey,
  type MachineKeyIssuer,
  type ProviderCatalog,
  type ProviderCreateRequest,
  type ProviderCredentials,
  type ProviderResource,
  type ProviderSshAccess,
} from "../provider.js";
import { AppError } from "../../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { isSafeSshUser, normalizeHostKey, parseSshEndpoint } from "../sshEndpoint.js";
import { BoatApiError, BoatClient, type BoatRequestContext } from "./BoatClient.js";
import {
  boatApiKeyScopeSchema,
  type BoatActionResponse,
  type BoatApiKey,
  type BoatLimits,
  type BoatSandbox,
} from "./boatSchemas.js";
import { BOAT_SIZE_MULTIPLIERS, BOAT_SIZE_SPECS, boatMachineState } from "./boatState.js";

const SIZE_ORDER = ["small", "default", "large", "xlarge"];
const MAX_SCOPE_PROBES = 12;
const MAX_KEY_LENGTH = 4096;

function invalidKey(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

/** Boat's API key from an entered set: one line of printable ASCII, the only shape Boat issues. */
export function boatApiKey(values: Readonly<CloudCredentialValues>): string {
  const key = values.apiKey;
  if (typeof key !== "string" || key.length === 0) throw invalidKey("Paste an API key.");
  if (/PRIVATE KEY/.test(key)) throw invalidKey("That's a private key, not an API key.");
  if (key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    throw invalidKey(
      "That doesn't look like an API key: it should be one line of letters, digits and symbols."
    );
  }
  return key;
}

function stopStatus(
  status: string
): "pending" | "failing" | "completed" | "superseded" | "unknown" {
  return status === "pending" ||
    status === "failing" ||
    status === "completed" ||
    status === "superseded"
    ? status
    : "unknown";
}

export function boatResource(sandbox: BoatSandbox): ProviderResource {
  const spec = sandbox.type ? BOAT_SIZE_SPECS[sandbox.type] : undefined;
  return {
    resourceId: sandbox.id,
    name: sandbox.name,
    machine: boatMachineState(sandbox.state),
    rawState: sandbox.state,
    machineType: sandbox.type ?? null,
    vcpu: sandbox.vcpu ?? spec?.vcpu ?? null,
    memoryGB: sandbox.memoryGB ?? spec?.memoryGB ?? null,
    autoStopAt: sandbox.archiveAfter ?? null,
    lifetimeSeconds: sandbox.ttlSeconds ?? null,
    stoppedAt: sandbox.stoppedAt ?? null,
    createdAt: sandbox.createdAt ?? null,
    stop: sandbox.stop
      ? {
          id: sandbox.stop.id,
          status: stopStatus(sandbox.stop.status),
          error: sandbox.stop.error ?? null,
        }
      : null,
    lastSnapshotAt: sandbox.snapshotCompletedAt ?? null,
    dataExpired: Boolean(sandbox.dataExpiredAt),
    snapshotsDisabled: sandbox.snapshots === false,
    labels: sandbox.labels ?? {},
    restricted: sandbox.access === "view",
    error: sandbox.error ?? null,
  };
}

/** The machine as a stop's answer reports it, with the stop it started; null when it named none. */
export function boatStopResource(response: BoatActionResponse): ProviderResource | null {
  if (!response.sandbox) return null;
  const resource = boatResource(response.sandbox);
  if (!resource.stop && response.operation) {
    resource.stop = {
      id: response.operation.id,
      status: stopStatus(response.operation.status),
      error: response.operation.error ?? null,
    };
  }
  return resource;
}

/** The hourly list price for a size, from the account's own rate when Boat reports one. */
function hourlyFor(type: string, limits: BoatLimits): number | null {
  const rate = limits.overagePrices?.vmHourDollars;
  const multiplier = BOAT_SIZE_MULTIPLIERS[type];
  if (typeof rate !== "number" || multiplier === undefined) return null;
  return Math.round(rate * multiplier * 10_000) / 10_000;
}

function tightestStarts(limits: BoatLimits): number | null {
  const starts = limits.starts;
  if (!starts || starts.unlimited) return null;
  const remaining = [starts.minute, starts.hour, starts.day]
    .map((window) => window?.remaining)
    .filter((value): value is number => typeof value === "number");
  return remaining.length > 0 ? Math.min(...remaining) : null;
}

/**
 * What a machine's own key may do (#17361): read its sandbox, move its
 * lifetime (a sandbox write) and stop it normally. Never resume, delete,
 * exec or anything on the account.
 */
export const BOAT_MACHINE_KEY_ACTIONS: readonly string[] = [
  "sandbox.read",
  "sandbox.update",
  "sandbox.stop",
];

/**
 * Whether Boat's answer shows the key reaches exactly this machine, with
 * exactly the actions asked for and no environment: positive evidence, since
 * Boat grants by sandbox or by environment, and a key that can't renew or stop
 * would leave the machine looking kept when it isn't.
 */
function scopedToMachine(key: BoatApiKey, resourceId: string): boolean {
  const parsed = boatApiKeyScopeSchema.safeParse(key.scope);
  const scope = parsed.success ? parsed.data : null;
  if (!scope?.actions || !Array.isArray(scope.sandboxes)) return false;
  const actions = new Set(scope.actions);
  if (
    actions.size !== BOAT_MACHINE_KEY_ACTIONS.length ||
    !BOAT_MACHINE_KEY_ACTIONS.every((action) => actions.has(action))
  ) {
    return false;
  }
  if (scope.sandboxes.length !== 1 || scope.sandboxes[0] !== resourceId) return false;
  return (
    scope.environments === undefined ||
    (Array.isArray(scope.environments) && scope.environments.length === 0)
  );
}

class BoatMachineKeys implements MachineKeyIssuer {
  constructor(
    private readonly clientFor: (apiUrl: string) => BoatClient,
    private readonly ctx: (credentials: ProviderCredentials) => BoatRequestContext
  ) {}

  async issue(
    credentials: ProviderCredentials,
    resourceId: string,
    request: { name: string; ttlDays: number }
  ): Promise<IssuedMachineKey> {
    const client = this.clientFor(credentials.apiUrl);
    const created = await client.createScopedKey(this.ctx(credentials), {
      name: request.name,
      ttl: `${request.ttlDays}d`,
      actions: [...BOAT_MACHINE_KEY_ACTIONS],
      sandboxIds: [resourceId],
    });
    const said = created.apiKey.expiresAt;
    const expiresAt = typeof said === "string" ? Date.parse(said) : Number.NaN;
    if (!Number.isFinite(expiresAt) || !scopedToMachine(created.apiKey, resourceId)) {
      // Never handed to the machine; revoked by its id like any other key nothing should hold.
      throw new UnusableMachineKeyError(
        created.apiKey.id,
        Number.isFinite(expiresAt) ? expiresAt : null,
        "Boat issued a key other than the one asked for, so it wasn't used."
      );
    }
    return { keyId: created.apiKey.id, secret: created.secret, expiresAt };
  }

  async revoke(credentials: ProviderCredentials, keyId: string): Promise<void> {
    try {
      await this.clientFor(credentials.apiUrl).revokeKey(this.ctx(credentials), keyId);
    } catch (error) {
      if (error instanceof BoatApiError && error.kind === "not-found") return;
      throw error;
    }
  }

  async findByName(credentials: ProviderCredentials, name: string): Promise<string[]> {
    const keys = await this.clientFor(credentials.apiUrl).listKeys(this.ctx(credentials));
    return keys.filter((key) => key.name === name).map((key) => key.id);
  }
}

export class BoatProvider implements CloudProvider {
  readonly id = "boat" as const;
  readonly machineKeys: MachineKeyIssuer;

  constructor(private readonly clientFor: (apiUrl: string) => BoatClient) {
    this.machineKeys = new BoatMachineKeys(clientFor, (credentials) => this.ctx(credentials));
  }

  info(platform: NodeJS.Platform): CloudProviderInfo {
    return {
      id: "boat",
      name: "Boat",
      description: "On-demand Ubuntu machines that stop when idle and resume with their disk.",
      apiKeyUrl: "https://boat.dev/dashboard?tab=api-keys",
      dashboardUrl: "https://boat.dev/dashboard",
      docsUrl: "https://docs.boat.dev",
      credentialFields: [
        {
          id: "apiKey",
          label: "API key",
          secret: true,
          input: "single-line",
          required: true,
          help: null,
        },
      ],
      capabilities: {
        persistence: {
          kept: "Files in its home folder",
          lost: "/tmp, caches and memory",
          retentionDays: 14,
          saveRetryBilled: false,
          stoppedComputeBilled: false,
          stoppedStorageBilled: false,
        },
        typicalStartSeconds: 60,
        lifetime: { kind: "renewable" },
        sshTrust: "pinned-from-api",
        transport: "direct",
        tunnel: null,
        provisioning: {
          location: "none",
          image: "none",
          network: "none",
          sshKey: "after-create",
        },
        deletion: true,
      },
      unsupportedReason: platform === "win32" ? CLOUD_HOSTS_UNSUPPORTED_ON_WINDOWS : null,
    };
  }

  private ctx(credentials: ProviderCredentials): BoatRequestContext {
    const apiKey = credentials.values.apiKey;
    // Never sent without one: an empty bearer would only come back as Boat's refusal.
    if (!apiKey) throw new BoatApiError("unauthorized", "No API key", null, null, null);
    return { apiKey, org: credentials.scopeId, signal: credentials.signal };
  }

  async checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal?: AbortSignal
  ): Promise<CloudAccountCheckResult> {
    const apiKey = boatApiKey(values);
    const client = this.clientFor(apiUrl);
    const me = await client.me({ apiKey, org: "", signal });
    let orgs: Awaited<ReturnType<BoatClient["orgs"]>> = [];
    try {
      orgs = await client.orgs({ apiKey, signal });
    } catch (error) {
      // A key without account.read can't list wallets; personal is then the only one to try.
      if (!(error instanceof BoatApiError) || error.kind !== "forbidden") throw error;
    }
    const candidates = orgs.map((org) => ({
      scope: {
        kind: org.type === "personal" ? ("personal" as const) : ("organization" as const),
        id: org.type === "personal" ? "personal" : org.id,
        name: org.type === "personal" ? "Personal" : org.name,
      },
      active: org.active === true,
    }));
    if (!candidates.some((choice) => choice.scope.kind === "personal")) {
      candidates.push({
        scope: { kind: "personal", id: "personal", name: "Personal" },
        active: false,
      });
    }
    // An organization key answers only for its organization (403
    // api_key_org_mismatch elsewhere): offer only the wallets the key can use.
    const scopes: CloudAccountCheckResult["scopes"] = [];
    let refusal: BoatApiError | null = null;
    for (const choice of candidates.slice(0, MAX_SCOPE_PROBES)) {
      try {
        await client.probeSandboxes({ apiKey, org: choice.scope.id, signal });
        scopes.push(choice);
      } catch (error) {
        if (!(error instanceof BoatApiError) || error.kind !== "forbidden") throw error;
        refusal = error;
      }
    }
    if (scopes.length === 0) {
      throw (
        refusal ??
        new BoatApiError("forbidden", "This key can't read machines in any wallet", 403, null, null)
      );
    }
    const user = me.user;
    return {
      identity: user.login ?? user.email ?? user.displayName ?? null,
      scopes,
    };
  }

  async validate(credentials: ProviderCredentials): Promise<{ identity: string | null }> {
    const client = this.clientFor(credentials.apiUrl);
    const me = await client.me(this.ctx(credentials));
    // The key may sign in yet have lost this wallet (or sandbox.read).
    await client.probeSandboxes(this.ctx(credentials));
    return { identity: me.user.login ?? me.user.email ?? me.user.displayName ?? null };
  }

  async catalog(credentials: ProviderCredentials): Promise<ProviderCatalog> {
    const limits = await this.clientFor(credentials.apiUrl).limits(this.ctx(credentials));
    const offered =
      limits.machineTypes ?? SIZE_ORDER.map((type) => ({ type, available: true, reason: null }));
    const machineTypes: CloudMachineType[] = offered
      .slice()
      .sort((a, b) => SIZE_ORDER.indexOf(a.type) - SIZE_ORDER.indexOf(b.type))
      .map((entry) => {
        const spec = BOAT_SIZE_SPECS[entry.type];
        return {
          id: entry.type,
          label: spec?.label ?? entry.type,
          vcpu: spec?.vcpu ?? null,
          memoryGB: spec?.memoryGB ?? null,
          hourlyDollars: hourlyFor(entry.type, limits),
          available: entry.available,
          reason: entry.reason ?? null,
        };
      });
    return {
      machineTypes,
      canStart: limits.canStart !== false,
      includedHoursRemaining: limits.planIncluded?.vmHoursRemaining ?? null,
      startsRemaining: tightestStarts(limits),
      savedSnapshotDayDollars: limits.overagePrices?.savedSnapshotDayDollars ?? null,
    };
  }

  async list(
    credentials: ProviderCredentials,
    options: { label?: string } = {}
  ): Promise<ProviderResource[]> {
    const sandboxes = await this.clientFor(credentials.apiUrl).listSandboxes(
      this.ctx(credentials),
      50,
      options.label
    );
    return sandboxes.map(boatResource);
  }

  async inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource> {
    return boatResource(
      await this.clientFor(credentials.apiUrl).getSandbox(this.ctx(credentials), resourceId)
    );
  }

  async create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource> {
    const sandbox = await this.clientFor(credentials.apiUrl).createSandbox(
      this.ctx(credentials),
      {
        name: request.name,
        type: request.machineType,
        ttlSeconds: request.lifetimeSeconds,
        labels: request.labels,
        // A durable host must survive a stop; Boat erases a snapshot-less disk.
        snapshots: true,
        ...(credentials.scopeId === "personal" ? {} : { visibility: "private" as const }),
      },
      request.idempotencyKey
    );
    return boatResource(sandbox);
  }

  async start(
    credentials: ProviderCredentials,
    resourceId: string,
    options: { lifetimeSeconds?: number | null }
  ): Promise<ProviderResource | null> {
    const response = await this.clientFor(credentials.apiUrl).resumeSandbox(
      this.ctx(credentials),
      resourceId,
      options.lifetimeSeconds === undefined ? {} : { ttlSeconds: options.lifetimeSeconds }
    );
    return response.sandbox ? boatResource(response.sandbox) : null;
  }

  async stop(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderResource | null> {
    return boatStopResource(
      await this.clientFor(credentials.apiUrl).stopSandbox(this.ctx(credentials), resourceId)
    );
  }

  async renewLifetime(
    credentials: ProviderCredentials,
    resourceId: string,
    lifetimeSeconds: number | null
  ): Promise<ProviderResource> {
    return boatResource(
      await this.clientFor(credentials.apiUrl).updateSandbox(this.ctx(credentials), resourceId, {
        ttlSeconds: lifetimeSeconds,
      })
    );
  }

  async rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void> {
    await this.clientFor(credentials.apiUrl).updateSandbox(this.ctx(credentials), resourceId, {
      name,
    });
  }

  async delete(credentials: ProviderCredentials, resourceId: string): Promise<void> {
    await this.clientFor(credentials.apiUrl).deleteSandbox(this.ctx(credentials), resourceId);
  }

  async authorizeSsh(
    credentials: ProviderCredentials,
    resourceId: string,
    publicKey: string
  ): Promise<ProviderSshAccess> {
    const response = await this.clientFor(credentials.apiUrl).authorizeSshKey(
      this.ctx(credentials),
      resourceId,
      publicKey
    );
    const user = response.sshUser ?? "user";
    // sshEndpoint is set only when the machine has no public address of its own.
    const endpoint =
      parseSshEndpoint(response.sshEndpoint ?? null) ??
      parseSshEndpoint(response.machineIp ?? null);
    const hostKey = normalizeHostKey(response.hostKey);
    if (!endpoint || !hostKey || !isSafeSshUser(user)) {
      throw new BoatApiError(
        "bad-response",
        !hostKey
          ? "Boat didn't return the machine's SSH host key, so its identity can't be verified"
          : "Boat didn't return a usable SSH address for the machine",
        null,
        null,
        null
      );
    }
    return { user, endpoint, hostKey };
  }

  describeError(error: unknown): CloudHostError {
    const at = Date.now();
    if (!(error instanceof BoatApiError)) {
      return {
        code: "failed",
        message:
          error instanceof AppError && error.userMessage
            ? error.userMessage
            : formatErrorMessage(error, "Something went wrong talking to Boat"),
        at,
      };
    }
    const said = error.message;
    // A refusal while Boat rolls its keys out: nothing was made, and it passes.
    if (error.code === "scoped_api_key_creation_disabled") {
      return {
        code: "unsupported",
        message: "Boat isn't issuing API keys right now. Daintree asks again later.",
        at,
      };
    }
    switch (error.kind) {
      case "unauthorized":
        return {
          code: "credential-invalid",
          message: "Boat didn't accept this account's API key. Replace it in Settings → Hosts.",
          at,
        };
      case "forbidden":
        if (error.code === "api_key_expired") {
          return {
            code: "credential-invalid",
            message:
              "This account's API key has expired. Create a new key on Boat and replace it in Settings → Hosts.",
            at,
          };
        }
        if (error.code === "api_key_org_mismatch") {
          return {
            code: "permission",
            message:
              "This key belongs to another Boat organization than the one this account bills.",
            at,
          };
        }
        if (error.code === "machine_class_plan_required") {
          return { code: "billing", message: `Boat refused this machine size: ${said}`, at };
        }
        return {
          code: "permission",
          message: `This API key isn't allowed to do that (${said}). Give the key the permission on Boat, or use another key.`,
          at,
        };
      case "payment-required":
        return { code: "billing", message: `Boat needs a billing change first: ${said}`, at };
      case "rate-limited":
        return { code: "rate-limited", message: `Boat's start limit was reached: ${said}`, at };
      case "no-capacity":
        return {
          code: "capacity",
          message: "Boat has no machine ready right now. Try again shortly.",
          at,
        };
      case "not-found":
        return {
          code: "not-found",
          message: "Boat doesn't know this machine in this account's scope.",
          at,
        };
      case "conflict":
        if (error.code === "snapshot_data_expired") {
          return {
            code: "data-expired",
            message:
              "Boat deleted this machine's saved disk after its retention period. It can't be started.",
            at,
          };
        }
        return { code: "failed", message: said, at };
      case "network":
      case "timeout":
        return { code: "provider-unreachable", message: "Couldn't reach Boat.", at };
      case "server":
        return { code: "provider-unreachable", message: `Boat had a problem: ${said}`, at };
      case "cancelled":
        return { code: "failed", message: "Cancelled.", at };
      default:
        return { code: "failed", message: said, at };
    }
  }
}
