import type {
  CloudAccountCheckResult,
  CloudCredentialValues,
  CloudHostError,
  CloudMachineType,
  CloudProviderInfo,
  CloudProvisioningChoice,
} from "../../../../shared/types/cloudHosts.js";
import type {
  CloudProvider,
  GuestPowerOffCheck,
  ProviderCatalog,
  ProviderCreateRequest,
  ProviderCredentials,
  ProviderResource,
  ProviderSshAccess,
} from "../provider.js";
import { AppError } from "../../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { normalizeHostKey } from "../sshEndpoint.js";
import { GCE_PROJECT_ID, parseGceServiceAccountKey, type GceTokenSource } from "./gceAuth.js";
import {
  GCE_INSTANCE_ID,
  GCE_NAME,
  gceSleep,
  mayHaveReachedCompute,
  operationError,
  type GceClient,
  type GceRequestContext,
} from "./GceClient.js";
import { GceApiError, redactGceText } from "./gceErrors.js";
import type { GceInstance, GceOperation } from "./gceSchemas.js";
import { gceMachineState } from "./gceState.js";

/** The user every machine takes Daintree's key for: never root, never someone's own name. */
export const GCE_SSH_USER = "daintree";

/** The sizes offered: general-purpose x86 E2 machines, small to large. */
const MACHINE_TYPES: readonly { id: string; vcpu: number; memoryGB: number }[] = [
  { id: "e2-standard-2", vcpu: 2, memoryGB: 8 },
  { id: "e2-standard-4", vcpu: 4, memoryGB: 16 },
  { id: "e2-standard-8", vcpu: 8, memoryGB: 32 },
];

/** Public image families whose guest environment publishes host keys on first boot. */
const IMAGES: readonly { id: string; label: string; description: string }[] = [
  {
    id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
    label: "Ubuntu 24.04 LTS",
    description: "x86-64, the family's newest image",
  },
  {
    id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts",
    label: "Ubuntu 22.04 LTS",
    description: "x86-64, the family's newest image",
  },
  {
    id: "projects/debian-cloud/global/images/family/debian-12",
    label: "Debian 12",
    description: "x86-64, the family's newest image",
  },
];

const BOOT_DISK_GB = 30;
const PREFERRED_ZONE = "us-central1-a";
/** How long a create, start or delete waits for Compute Engine to finish it. */
const OPERATION_DEADLINE_MS = 5 * 60_000;
/** A first boot publishes its host keys within a minute or two. */
const HOST_KEY_WAIT_MS = 3 * 60_000;
/** Guest attributes allow ten reads a minute per machine. */
const HOST_KEY_POLL_MS = 10_000;
const HOST_KEY_PREFERENCE = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
];
const LABEL_KEY = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL_VALUE = /^[a-z0-9_-]{0,63}$/;
const RESOURCE_ID = /^projects\/([^/]+)\/zones\/([a-z0-9-]+)\/instances\/(\d{1,20})$/;
const SUBNETWORK_ID = /^regions\/([a-z0-9-]+)\/subnetworks\/([a-z0-9-]+)$/;
const PUBLIC_KEY =
  /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}(?: [\x21-\x7e][\x20-\x7e]*)?$/;

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

/** The last path segment of a Compute Engine URL: `.../zones/us-central1-a` is `us-central1-a`. */
function lastSegment(url: string | undefined): string | null {
  if (!url) return null;
  const tail = url.split("/").pop();
  return tail && tail.length > 0 ? tail : null;
}

function idString(value: string | number): string {
  return typeof value === "number" ? String(value) : value;
}

export function gceResourceId(project: string, zone: string, instanceId: string): string {
  return `projects/${project}/zones/${zone}/instances/${instanceId}`;
}

/** The project, zone and numeric id a resource id names; refused unless it is this account's project. */
function parseResourceId(resourceId: string, project: string): { zone: string; instance: string } {
  const match = RESOURCE_ID.exec(resourceId);
  if (!match || !GCE_NAME.test(match[2]!) || !GCE_INSTANCE_ID.test(match[3]!)) {
    throw new GceApiError("invalid-request", "Not a Compute Engine machine id", null, null);
  }
  if (match[1] !== project) {
    throw new GceApiError(
      "invalid-request",
      "That machine belongs to another Google Cloud project than this account's",
      null,
      null
    );
  }
  return { zone: match[2]!, instance: match[3]! };
}

/** The account's project: the one the key was checked against when it was connected. */
function projectOf(credentials: ProviderCredentials): string {
  if (!GCE_PROJECT_ID.test(credentials.scopeId)) {
    throw new GceApiError("invalid-request", "Not a Google Cloud project id", null, null);
  }
  return credentials.scopeId;
}

/** A Compute Engine instance as a provider resource. */
export function gceResource(instance: GceInstance, project: string): ProviderResource {
  const zone = lastSegment(instance.zone);
  const id = idString(instance.id);
  if (!zone || !GCE_NAME.test(zone)) {
    throw new GceApiError(
      "bad-response",
      "Compute Engine didn't say the machine's zone",
      null,
      null
    );
  }
  const machine = gceMachineState(instance.status);
  const machineType = lastSegment(instance.machineType);
  const spec = MACHINE_TYPES.find((entry) => entry.id === machineType);
  const scheduling = instance.scheduling;
  const seconds = scheduling?.maxRunDuration?.seconds;
  const limited =
    scheduling?.instanceTerminationAction === "STOP" &&
    seconds !== undefined &&
    Number(seconds) > 0;
  const live = machine === "running" || machine === "starting";
  return {
    resourceId: gceResourceId(project, zone, id),
    name: instance.name,
    machine,
    rawState: instance.status,
    machineType,
    vcpu: spec?.vcpu ?? null,
    memoryGB: spec?.memoryGB ?? null,
    // Google's own reckoning of when it stops the machine, which counts from this run's start.
    autoStopAt: live ? (instance.resourceStatus?.scheduling?.terminationTimestamp ?? null) : null,
    lifetimeSeconds: limited ? Number(seconds) : null,
    stoppedAt:
      machine !== "stopped"
        ? null
        : instance.status === "SUSPENDED"
          ? (instance.lastSuspendedTimestamp ?? null)
          : (instance.lastStopTimestamp ?? null),
    createdAt: instance.creationTimestamp ?? null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: false,
    labels: instance.labels ?? {},
    restricted: false,
    error: instance.statusMessage ? redactGceText(instance.statusMessage) : null,
  };
}

/** A Compute Engine name for the machine: the person's name as a slug, kept apart by the create's key. */
export function gceInstanceName(name: string, idempotencyKey: string): string {
  const suffix =
    idempotencyKey
      .replace(/[^a-f0-9]/gi, "")
      .toLowerCase()
      .slice(0, 8) || "daintree";
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const room = 63 - suffix.length - 1;
  const base = (/^[a-z]/.test(slug) ? slug : `dt-${slug}`).slice(0, room).replace(/-+$/, "");
  return `${base || "dt"}-${suffix}`;
}

/**
 * The termination policy a start replaces: a stop after the limit, or none.
 * Explicit nulls clear a field; a deadline set elsewhere (`terminationTime`)
 * is cleared too, since it can't stand beside a run duration.
 */
function lifetimeScheduling(lifetimeSeconds: number | null): Record<string, unknown> {
  return lifetimeSeconds === null
    ? { maxRunDuration: null, instanceTerminationAction: null, terminationTime: null }
    : {
        maxRunDuration: { seconds: String(lifetimeSeconds) },
        instanceTerminationAction: "STOP",
        terminationTime: null,
      };
}

/** Whether the VM's whole termination policy is exactly the limit wanted, and nothing else could end a run. */
function policyIs(instance: GceInstance, lifetimeSeconds: number | null): boolean {
  const scheduling = instance.scheduling;
  if (scheduling?.terminationTime) return false;
  const duration = scheduling?.maxRunDuration;
  const action = scheduling?.instanceTerminationAction;
  if (lifetimeSeconds === null) {
    return duration === undefined && (action === undefined || action === "STOP");
  }
  return (
    action === "STOP" &&
    duration?.seconds !== undefined &&
    Number(duration.seconds) === lifetimeSeconds &&
    !duration.nanos
  );
}

function ipv4NatAddress(instance: GceInstance): string | null {
  for (const nic of instance.networkInterfaces ?? []) {
    for (const config of nic.accessConfigs ?? []) {
      const ip = config.natIP;
      if (ip && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip;
    }
  }
  return null;
}

function hasExternalAccess(instance: GceInstance): boolean {
  return (instance.networkInterfaces ?? []).some((nic) => (nic.accessConfigs ?? []).length > 0);
}

export interface GceProviderOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface GceEndpoints {
  client: GceClient;
  tokens: GceTokenSource;
}

/**
 * Google Compute Engine: one service-account key and one project per account,
 * VMs created in a chosen zone, image and subnet with Daintree's SSH key in
 * their metadata, a runtime limit set at create (changeable only while
 * stopped), and host keys read from the guest attributes the VM publishes.
 */
export class GceProvider implements CloudProvider {
  readonly id = "gce" as const;
  private readonly shutdown = new AbortController();

  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly endpointsFor: (apiUrl: string) => GceEndpoints,
    options: GceProviderOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? gceSleep;
  }

  /** Stops every wait this provider is doing on its own (host keys, operations). */
  dispose(): void {
    this.shutdown.abort();
  }

  info(platform: NodeJS.Platform): CloudProviderInfo {
    return {
      id: "gce",
      name: "Google Cloud",
      description:
        "Compute Engine VMs in your own Google Cloud project. A stopped VM keeps its disk, which Google bills while it's kept.",
      apiKeyUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
      dashboardUrl: "https://console.cloud.google.com/compute/instances",
      docsUrl: "https://cloud.google.com/compute/docs",
      // Its machines power themselves off once idle (#17362): a limit by default would only cut
      // off agents still working.
      defaultLifetimeHours: null,
      credentialFields: [
        {
          id: "serviceAccountKey",
          label: "Service account key",
          secret: true,
          input: "key-file",
          required: true,
          help: "A JSON key for a service account that can manage Compute Engine VMs.",
        },
        {
          id: "projectId",
          label: "Project",
          secret: false,
          input: "single-line",
          required: false,
          help: "The project VMs are created and billed in. Leave it blank for the key's own project.",
        },
      ],
      capabilities: {
        persistence: {
          kept: "Files on its boot disk",
          lost: "Memory and running processes",
          retentionDays: null,
          saveRetryBilled: false,
          stoppedComputeBilled: false,
          stoppedStorageBilled: true,
        },
        typicalStartSeconds: null,
        lifetime: { kind: "fixed-at-create", canChangeWhileStopped: true },
        sshTrust: "pinned-from-api",
        transport: "direct",
        tunnel: null,
        provisioning: {
          location: "required",
          image: "required",
          network: "required",
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

  /** A request context for this account; every wait is also cut short when the provider is disposed. */
  private ctx(credentials: ProviderCredentials, fresh = false): GceRequestContext {
    const raw = credentials.values.serviceAccountKey;
    // Never sent without one: an empty key would only come back as Google's refusal.
    if (!raw) throw new GceApiError("unauthorized", "No service account key", null, null);
    const key = parseGceServiceAccountKey(raw);
    const { tokens } = this.endpointsFor(credentials.apiUrl);
    const signal = credentials.signal
      ? AbortSignal.any([credentials.signal, this.shutdown.signal])
      : this.shutdown.signal;
    let first = fresh;
    return {
      project: projectOf(credentials),
      signal,
      authorize: (again) => {
        const now = first || again;
        first = false;
        return tokens.token(key, signal, now);
      },
    };
  }

  private client(credentials: ProviderCredentials): GceClient {
    return this.endpointsFor(credentials.apiUrl).client;
  }

  async checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal?: AbortSignal
  ): Promise<CloudAccountCheckResult> {
    const key = parseGceServiceAccountKey(values.serviceAccountKey ?? "");
    const project = values.projectId?.trim() || key.projectId;
    if (!project) {
      throw invalid("That key file doesn't name a project. Enter the project VMs go in.");
    }
    if (!GCE_PROJECT_ID.test(project)) {
      throw invalid(
        "That isn't a Google Cloud project id: it's 6 to 30 lowercase letters, digits and hyphens."
      );
    }
    const found = await this.client({ values, scopeId: project, apiUrl }).getProject(
      this.ctx({ values, scopeId: project, apiUrl, signal }, true)
    );
    return {
      identity: key.clientEmail,
      scopes: [{ scope: { kind: "project", id: project, name: found.name }, active: true }],
    };
  }

  async validate(credentials: ProviderCredentials): Promise<{ identity: string | null }> {
    const key = parseGceServiceAccountKey(credentials.values.serviceAccountKey ?? "");
    // A fresh token: one issued before the key was disabled would still pass.
    await this.client(credentials).getProject(this.ctx(credentials, true));
    return { identity: key.clientEmail };
  }

  async catalog(credentials: ProviderCredentials): Promise<ProviderCatalog> {
    const client = this.client(credentials);
    const ctx = this.ctx(credentials);
    const [zones, typesByZone, subnetworks] = await Promise.all([
      client.listZones(ctx),
      client.machineTypesByZone(
        ctx,
        MACHINE_TYPES.map((type) => type.id)
      ),
      client.listSubnetworks(ctx),
    ]);
    // Only zones that offer every size, so no pick of zone and size can be refused for the pair.
    const offered = zones
      .filter((zone) => zone.status === "UP" && GCE_NAME.test(zone.name))
      .filter((zone) => {
        const types = new Set((typesByZone.get(zone.name) ?? []).map((type) => type.name));
        return MACHINE_TYPES.every((type) => types.has(type.id));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const regionOf = new Map(offered.map((zone) => [zone.name, lastSegment(zone.region)]));
    const locations: CloudProvisioningChoice[] = offered.map((zone) => ({
      id: zone.name,
      label: zone.name,
      description: regionOf.get(zone.name) ? `Region ${regionOf.get(zone.name)}` : null,
      available: true,
      reason: null,
      locations: null,
    }));
    const subnets = subnetworks
      .filter(
        (subnet) =>
          (subnet.purpose === undefined ||
            subnet.purpose === "PRIVATE" ||
            subnet.purpose === "PRIVATE_RFC_1918") &&
          (subnet.stackType === undefined || subnet.stackType.startsWith("IPV4")) &&
          GCE_NAME.test(subnet.name)
      )
      .flatMap((subnet) => {
        const region = lastSegment(subnet.region);
        if (!region || !GCE_NAME.test(region)) return [];
        const network = lastSegment(subnet.network) ?? subnet.name;
        const choice: CloudProvisioningChoice = {
          id: `regions/${region}/subnetworks/${subnet.name}`,
          label: network === subnet.name ? subnet.name : `${network} / ${subnet.name}`,
          description: subnet.ipCidrRange ? `${subnet.ipCidrRange} in ${region}` : region,
          available: true,
          reason: null,
          locations: offered
            .filter((zone) => regionOf.get(zone.name) === region)
            .map((zone) => zone.name),
        };
        return [{ choice, onDefault: network === "default" }];
      })
      // The project's default network first, so it's what a zone starts with.
      .sort(
        (a, b) =>
          Number(b.onDefault) - Number(a.onDefault) ||
          a.choice.label.localeCompare(b.choice.label) ||
          a.choice.id.localeCompare(b.choice.id)
      );
    const networks = subnets.map((entry) => entry.choice);
    const machineTypes: CloudMachineType[] = MACHINE_TYPES.map((type) => ({
      id: type.id,
      label: type.id,
      vcpu: type.vcpu,
      memoryGB: type.memoryGB,
      hourlyDollars: null,
      available: offered.length > 0,
      reason: offered.length > 0 ? null : "No zone in this project offers it",
    }));
    return {
      machineTypes,
      canStart: true,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
      provisioning: {
        location: {
          label: "Zone",
          choices: locations,
          defaultId: locations.some((zone) => zone.id === PREFERRED_ZONE) ? PREFERRED_ZONE : null,
        },
        image: {
          label: "Image",
          choices: IMAGES.map((image) => ({
            id: image.id,
            label: image.label,
            description: image.description,
            available: true,
            reason: null,
            locations: null,
          })),
          defaultId: IMAGES[0]!.id,
        },
        network: { label: "Subnet", choices: networks, defaultId: null },
      },
    };
  }

  async list(
    credentials: ProviderCredentials,
    options: { label?: string } = {}
  ): Promise<ProviderResource[]> {
    const project = projectOf(credentials);
    let label: { key: string; value: string } | undefined;
    if (options.label !== undefined) {
      const at = options.label.indexOf("=");
      const key = options.label.slice(0, at);
      const value = options.label.slice(at + 1);
      if (at < 0 || !LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) {
        throw new GceApiError("invalid-request", "Not a Compute Engine label", null, null);
      }
      label = { key, value };
    }
    const instances = await this.client(credentials).listInstances(this.ctx(credentials), label);
    return instances
      .map((instance) => gceResource(instance, project))
      .filter((resource) => !label || resource.labels[label.key] === label.value);
  }

  async inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource> {
    const project = projectOf(credentials);
    const { zone, instance } = parseResourceId(resourceId, project);
    return gceResource(
      await this.client(credentials).getInstance(this.ctx(credentials), zone, instance),
      project
    );
  }

  /**
   * A VM whose disks are all persistent (#17362): its own OS powering off
   * stops it, and a stopped VM keeps those disks. A local SSD's data isn't
   * kept, so a VM with one doesn't stop itself.
   */
  async checkGuestPowerOff(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<GuestPowerOffCheck> {
    const project = projectOf(credentials);
    const { zone, instance } = parseResourceId(resourceId, project);
    const target = { provider: "gce" as const, project, zone, instanceId: instance };
    const found = await this.client(credentials).getInstance(this.ctx(credentials), zone, instance);
    if (idString(found.id) !== instance) {
      return { eligible: false, target, problem: "Compute Engine described another VM." };
    }
    const disks = found.disks ?? [];
    if (disks.length === 0 || disks.some((disk) => disk.type !== "PERSISTENT")) {
      return {
        eligible: false,
        target,
        problem:
          "It has a disk that isn't persistent (a local SSD), whose data a stop doesn't keep.",
      };
    }
    return { eligible: true, target };
  }

  async create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource> {
    const project = projectOf(credentials);
    const zone = request.provisioning.location;
    const image = request.provisioning.image;
    const subnetwork = request.provisioning.network;
    const subnet = subnetwork ? SUBNETWORK_ID.exec(subnetwork) : null;
    if (!zone || !GCE_NAME.test(zone)) throw invalid("Choose a zone for the machine.");
    if (!image || !IMAGES.some((entry) => entry.id === image)) {
      throw invalid("Choose an image for the machine.");
    }
    if (!subnet || !zone.startsWith(`${subnet[1]}-`)) {
      throw invalid("Choose a subnet in the machine's region.");
    }
    if (!MACHINE_TYPES.some((type) => type.id === request.machineType)) {
      throw invalid("Choose a machine size.");
    }
    const publicKey = request.publicKey?.trim() ?? "";
    if (!PUBLIC_KEY.test(publicKey)) {
      throw invalid("This account's SSH public key can't be put on the machine.");
    }
    for (const [key, value] of Object.entries(request.labels)) {
      if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) {
        throw invalid(`Compute Engine can't label a machine ${key}=${value}.`);
      }
    }
    const ctx = this.ctx(credentials);
    const client = this.client(credentials);
    // The create's own key: a resend after a lost answer is the same request to Compute Engine.
    const operation = await client.insertInstance(
      ctx,
      zone,
      {
        name: gceInstanceName(request.name, request.idempotencyKey),
        description: `Daintree host: ${request.name}`.slice(0, 2048),
        machineType: `zones/${zone}/machineTypes/${request.machineType}`,
        labels: request.labels,
        metadata: {
          items: [
            { key: "ssh-keys", value: `${GCE_SSH_USER}:${publicKey}` },
            // Read at first boot: the guest publishes its host keys only when this was set before.
            { key: "enable-guest-attributes", value: "TRUE" },
            // OS Login would ignore the key above.
            { key: "enable-oslogin", value: "FALSE" },
          ],
        },
        disks: [
          {
            boot: true,
            autoDelete: true,
            type: "PERSISTENT",
            initializeParams: {
              sourceImage: image,
              diskSizeGb: String(BOOT_DISK_GB),
              diskType: `zones/${zone}/diskTypes/pd-balanced`,
            },
          },
        ],
        networkInterfaces: [
          {
            subnetwork: subnet[0],
            accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
          },
        ],
        scheduling:
          request.lifetimeSeconds === null
            ? {}
            : {
                maxRunDuration: { seconds: String(request.lifetimeSeconds) },
                instanceTerminationAction: "STOP",
              },
      },
      request.idempotencyKey
    );
    // Google took the request: from here a failure to read the outcome says nothing about whether it made one.
    let done: GceOperation;
    try {
      done =
        operation.status === "DONE"
          ? operation
          : await client.waitOperation(
              ctx,
              zone,
              operation.name,
              Date.now() + OPERATION_DEADLINE_MS
            );
    } catch (error) {
      throw unconfirmed(error);
    }
    const refused = operationError(done);
    // Only a zone out of room or a quota spent proves the insert made nothing; any other failure may have left a VM.
    if (refused) {
      throw refused.kind === "no-capacity" || refused.kind === "quota"
        ? refused
        : unconfirmed(refused);
    }
    if (done.status !== "DONE") {
      throw new GceApiError(
        "outcome-unknown",
        "Compute Engine is still creating the machine",
        null,
        null
      );
    }
    const target = done.targetId ?? operation.targetId;
    if (target === undefined) {
      throw new GceApiError(
        "outcome-unknown",
        "Compute Engine didn't say which machine it created",
        null,
        null
      );
    }
    try {
      return gceResource(await client.getInstance(ctx, zone, idString(target)), project);
    } catch (error) {
      throw unconfirmed(error);
    }
  }

  async start(
    credentials: ProviderCredentials,
    resourceId: string,
    options: { lifetimeSeconds?: number | null }
  ): Promise<ProviderResource | null> {
    const project = projectOf(credentials);
    const { zone, instance } = parseResourceId(resourceId, project);
    const ctx = this.ctx(credentials);
    const client = this.client(credentials);
    const before = await client.getInstance(ctx, zone, instance);
    const wanted = options.lifetimeSeconds;
    const changes = wanted !== undefined && !policyIs(before, wanted);
    if (before.status === "SUSPENDED") {
      if (changes) {
        throw invalid(
          "Google Cloud changes a machine's runtime limit only while it's fully stopped, and this one is suspended. Stop it in the Google Cloud console first, or keep its limit."
        );
      }
      await this.finish(client, ctx, zone, await client.resumeInstance(ctx, zone, instance));
    } else {
      if (changes) {
        // Compute Engine takes a new limit only while the VM is stopped, and replaces the whole policy.
        await this.finish(
          client,
          ctx,
          zone,
          await client.setScheduling(ctx, zone, instance, {
            ...before.scheduling,
            ...lifetimeScheduling(wanted),
          })
        );
        const after = await client.getInstance(ctx, zone, instance);
        if (!policyIs(after, wanted)) {
          throw new GceApiError(
            "invalid-request",
            "Compute Engine didn't keep the new runtime limit, so the machine wasn't started",
            null,
            null
          );
        }
      }
      await this.finish(client, ctx, zone, await client.startInstance(ctx, zone, instance));
    }
    return gceResource(await client.getInstance(ctx, zone, instance), project);
  }

  async stop(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderResource | null> {
    const project = projectOf(credentials);
    const { zone, instance } = parseResourceId(resourceId, project);
    const ctx = this.ctx(credentials);
    const client = this.client(credentials);
    const operation = await client.stopInstance(ctx, zone, instance);
    // Followed to its end, so a stop Google gives up on is said, not read as one still under way.
    let done = operation;
    try {
      if (operation.status !== "DONE") {
        done = await client.waitOperation(
          ctx,
          zone,
          operation.name,
          Date.now() + OPERATION_DEADLINE_MS
        );
      }
    } catch (error) {
      // An operation this account can't read (a role without zoneOperations.get) leaves the VM's own state to say.
      if (error instanceof GceApiError && error.kind === "cancelled") throw error;
    }
    const refused = operationError(done);
    if (refused) throw refused;
    return gceResource(await client.getInstance(ctx, zone, instance), project);
  }

  async rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void> {
    const project = projectOf(credentials);
    const { zone, instance } = parseResourceId(resourceId, project);
    if (!GCE_NAME.test(name)) {
      throw invalid("A Compute Engine VM name is lowercase letters, digits and hyphens.");
    }
    const ctx = this.ctx(credentials);
    const client = this.client(credentials);
    const current = await client.getInstance(ctx, zone, instance);
    if (current.status !== "TERMINATED") {
      throw invalid("Google Cloud renames a VM only while it's stopped.");
    }
    await this.finish(
      client,
      ctx,
      zone,
      await client.setName(ctx, zone, instance, { currentName: current.name, name })
    );
  }

  async delete(credentials: ProviderCredentials, resourceId: string): Promise<void> {
    const project = projectOf(credentials);
    const { zone, instance } = parseResourceId(resourceId, project);
    const ctx = this.ctx(credentials);
    const client = this.client(credentials);
    // Resolved only once the VM is gone: the host is forgotten as soon as this returns.
    const stillThere = () =>
      new GceApiError("server", "Compute Engine hasn't finished deleting the machine", null, null);
    let operation: GceOperation;
    try {
      operation = await client.deleteInstance(ctx, zone, instance);
    } catch (error) {
      // A 404, or an answer lost after the request may have gone out, leaves it to the VM itself.
      if (
        error instanceof GceApiError &&
        (error.kind === "not-found" || mayHaveReachedCompute(error))
      ) {
        if (await this.isGone(client, ctx, zone, instance)) return;
        throw stillThere();
      }
      throw error;
    }
    let done = operation;
    try {
      if (operation.status !== "DONE") {
        done = await client.waitOperation(
          ctx,
          zone,
          operation.name,
          Date.now() + OPERATION_DEADLINE_MS
        );
      }
    } catch (error) {
      if (error instanceof GceApiError && error.kind === "cancelled") throw error;
      // Google took the delete; an operation that can't be followed leaves it to the VM itself.
      if (await this.isGone(client, ctx, zone, instance)) return;
      throw stillThere();
    }
    // A delete Google finished with an error of its own is said as it is; a 404 there is checked, never taken as gone.
    const refused = operationError(done);
    if (refused?.kind === "not-found" && (await this.isGone(client, ctx, zone, instance))) return;
    if (refused) throw refused.kind === "not-found" ? stillThere() : refused;
    if (done.status !== "DONE") throw stillThere();
  }

  /** Whether Compute Engine says the VM no longer exists; a failed lookup is no answer. */
  private async isGone(
    client: GceClient,
    ctx: GceRequestContext,
    zone: string,
    instance: string
  ): Promise<boolean> {
    try {
      await client.getInstance(ctx, zone, instance);
      return false;
    } catch (error) {
      if (error instanceof GceApiError && error.kind === "not-found") return true;
      throw error;
    }
  }

  async sshAccess(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderSshAccess> {
    const project = projectOf(credentials);
    const { zone, instance } = parseResourceId(resourceId, project);
    const ctx = this.ctx(credentials);
    const client = this.client(credentials);
    try {
      return await this.waitForHostKey(client, ctx, zone, instance);
    } catch (error) {
      // Throttled reads are a wait like any other: the link tries again later.
      if (error instanceof GceApiError && error.kind === "rate-limited") {
        throw new GceApiError("host-keys-pending", "Google Cloud asked to slow down", null, null);
      }
      throw error;
    }
  }

  private async waitForHostKey(
    client: GceClient,
    ctx: GceRequestContext,
    zone: string,
    instance: string
  ): Promise<ProviderSshAccess> {
    const deadline = this.now() + HOST_KEY_WAIT_MS;
    for (;;) {
      const current = await client.getInstance(ctx, zone, instance);
      if (current.status !== "RUNNING") {
        throw new GceApiError("host-keys-pending", "The machine isn't running yet", null, null);
      }
      if (!hasExternalAccess(current)) {
        throw new GceApiError(
          "invalid-request",
          "The machine has no external IP address, so this device can't reach it",
          null,
          null
        );
      }
      const address = ipv4NatAddress(current);
      const hostKey = address ? await this.publishedHostKey(client, ctx, zone, instance) : null;
      if (address && hostKey) {
        return { user: GCE_SSH_USER, endpoint: { host: address, port: 22 }, hostKey };
      }
      if (this.now() + HOST_KEY_POLL_MS > deadline) {
        throw new GceApiError(
          "host-keys-pending",
          address
            ? "The machine hasn't published its SSH host keys yet"
            : "The machine hasn't been given its external IP address yet",
          null,
          null
        );
      }
      await this.sleep(HOST_KEY_POLL_MS, ctx.signal);
    }
  }

  /** The strongest host key the guest published, or null while it has published none. */
  private async publishedHostKey(
    client: GceClient,
    ctx: GceRequestContext,
    zone: string,
    instance: string
  ): Promise<string | null> {
    let attributes;
    try {
      attributes = await client.guestAttributes(ctx, zone, instance, "hostkeys/");
    } catch (error) {
      // Not found until the guest's agent writes the namespace on first boot.
      if (error instanceof GceApiError && error.kind === "not-found") return null;
      throw error;
    }
    const items = (attributes.queryValue?.items ?? []).filter(
      (item) => item.namespace === "hostkeys"
    );
    if (items.length === 0) return null;
    const keys = items
      .map((item) => normalizeHostKey(`${item.key ?? ""} ${item.value ?? ""}`))
      .filter((key): key is string => key !== null)
      .sort((a, b) => rank(a) - rank(b));
    if (keys.length === 0) {
      throw new GceApiError(
        "bad-response",
        "The machine published SSH host keys Daintree can't read",
        null,
        null
      );
    }
    return keys[0]!;
  }

  /** Waits for a mutation to finish and throws its failure; returns it as it stood at the deadline. */
  private async finish(
    client: GceClient,
    ctx: GceRequestContext,
    zone: string,
    operation: GceOperation
  ): Promise<GceOperation> {
    const done =
      operation.status === "DONE"
        ? operation
        : await client.waitOperation(ctx, zone, operation.name, Date.now() + OPERATION_DEADLINE_MS);
    const refused = operationError(done);
    if (refused) throw refused;
    return done;
  }

  describeError(error: unknown): CloudHostError {
    const at = Date.now();
    if (!(error instanceof GceApiError)) {
      return {
        code: "failed",
        message:
          error instanceof AppError && error.userMessage
            ? error.userMessage
            : formatErrorMessage(error, "Something went wrong talking to Google Cloud"),
        at,
      };
    }
    const said = error.message;
    switch (error.kind) {
      case "unauthorized":
        return {
          code: "credential-invalid",
          message:
            "Google didn't accept this account's service account key: it may have been deleted or disabled, or this device's clock is off. Replace it in Settings → Hosts.",
          at,
        };
      case "api-disabled":
        return {
          code: "permission",
          message:
            "The Compute Engine API isn't enabled in this project. Enable it in the Google Cloud console, then try again.",
          at,
        };
      case "forbidden":
        return {
          code: "permission",
          message: `This service account isn't allowed to do that (${said}). Grant it a Compute Engine role in the project, or use another key.`,
          at,
        };
      case "billing":
        return { code: "billing", message: `Google Cloud needs billing set up first: ${said}`, at };
      case "quota":
        return {
          code: "capacity",
          message: `This project's Compute Engine quota doesn't leave room for that machine: ${said}`,
          at,
        };
      case "rate-limited":
        return { code: "rate-limited", message: `Google Cloud asked to slow down: ${said}`, at };
      case "no-capacity":
        return {
          code: "capacity",
          message:
            "Google Cloud has no machine of that size free in this zone right now. Try again shortly, or another zone.",
          at,
        };
      case "not-found":
        return {
          code: "not-found",
          message: "Google Cloud doesn't know this machine in this account's project.",
          at,
        };
      case "outcome-unknown":
        return {
          code: "outcome-unknown",
          message: `Google Cloud took the request but its result couldn't be read: ${said}`,
          at,
        };
      case "host-keys-pending":
        // Transient: the link tries again rather than give up on the machine.
        return { code: "provider-unreachable", message: `${said}. Daintree tries again.`, at };
      case "network":
      case "timeout":
        return { code: "provider-unreachable", message: "Couldn't reach Google Cloud.", at };
      case "server":
        return { code: "provider-unreachable", message: `Google Cloud had a problem: ${said}`, at };
      case "cancelled":
        return { code: "failed", message: "Cancelled.", at };
      default:
        return { code: "failed", message: said, at };
    }
  }
}

function rank(key: string): number {
  const index = HOST_KEY_PREFERENCE.findIndex((prefix) => key.startsWith(`${prefix} `));
  return index < 0 ? HOST_KEY_PREFERENCE.length : index;
}

/** A failure after Google accepted a create: whether a machine exists is unknown. */
function unconfirmed(error: unknown): GceApiError {
  if (error instanceof GceApiError && error.kind === "cancelled") return error;
  const said = formatErrorMessage(error, "the answer was lost");
  return new GceApiError("outcome-unknown", redactGceText(said), null, null);
}
