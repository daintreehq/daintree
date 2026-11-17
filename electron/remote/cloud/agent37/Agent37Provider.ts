import type {
  CloudAccountCheckResult,
  CloudCredentialValues,
  CloudHostError,
  CloudMachineType,
  CloudProviderInfo,
} from "../../../../shared/types/cloudHosts.js";
import type {
  CloudProvider,
  ProviderCatalog,
  ProviderCreateRequest,
  ProviderCredentials,
  ProviderResource,
  ProviderSshAccess,
} from "../provider.js";
import { AppError } from "../../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import {
  Agent37ApiError,
  Agent37Client,
  redactAgent37Text,
  type Agent37RequestContext,
} from "./Agent37Client.js";
import type { Agent37Instance } from "./agent37Schemas.js";
import { agent37MachineState } from "./agent37State.js";

/** How long an instance Daintree creates may idle before Agent 37 sleeps it. */
export const AGENT37_IDLE_SECONDS = 900;

/**
 * The login whose home is the instance's mounted disk on every system
 * template (`/home/node`), the one folder an Agent 37 update keeps, so a Host
 * installed in it survives stops, starts and updates alike.
 */
export const AGENT37_SSH_USER = "node";

/** How long Agent 37 says a newly registered key takes to reach instances already running. */
export const AGENT37_KEY_DELIVERY_MS = 2 * 60_000;

/** The plain Linux sandbox (Node, Python, git, build tools) with no agent of its own. */
const TEMPLATE = "agent37-base";
/** The cheapest type, and the only one Agent 37 runs in every region. */
const INSTANCE_TYPE = "default";
/** What Daintree's key is called among the workspace's keys. */
const SSH_KEY_NAME = "Daintree";

/** Agent 37's published monthly rates for a default instance, and the hours they are spread over. */
const RATES = { vcpu: 0.8, memoryGB: 0.7, diskGB: 0.09, hoursPerMonth: 730 };

interface Shape {
  id: string;
  label: string;
  vcpu: number;
  memoryGB: number;
  diskGB: number;
}

/**
 * The shapes every template offers, smallest first. Disk is chosen here
 * rather than left at Agent 37's per-shape default (4 GB on the smallest) so a
 * Host install and a few repositories fit; it bills at the disk rate while
 * the machine is stopped or asleep.
 */
const SHAPES: readonly Shape[] = [
  { id: "2x4", label: "Small", vcpu: 2, memoryGB: 4, diskGB: 12 },
  { id: "4x8", label: "Medium", vcpu: 4, memoryGB: 8, diskGB: 16 },
  { id: "4x16", label: "Large", vcpu: 4, memoryGB: 16, diskGB: 24 },
  { id: "4x32", label: "Extra large", vcpu: 4, memoryGB: 32, diskGB: 32 },
];

/** Agent 37 keeps instance names to 60 characters. */
const MAX_NAME_LENGTH = 60;

function hourly(shape: Shape): number {
  const monthly =
    shape.vcpu * RATES.vcpu + shape.memoryGB * RATES.memoryGB + shape.diskGB * RATES.diskGB;
  return Math.round((monthly / RATES.hoursPerMonth) * 10_000) / 10_000;
}

function isoFromEpochSeconds(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

/**
 * The shape Daintree offers for an instance, only on an exact match of type,
 * cores, memory and disk: its price is then the catalog's. Any other instance
 * has no size id, and its price reads as unknown rather than as a near one.
 */
function shapeOf(instance: Agent37Instance): string | null {
  if ((instance.type ?? INSTANCE_TYPE) !== INSTANCE_TYPE) return null;
  const resources = instance.resources;
  return (
    SHAPES.find(
      (shape) =>
        shape.vcpu === resources?.cpu &&
        shape.memoryGB === resources?.memory &&
        shape.diskGB === resources?.disk
    )?.id ?? null
  );
}

/** Daintree's labels live in the instance's metadata, which Agent 37 stores and never reads. */
function labelsOf(instance: Agent37Instance): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(instance.metadata ?? {})) {
    if (typeof value === "string") labels[key] = value;
  }
  return labels;
}

function errorOf(instance: Agent37Instance): string | null {
  if (instance.past_due) {
    return "Agent 37 suspended it because the workspace wallet ran out. Top up the wallet to start it again.";
  }
  const machine = agent37MachineState(instance.status);
  if (machine !== "error" && machine !== "stopped") return null;
  const said = instance.status_reason?.message;
  return said ? redactAgent37Text(said) : null;
}

export function agent37Resource(instance: Agent37Instance): ProviderResource {
  const idleSeconds = instance.idle_timeout_seconds;
  return {
    resourceId: instance.id,
    name: instance.name ?? "",
    machine: agent37MachineState(instance.status),
    rawState: instance.status,
    machineType: shapeOf(instance),
    vcpu: instance.resources?.cpu ?? null,
    memoryGB: instance.resources?.memory ?? null,
    autoStopAt: null,
    lifetimeSeconds: null,
    // Set only while it sleeps; an explicit stop isn't timed in the instance.
    stoppedAt: isoFromEpochSeconds(instance.slept_at),
    createdAt: isoFromEpochSeconds(instance.created),
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: false,
    labels: labelsOf(instance),
    restricted: false,
    error: errorOf(instance),
    asleep: instance.status === "sleeping",
    ...(typeof instance.auto_sleep === "boolean"
      ? {
          idleSleep: {
            enabled: instance.auto_sleep,
            idleSeconds: typeof idleSeconds === "number" && idleSeconds > 0 ? idleSeconds : null,
          },
        }
      : {}),
  };
}

function ctx(credentials: ProviderCredentials): Agent37RequestContext {
  const apiKey = credentials.values.apiKey;
  // Never sent without one: an empty bearer would only come back as Agent 37's refusal.
  if (!apiKey) throw new Agent37ApiError("unauthorized", "No API key", null, null);
  return { apiKey, signal: credentials.signal };
}

/** A key is bound to one workspace, and no endpoint names it: it is the only scope there is. */
const WORKSPACE_SCOPE: CloudAccountCheckResult["scopes"][number] = {
  scope: { kind: "workspace", id: "workspace", name: "Workspace" },
  active: true,
};

/** Registering Daintree's key failed before the create was sent: nothing was asked for. */
class Agent37KeyNotRegistered extends Error {
  constructor(readonly reason: CloudHostError) {
    super(reason.message);
    this.name = "Agent37KeyNotRegistered";
  }
}

/** The instance isn't up to take a tunnel now; a dial would wake a sleeper or fail on a stopped one. */
class Agent37NotAwake extends Error {
  constructor(readonly status: string) {
    super(`The Agent 37 instance is ${status}`);
    this.name = "Agent37NotAwake";
  }
}

/** Agent 37 refused the create's request itself (a 400): nothing was made, and its reason says why. */
class Agent37CreateRefused extends Error {
  constructor(readonly said: string) {
    super(said);
    this.name = "Agent37CreateRefused";
  }
}

/** A machine that was running before Daintree's key was registered, which it may not have yet. */
class Agent37KeyInDelivery extends Error {
  constructor(readonly waitMs: number) {
    super("Agent 37 is still delivering Daintree's SSH key to this machine");
    this.name = "Agent37KeyInDelivery";
  }
}

export interface Agent37ProviderOptions {
  now?: () => number;
}

export class Agent37Provider implements CloudProvider {
  readonly id = "agent37" as const;
  /** Agent 37 takes no idempotency key: a create sent again would be another instance. */
  readonly createReplay = "lookup-only" as const;
  private readonly now: () => number;
  /**
   * Keys this process registered, per API origin: when, by this device's
   * clock (delivery to running machines lags it), and by Agent 37's own.
   */
  private readonly registered = new Map<string, { localAt: number; serverAt: number | null }>();
  /** Each key with an instance this process created after registering it, which booted with it. */
  private readonly bootedWithKey = new Set<string>();

  constructor(
    private readonly clientFor: (apiUrl: string) => Agent37Client,
    options: Agent37ProviderOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  info(platform: NodeJS.Platform): CloudProviderInfo {
    return {
      id: "agent37",
      name: "Agent 37",
      description: "Persistent Linux machines that sleep when idle and keep their disk.",
      apiKeyUrl: "https://www.agent37.com/dashboard/cloud/api-keys",
      dashboardUrl: "https://www.agent37.com/dashboard/cloud",
      docsUrl: "https://www.agent37.com/docs/agents-api",
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
          // The whole disk survives a stop and start; only the container's memory doesn't.
          kept: "Files and installed programs",
          lost: "running processes and memory",
          retentionDays: null,
          saveRetryBilled: false,
          stoppedComputeBilled: false,
          stoppedStorageBilled: true,
        },
        typicalStartSeconds: null,
        lifetime: { kind: "idle-sleep", idleSeconds: AGENT37_IDLE_SECONDS },
        sshTrust: "provider-tunnel",
        transport: "provider-command",
        tunnel: {
          command: "agent37",
          args: ["tunnel", "%h"],
          installUrl: "https://www.agent37.com/docs/agents-api/ssh",
        },
        provisioning: {
          location: "none",
          image: "none",
          network: "none",
          sshKey: "at-create",
        },
        deletion: true,
      },
      unsupportedReason:
        platform === "win32"
          ? "Cloud hosts need Daintree for macOS or Linux. Daintree for Windows reaches hosts through WSL only."
          : null,
    };
  }

  async checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal?: AbortSignal
  ): Promise<CloudAccountCheckResult> {
    const apiKey = values.apiKey;
    if (!apiKey) {
      throw new AppError({
        code: "VALIDATION",
        message: "Paste an API key.",
        userMessage: "Paste an API key.",
      });
    }
    // No endpoint says who a key belongs to; reading its workspace's wallet proves it works.
    await this.clientFor(apiUrl).billing({ apiKey, signal });
    return { identity: null, scopes: [WORKSPACE_SCOPE] };
  }

  async validate(credentials: ProviderCredentials): Promise<{ identity: string | null }> {
    await this.clientFor(credentials.apiUrl).billing(ctx(credentials));
    return { identity: null };
  }

  async catalog(credentials: ProviderCredentials): Promise<ProviderCatalog> {
    const billing = await this.clientFor(credentials.apiUrl).billing(ctx(credentials));
    const machineTypes: CloudMachineType[] = SHAPES.map((shape) => ({
      id: shape.id,
      label: shape.label,
      vcpu: shape.vcpu,
      memoryGB: shape.memoryGB,
      hourlyDollars: hourly(shape),
      available: true,
      reason: null,
    }));
    return {
      machineTypes,
      // Advisory: room, the awake-memory limit and the wallet are Agent 37's to refuse.
      canStart: billing.past_due !== true,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
    };
  }

  async list(
    credentials: ProviderCredentials,
    options: { label?: string } = {}
  ): Promise<ProviderResource[]> {
    const instances = await this.clientFor(credentials.apiUrl).listInstances(ctx(credentials));
    const resources = instances.map(agent37Resource);
    if (!options.label) return resources;
    // Agent 37 has no filter of its own; a label is `key=value` over the metadata.
    const at = options.label.indexOf("=");
    const key = at < 0 ? options.label : options.label.slice(0, at);
    const value = at < 0 ? null : options.label.slice(at + 1);
    return resources.filter((resource) =>
      value === null ? Object.hasOwn(resource.labels, key) : resource.labels[key] === value
    );
  }

  async inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource> {
    return agent37Resource(
      await this.clientFor(credentials.apiUrl).getInstance(ctx(credentials), resourceId)
    );
  }

  async create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource> {
    const shape = SHAPES.find((entry) => entry.id === request.machineType);
    if (!shape) {
      throw new Agent37ApiError("invalid-request", "Not an Agent 37 machine size", null, null);
    }
    if (!request.publicKey) {
      throw new Agent37KeyNotRegistered({
        code: "ssh-authorization",
        message: "Daintree had no SSH key to give Agent 37, so nothing was created.",
        at: this.now(),
      });
    }
    const client = this.clientFor(credentials.apiUrl);
    // First: an instance boots with every key its workspace has, while one already running
    // takes minutes to see a new one.
    await this.register(credentials, request.publicKey, true);
    let instance: Agent37Instance;
    try {
      instance = await client.createInstance(ctx(credentials), {
        template: TEMPLATE,
        type: INSTANCE_TYPE,
        resources: { cpu: shape.vcpu, memory: shape.memoryGB, disk: shape.diskGB },
        name: request.name.slice(0, MAX_NAME_LENGTH),
        metadata: request.labels,
        auto_sleep: true,
        idle_timeout_seconds: AGENT37_IDLE_SECONDS,
      });
    } catch (error) {
      // A request Agent 37 rejected as invalid provisioned nothing; say so, with its reason.
      // Only a 400: other statuses the client calls invalid (a 408 from a proxy) prove nothing.
      if (error instanceof Agent37ApiError && error.status === 400) {
        throw new Agent37CreateRefused(error.message);
      }
      throw error;
    }
    this.bootedWithKey.add(`${this.keyId(credentials, request.publicKey)}\n${instance.id}`);
    return agent37Resource(instance);
  }

  async start(
    credentials: ProviderCredentials,
    resourceId: string,
    _options: { lifetimeSeconds?: number | null }
  ): Promise<ProviderResource | null> {
    // The ack names only the id and status; the lifecycle reads the instance itself.
    await this.clientFor(credentials.apiUrl).startInstance(ctx(credentials), resourceId);
    return null;
  }

  async stop(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderResource | null> {
    await this.clientFor(credentials.apiUrl).stopInstance(ctx(credentials), resourceId);
    return null;
  }

  async rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void> {
    await this.clientFor(credentials.apiUrl).updateInstance(ctx(credentials), resourceId, {
      name: name.slice(0, MAX_NAME_LENGTH),
    });
  }

  async delete(credentials: ProviderCredentials, resourceId: string): Promise<void> {
    await this.clientFor(credentials.apiUrl).deleteInstance(ctx(credentials), resourceId);
  }

  /** A machine Daintree created booted with the workspace's key: only how to reach it is asked. */
  async sshAccess(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderSshAccess> {
    return this.accessTo(await this.awakeInstance(credentials, resourceId));
  }

  /**
   * An imported machine may predate Daintree's key: it is registered with the
   * workspace (once), and a machine already running waits out its delivery.
   */
  async authorizeSsh(
    credentials: ProviderCredentials,
    resourceId: string,
    publicKey: string
  ): Promise<ProviderSshAccess> {
    const instance = await this.awakeInstance(credentials, resourceId);
    await this.register(credentials, publicKey, false);
    // A key registered moments ago reaches a machine that was already up only within minutes;
    // until then its sshd refuses the key, which says nothing useful about why. Agent 37's own
    // clock says whether the instance came after the key; this device's says how long is left.
    const keyId = this.keyId(credentials, publicKey);
    const registered = this.registered.get(keyId);
    if (registered && !this.bootedWithKey.has(`${keyId}\n${instance.id}`)) {
      const waitMs = registered.localAt + AGENT37_KEY_DELIVERY_MS - this.now();
      const predatesKey =
        registered.serverAt === null ||
        typeof instance.created !== "number" ||
        instance.created <= registered.serverAt;
      if (waitMs <= 0) this.registered.delete(keyId);
      else if (predatesKey) throw new Agent37KeyInDelivery(waitMs);
    }
    return this.accessTo(instance);
  }

  /** The instance as Agent 37 reports it now, refused unless it is up to take a tunnel. */
  private async awakeInstance(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<Agent37Instance> {
    const instance = await this.clientFor(credentials.apiUrl).getInstance(
      ctx(credentials),
      resourceId
    );
    // Its own answer is the last word before a tunnel opens: one to a sleeper would wake it.
    if (agent37MachineState(instance.status) !== "running") {
      throw new Agent37NotAwake(instance.status);
    }
    return instance;
  }

  /** The tunnel finds the instance by this name: there is no address to dial and no key to pin. */
  private accessTo(instance: Agent37Instance): ProviderSshAccess {
    return {
      user: AGENT37_SSH_USER,
      endpoint: { host: `${instance.id}.agent37.app`, port: 22 },
      hostKey: null,
    };
  }

  private keyId(credentials: ProviderCredentials, publicKey: string): string {
    return `${credentials.apiUrl}\n${publicKey.trim().split(/\s+/).slice(0, 2).join(" ")}`;
  }

  /**
   * Registers Daintree's key with the workspace. One already there is the
   * same outcome. Before a create, any failure means nothing was created.
   */
  private async register(
    credentials: ProviderCredentials,
    publicKey: string,
    beforeCreate: boolean
  ): Promise<void> {
    let answer: { created: boolean; at: number | null };
    try {
      answer = await this.clientFor(credentials.apiUrl).registerSshKey(
        ctx(credentials),
        publicKey,
        SSH_KEY_NAME
      );
    } catch (error) {
      if (!beforeCreate) throw error;
      const described = this.describeError(error);
      // A refusal the lifecycle already knows as one keeps its own words and recovery.
      if (
        described.code === "credential-invalid" ||
        described.code === "permission" ||
        described.code === "billing"
      ) {
        throw error;
      }
      throw new Agent37KeyNotRegistered({
        code: "ssh-authorization",
        message: `Agent 37 didn't take Daintree's SSH key, so nothing was created: ${described.message}`,
        at: described.at,
      });
    }
    if (answer.created) {
      this.registered.set(this.keyId(credentials, publicKey), {
        localAt: this.now(),
        serverAt: answer.at,
      });
    }
  }

  describeError(error: unknown): CloudHostError {
    const at = this.now();
    if (error instanceof Agent37KeyNotRegistered) return { ...error.reason, at };
    if (error instanceof Agent37CreateRefused) {
      return { code: "unsupported", message: `Agent 37 refused the machine: ${error.said}`, at };
    }
    if (error instanceof Agent37NotAwake) {
      // Still coming up is worth retrying; asleep or stopped waits for a person's Start.
      return agent37MachineState(error.status) === "starting"
        ? { code: "provider-unreachable", message: "Agent 37 is still starting the machine.", at }
        : {
            code: "failed",
            message: `Agent 37 says the machine is ${error.status} now. Start it to connect.`,
            at,
          };
    }
    if (error instanceof Agent37KeyInDelivery) {
      const seconds = Math.max(1, Math.ceil(error.waitMs / 1000));
      // A wait, not a refusal: as "unreachable" the link keeps trying by itself until it's over.
      return {
        code: "provider-unreachable",
        message: `Agent 37 is still delivering Daintree's SSH key to this machine, which takes up to two minutes after it's first registered. About ${seconds} seconds to go.`,
        at,
      };
    }
    if (!(error instanceof Agent37ApiError)) {
      return {
        code: "failed",
        message:
          error instanceof AppError && error.userMessage
            ? error.userMessage
            : formatErrorMessage(error, "Something went wrong talking to Agent 37"),
        at,
      };
    }
    const said = error.message;
    if (error.busy) {
      return {
        code: "failed",
        message: "Agent 37 is still putting the machine to sleep. Try again in a minute.",
        at,
      };
    }
    switch (error.kind) {
      case "unauthorized":
        return {
          code: "credential-invalid",
          message: "Agent 37 didn't accept this account's API key. Replace it in Settings → Hosts.",
          at,
        };
      case "forbidden":
        if (error.code === "ip_not_allowed") {
          return {
            code: "permission",
            message: `This API key only works from the addresses on its allowlist, and this device isn't one: ${said}`,
            at,
          };
        }
        return {
          code: "permission",
          message: `This API key isn't allowed to do that (${said}).`,
          at,
        };
      case "payment-required":
        return {
          code: "billing",
          message: `Agent 37 needs more balance in the workspace wallet: ${said}`,
          at,
        };
      case "rate-limited":
        return { code: "rate-limited", message: `Agent 37 asked to slow down: ${said}`, at };
      case "no-capacity":
        return {
          code: "capacity",
          message: "Agent 37 has no room for this machine right now. Try again shortly.",
          at,
        };
      case "not-found":
        return {
          code: "not-found",
          message: "Agent 37 doesn't know this machine in this account's workspace.",
          at,
        };
      case "conflict":
        if (error.code === "instance_limit_reached") {
          return {
            code: "billing",
            message: `The workspace is at Agent 37's limit for machines running at once: ${said}`,
            at,
          };
        }
        if (error.code === "capacity_unavailable") {
          return {
            code: "capacity",
            message: "Agent 37 has no room to start this machine right now. Try again shortly.",
            at,
          };
        }
        return { code: "failed", message: said, at };
      case "network":
      case "timeout":
        return { code: "provider-unreachable", message: "Couldn't reach Agent 37.", at };
      case "server":
        if (error.code === "provisioning_failed") {
          return { code: "failed", message: `Agent 37 couldn't do that: ${said}`, at };
        }
        return { code: "provider-unreachable", message: `Agent 37 had a problem: ${said}`, at };
      case "cancelled":
        return { code: "failed", message: "Cancelled.", at };
      default:
        return { code: "failed", message: said, at };
    }
  }
}
