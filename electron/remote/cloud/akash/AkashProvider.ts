import type {
  CloudAccountCheckResult,
  CloudAccountScopeChoice,
  CloudCreateOffer,
  CloudCreateOrder,
  CloudCredentialValues,
  CloudHostError,
  CloudMachineState,
  CloudMachineType,
  CloudProviderInfo,
  CloudProvisioningChoice,
} from "../../../../shared/types/cloudHosts.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { pluralize } from "../../../../shared/utils/pluralize.js";
import { AppError } from "../../../utils/errorTypes.js";
import {
  CLOUD_HOSTS_UNSUPPORTED_ON_WINDOWS,
  type CloseOrderOutcome,
  type CloudProvider,
  type OfferCreate,
  type ProviderCatalog,
  type ProviderCreateRequest,
  type ProviderCredentials,
  type ProviderResource,
  type ProviderSshAccess,
} from "../provider.js";
import { isValidSshEndpoint } from "../sshEndpoint.js";
import {
  AkashApiError,
  parseItems,
  redactAkashText,
  type AkashConsoleClient,
  type AkashRequestContext,
} from "./AkashConsoleClient.js";
import { AKASH_UACT, akashHourlyDollars } from "./akashBilling.js";
import {
  AKASH_CREATE_KEY_LABEL,
  AKASH_HOST_IMAGE,
  AKASH_SERVICE,
  AKASH_SSH_USER,
  akashDefinition,
  akashDefinitionSize,
  akashGroupsFacts,
  akashMarkedName,
  akashMarkToken,
  akashOfferId,
  akashRenamed,
  akashResourceId,
  isOpenSshPublicKey,
  parseAkashName,
  parseAkashOfferId,
  parseAkashResourceId,
  type AkashDeploymentId,
  type AkashOfferId,
  type AkashParsedName,
} from "./akashDeployments.js";
import {
  AKASH_INSTANCE_TYPES,
  akashInstanceType,
  akashInstanceTypeLabel,
  akashScreeningRequest,
} from "./akashInstanceTypes.js";
import {
  akashBidSchema,
  akashDeploymentSchema,
  akashForwardedPortSchema,
  akashGroupSchema,
  akashLeaseSchema,
  type AkashBid,
  type AkashLease,
  type AkashPlacementOptions,
  type AkashScreenedProvider,
} from "./akashSchemas.js";

const MAX_KEY_LENGTH = 4096;

function invalidKey(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

/** The API key from an entered set: one line of printable ASCII, since it travels in a header. */
export function akashApiKey(values: Readonly<CloudCredentialValues>): string {
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

function unsupported(message: string): AkashApiError {
  return new AkashApiError("unsupported", message, null, null);
}

const PAGE_SIZE = 100;
/** Ten thousand deployments: past that a listing is refused rather than read without end. */
const MAX_PAGES = 100;
const MAX_BLOCK_TIMES = 512;
/** Passes over a list that moves while it is read, before it is refused as never holding still. */
const MAX_SCANS = 3;

/** Refusals the Console names after its checks, before changing anything. */
const DEFINITE = new Set<AkashApiError["kind"]>([
  "unauthorized",
  "forbidden",
  "payment-required",
  "rate-limited",
  "invalid-request",
  "conflict",
  "unprocessable",
]);

const UNDELIVERED = {
  problem: "The provider hasn't taken the deployment yet, so it may not start.",
};

/** A deployment as Daintree reads it, from the list or from its own route. */
interface DeploymentView {
  id: AkashDeploymentId;
  state: string;
  /** The block the order was placed in; null when the Console didn't say. */
  createdHeight: number | null;
  rawName: string | null;
  name: AkashParsedName;
  leases: AkashLease[];
  /** Only the list carries them. */
  groups: unknown[] | undefined;
  /** The SDL Console stored, which only a deployment's own route carries. */
  definition: unknown;
}

function viewOf(raw: unknown): DeploymentView {
  const parsed = akashDeploymentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AkashApiError(
      "bad-response",
      "The Akash Console described a deployment in a shape Daintree doesn't recognise",
      null,
      null
    );
  }
  const { deployment, leases, groups, name } = parsed.data;
  const height = Number(deployment.created_at);
  const settings = (raw as { consoleSettings?: { definition?: unknown } | null }).consoleSettings;
  return {
    id: { owner: deployment.id.owner, dseq: deployment.id.dseq.replace(/^0+/, "") },
    state: deployment.state,
    createdHeight: Number.isSafeInteger(height) && height > 0 ? height : null,
    rawName: name ?? null,
    name: parseAkashName(name),
    leases: parseItems(leases, akashLeaseSchema),
    groups,
    definition: settings?.definition ?? null,
  };
}

/** The lease that says what the machine is: the live one, else the latest. */
function currentLease(leases: readonly AkashLease[]): AkashLease | null {
  const active = leases.find((lease) => lease.state === "active" || lease.state === "reclaiming");
  if (active) return active;
  return (
    [...leases].sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0] ?? null
  );
}

/** The machine a deployment is; null for an order nobody leased, which is none. */
function machineOf(
  view: DeploymentView
): { machine: CloudMachineState; error: string | null } | null {
  if (view.leases.length === 0) return null;
  if (view.state === "closed") return { machine: "deleted", error: null };
  if (view.state !== "active") return { machine: "unknown", error: null };
  const lease = currentLease(view.leases)!;
  const reclaimed =
    lease.state === "reclaiming" || lease.reclamation
      ? "Its provider is reclaiming the lease, so it will end soon."
      : null;
  switch (lease.state) {
    case "active":
    case "reclaiming":
      return { machine: "running", error: reclaimed };
    case "insufficient_funds":
      return {
        machine: "error",
        error: "Its lease ran out of funds. Add credit on the Akash Console, or delete it.",
      };
    case "closed":
      return {
        machine: "error",
        error:
          "Its provider ended the lease, so the container is gone. Delete it to close the deployment.",
      };
    default:
      return { machine: "unknown", error: null };
  }
}

function sameDeployment(found: { owner: string; dseq: string }, id: AkashDeploymentId): boolean {
  return found.owner === id.owner && found.dseq.replace(/^0+/, "") === id.dseq;
}

/** What a lease names of its bid: the order and the bidder, never the bid's own number. */
function tupleOf(id: { gseq: number; oseq: number; provider: string }): string {
  return `${id.gseq}/${id.oseq}/${id.provider}`;
}

/** Which of its bidder's bids a bid or lease is; 0 where the Console leaves it out. */
function bseqOf(id: { bseq?: unknown }): number {
  return typeof id.bseq === "number" ? id.bseq : 0;
}

/** A bid's rate in dollars an hour, or a refusal: an offer is never quoted at a price it doesn't have. */
function hourlyOf(price: { denom: string; amount: string }): number {
  const hourly = price.denom === AKASH_UACT ? akashHourlyDollars(price.amount) : null;
  if (hourly === null) {
    throw new AkashApiError(
      "bad-response",
      `The Akash Console quoted an offer of ${price.amount} ${price.denom}, which Daintree can't price`,
      null,
      null
    );
  }
  return hourly;
}

function otherOfferLeased(): AkashApiError {
  // Not a refusal: a machine stands, and the person decides what becomes of it.
  return new AkashApiError(
    "outcome-unknown",
    "This order was already leased from another of its offers, so this one wasn't.",
    null,
    null
  );
}

function otherWallet(): AkashApiError {
  return new AkashApiError(
    "wrong-scope",
    "This account's key acts for another Akash wallet than the one this belongs to. Replace it with a key for that wallet.",
    null,
    null
  );
}

function groupsOpen(groups: readonly unknown[] | undefined): boolean {
  if (!groups || groups.length === 0) return false;
  return groups.every((group) => akashGroupSchema.safeParse(group).data?.state === "open");
}

function sameLabels(
  found: Readonly<Record<string, string>>,
  wanted: Readonly<Record<string, string>>
): boolean {
  const keys = Object.keys(wanted);
  return (
    keys.length === Object.keys(found).length &&
    keys.every((key) => Object.hasOwn(found, key) && found[key] === wanted[key])
  );
}

function splitLabel(label: string): { key: string; value: string } {
  const at = label.indexOf("=");
  if (at <= 0) throw new AkashApiError("invalid-request", "Not a key=value label", null, null);
  return { key: label.slice(0, at), value: label.slice(at + 1) };
}

/** Why an offer can't be chosen, in words for its row; null when it can. */
function offerReason(state: string, openFromBidder: number): string | null {
  switch (state) {
    case "open":
      return openFromBidder === 1 ? null : "The provider made more than one offer on this order";
    case "active":
      return "Already leased";
    case "lost":
      return "Another offer was leased";
    case "closed":
      return "No longer open";
    default:
      return `The Akash Console says it is ${state}`;
  }
}

function errorText(error: unknown): string {
  return formatErrorMessage(error, "it didn't answer");
}

/**
 * A change whose answer never came, or came unreadable, may have happened:
 * said so, rather than passed off as the Console being unreachable.
 */
function maybeDone(error: unknown, message: string): unknown {
  if (
    error instanceof AkashApiError &&
    (error.kind === "network" ||
      error.kind === "timeout" ||
      error.kind === "server" ||
      error.kind === "bad-response")
  ) {
    return new AkashApiError("outcome-unknown", message, error.status, error.code);
  }
  return error;
}

/**
 * A create's refusal that Console documents as placing nothing, said so; null
 * for any other failure. Daintree names no template or deployment to inherit
 * from, so a 404 can only be the account's project gone.
 */
function placeRefusal(error: unknown): AkashApiError | null {
  if (!(error instanceof AkashApiError)) return null;
  if (error.kind === "not-found") {
    return new AkashApiError(
      "wrong-scope",
      "The Akash Console project this account deploys into is gone. Connect the account again with a project that exists.",
      error.status,
      error.code
    );
  }
  if (error.code === "deposit_price_unavailable") {
    return new AkashApiError(
      "declined",
      "The Akash Console couldn't price the order against the project's budget just now, so nothing was placed. Try again in a moment.",
      error.status,
      error.code
    );
  }
  return null;
}

/** What an Akash provider is built with beyond its Console client. */
export interface AkashProviderOptions {
  /** The host image every deployment runs, by digest: `ghcr.io/daintreehq/daintree-host@sha256:…`. */
  hostImage: string;
}

/**
 * The Console account behind one key, and what it can bill: every project of
 * the key's organization it may deploy into, named with that organization.
 */
async function deployableProjects(
  client: AkashConsoleClient,
  ctx: AkashRequestContext
): Promise<CloudAccountScopeChoice[]> {
  const [organizations, projects] = await Promise.all([
    client.organizations(ctx),
    client.projects(ctx),
  ]);
  // A key acts in exactly one organization, the one its requests ran in.
  const active = organizations.filter((organization) => organization.isActive);
  if (active.length !== 1) {
    throw new AkashApiError(
      "bad-response",
      "The Akash Console didn't say which organization this key acts in",
      null,
      null
    );
  }
  const organization = active[0]!;
  const owner = organization.type === "personal" ? "Personal" : organization.name;
  const seen = new Set<string>();
  const choices: CloudAccountScopeChoice[] = [];
  for (const project of projects) {
    const id = project.id.toLowerCase();
    if (!project.access.canDeploy || seen.has(id)) continue;
    seen.add(id);
    choices.push({
      scope: { kind: "project", id, name: `${owner} · ${project.name}` },
      active: project.isDefault,
    });
  }
  if (choices.length === 0) {
    throw new AkashApiError(
      "forbidden",
      `This key can't deploy into any project of ${organization.type === "personal" ? "your personal account" : organization.name}`,
      null,
      null
    );
  }
  return choices;
}

/** Who the key signs in as; null when the Console won't say for this key. */
async function identityOf(
  client: AkashConsoleClient,
  ctx: AkashRequestContext
): Promise<string | null> {
  try {
    const user = await client.me(ctx);
    return user.email?.trim() || user.username?.trim() || null;
  } catch (error) {
    if (
      error instanceof AkashApiError &&
      (error.kind === "forbidden" || error.kind === "not-found")
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Runs every task to an answer, or to the first failure: the rest are then
 * cancelled and waited out, and that first failure is what rejects.
 */
async function allOrNone<T>(
  signal: AbortSignal | undefined,
  tasks: ReadonlyArray<(signal: AbortSignal) => Promise<T>>
): Promise<T[]> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const failures: unknown[] = [];
  try {
    const settled = await Promise.allSettled(
      tasks.map((task) =>
        task(controller.signal).catch((error: unknown) => {
          failures.push(error);
          controller.abort();
          throw error;
        })
      )
    );
    if (failures.length > 0) throw failures[0];
    return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The placement regions a size's matched providers are in; one with no region, or another, places it nowhere. */
function regionsOf(
  providers: readonly AkashScreenedProvider[],
  offered: ReadonlySet<string>
): Set<string> {
  const regions = new Set<string>();
  for (const provider of providers) {
    if (provider.location && offered.has(provider.location)) regions.add(provider.location);
  }
  return regions;
}

export class AkashProvider implements CloudProvider {
  readonly id = "akash" as const;
  /** A second order placed for a lost answer would be a second order: a lost one is only looked for. */
  readonly createReplay = "lookup-only" as const;
  private readonly hostImage: string;
  private readonly blockTimes = new Map<string, string>();

  constructor(
    private readonly clientFor: (apiUrl: string) => AkashConsoleClient,
    options: AkashProviderOptions
  ) {
    if (!AKASH_HOST_IMAGE.test(options.hostImage)) {
      throw new Error(`Not a Daintree host image by digest: ${options.hostImage}`);
    }
    this.hostImage = options.hostImage;
  }

  info(platform: NodeJS.Platform): CloudProviderInfo {
    return {
      id: "akash",
      name: "Akash",
      description:
        "Containers leased from Akash Network providers through the Akash Console, paid from your Console credits. There is no stop: deleting one ends its lease and everything on it.",
      apiKeyUrl: "https://console.akash.network/user/api-keys",
      dashboardUrl: "https://console.akash.network/deployments",
      docsUrl: "https://akash.network/docs/",
      credentialFields: [
        {
          id: "apiKey",
          label: "API key",
          secret: true,
          input: "single-line",
          required: true,
          help: "A Console API key, starting ac.sk.",
        },
      ],
      capabilities: {
        persistence: {
          kept: "Nothing",
          lost: "the container, its disk and memory",
          retentionDays: null,
          saveRetryBilled: false,
          stoppedComputeBilled: false,
          stoppedStorageBilled: false,
        },
        typicalStartSeconds: null,
        lifetime: { kind: "none" },
        sshTrust: "confirm-on-first-connect",
        transport: "direct",
        tunnel: null,
        provisioning: {
          location: "required",
          image: "none",
          network: "none",
          sshKey: "at-create",
        },
        deletion: true,
      },
      stopMode: "delete-only",
      createMode: "offers",
      unsupportedReason: platform === "win32" ? CLOUD_HOSTS_UNSUPPORTED_ON_WINDOWS : null,
    };
  }

  private ctx(credentials: ProviderCredentials): AkashRequestContext {
    const apiKey = credentials.values.apiKey;
    // Never sent without one: an empty key would only come back as the Console's refusal.
    if (!apiKey) throw new AkashApiError("unauthorized", "No API key", null, null);
    return { apiKey, signal: credentials.signal };
  }

  /** As `ctx`, acting in the account's project, which its deployments are filed in. */
  private account(credentials: ProviderCredentials): AkashRequestContext {
    return { ...this.ctx(credentials), projectId: credentials.scopeId.toLowerCase() };
  }

  async checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal?: AbortSignal
  ): Promise<CloudAccountCheckResult> {
    const client = this.clientFor(apiUrl);
    const ctx = { apiKey: akashApiKey(values), signal };
    const [scopes, identity] = await Promise.all([
      deployableProjects(client, ctx),
      identityOf(client, ctx),
    ]);
    return { identity, scopes };
  }

  async validate(credentials: ProviderCredentials): Promise<{ identity: string | null }> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.ctx(credentials);
    const projectId = credentials.scopeId.toLowerCase();
    const lost = (status: number | null, code: string | null) =>
      new AkashApiError(
        "wrong-scope",
        "This key no longer reaches the Akash Console project this account deploys into. Replace it with a key that does, or connect the other project as its own account.",
        status,
        code
      );
    // Only the list says what the key may do in a project; one project's own read doesn't.
    let projects;
    try {
      projects = await client.projects({ ...ctx, projectId });
    } catch (error) {
      if (
        error instanceof AkashApiError &&
        (error.kind === "not-found" ||
          (error.kind === "forbidden" && error.code === "project_forbidden"))
      ) {
        throw lost(error.status, error.code);
      }
      throw error;
    }
    const project = projects.find((entry) => entry.id.toLowerCase() === projectId);
    if (!project) throw lost(null, null);
    if (!project.access.canDeploy) {
      throw new AkashApiError(
        "forbidden",
        `This key can no longer deploy into ${project.name}`,
        null,
        null
      );
    }
    return { identity: await identityOf(client, ctx) };
  }

  /**
   * Daintree's sizes, each available in the regions where an audited provider
   * would bid on it with the room it has free now. Both calls are public, so
   * the account's key never goes with them. Prices come from offers, so none
   * is listed; a screening that fails fails the whole catalog rather than
   * passing an unknown for "no room".
   */
  async catalog(credentials: ProviderCredentials): Promise<ProviderCatalog> {
    const client = this.clientFor(credentials.apiUrl);
    const [placement, ...screens] = await allOrNone<unknown>(credentials.signal, [
      (signal) => client.placementOptions(signal),
      ...AKASH_INSTANCE_TYPES.map(
        (type) => (signal: AbortSignal) =>
          client.screenProviders(akashScreeningRequest(type), signal)
      ),
    ]);
    const { regions, regionProviderCounts } = placement as AkashPlacementOptions;
    const regionChoices: CloudProvisioningChoice[] = [...new Set(regions)]
      .sort((a, b) => a.localeCompare(b))
      .map((region) => {
        const count = regionProviderCounts[region] ?? 0;
        return {
          id: region,
          label: region,
          description: `${pluralize(count, "audited provider")} online`,
          available: count > 0,
          reason: count > 0 ? null : "No audited provider is online there now",
          locations: null,
        };
      });
    const offered = new Set(
      regionChoices.filter((choice) => choice.available).map((choice) => choice.id)
    );
    const machineTypes: CloudMachineType[] = AKASH_INSTANCE_TYPES.map((type, index) => {
      const matched = regionsOf(screens[index] as AkashScreenedProvider[], offered);
      const locations = regionChoices
        .filter((choice) => matched.has(choice.id))
        .map((choice) => choice.id);
      return {
        id: type.id,
        label: akashInstanceTypeLabel(type),
        vcpu: type.vcpu,
        memoryGB: type.memoryGiB,
        hourlyDollars: null,
        available: locations.length > 0,
        reason: locations.length > 0 ? null : "No audited provider has room for it right now",
        locations,
      };
    });
    // The busiest region some size fits, so the form never opens on one with nothing to choose.
    const fitting = new Set(machineTypes.flatMap((type) => type.locations ?? []));
    const busiest = regionChoices
      .filter((choice) => fitting.has(choice.id))
      .sort((a, b) => (regionProviderCounts[b.id] ?? 0) - (regionProviderCounts[a.id] ?? 0))[0];
    return {
      machineTypes,
      // Nothing here is ever started: a machine is created from an offer and ends when deleted.
      canStart: false,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
      provisioning: {
        location: { label: "Region", choices: regionChoices, defaultId: busiest?.id ?? null },
      },
    };
  }

  /**
   * The account's machines: deployments one of its offers was leased for. An
   * order nobody leased yet is no machine, and `findOrders` finds it. With a
   * label, closed deployments are looked through too, so a create's lookup
   * sees a machine it made and deleted since.
   */
  async list(
    credentials: ProviderCredentials,
    options: { label?: string; location?: string } = {}
  ): Promise<ProviderResource[]> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const label = options.label ? splitLabel(options.label) : null;
    const search = label ? akashMarkToken(label.key, label.value) : undefined;
    const found = new Map<string, DeploymentView>();
    for (const state of label ? (["active", "closed"] as const) : (["active"] as const)) {
      for (const view of await this.everyDeployment(client, ctx, state, search)) {
        found.set(akashResourceId(view.id), view);
      }
    }
    const location = options.location?.toLowerCase() ?? null;
    const machines = [...found.values()].filter((view) => {
      if (view.leases.length === 0) return false;
      if (label && view.name.labels[label.key] !== label.value) return false;
      // A region it doesn't say can't rule it out.
      const region = akashGroupsFacts(view.groups).region;
      return location === null || region === null || region === location;
    });
    return Promise.all(
      machines.map((view) => this.resourceOf(client, view, ctx.signal, label !== null))
    );
  }

  async inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const view = await this.read(client, ctx, parseAkashResourceId(resourceId));
    if (view.leases.length === 0) {
      throw new AkashApiError("not-found", "Nothing was leased for that order yet", null, null);
    }
    return this.resourceOf(client, view, ctx.signal);
  }

  /** A machine here is leased from the offer a person chose, never made by one request. */
  create(): Promise<ProviderResource> {
    return Promise.reject(
      unsupported(
        "An Akash machine is leased from an offer a provider makes, so it can't be created in one request."
      )
    );
  }

  readonly offerCreate: OfferCreate = {
    placeOrder: (credentials, request) => this.placeOrder(credentials, request),
    findOrders: (credentials, match) => this.findOrders(credentials, match),
    listOffers: (credentials, orderId) => this.listOffers(credentials, orderId),
    leaseOffer: (credentials, orderId, offerId) => this.leaseOffer(credentials, orderId, offerId),
    closeOrder: (credentials, orderId) => this.closeOrder(credentials, orderId),
  };

  /**
   * Places the order as one deployment of the host image, named with the
   * create's labels and key so it is found again, then reads it back for the
   * wallet that owns it, which the create's answer doesn't name.
   */
  private async placeOrder(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<CloudCreateOrder> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const type = akashInstanceType(request.machineType);
    if (!type) {
      throw new AkashApiError(
        "invalid-request",
        `Daintree has no Akash size called ${request.machineType}`,
        null,
        null
      );
    }
    const region = request.provisioning.location?.trim();
    if (!region) {
      throw new AkashApiError("invalid-request", "An Akash machine needs a region", null, null);
    }
    const publicKey = request.publicKey?.trim() ?? "";
    if (!isOpenSshPublicKey(publicKey)) {
      throw new AkashApiError(
        "invalid-request",
        "An Akash machine needs the account's SSH public key, on one line",
        null,
        null
      );
    }
    const name = akashMarkedName(request.name, request.labels, request.idempotencyKey);
    let dseq: string;
    try {
      ({ dseq } = await client.createDeployment(ctx, {
        definition: akashDefinition({ image: this.hostImage, type, region, publicKey }),
        name,
        // A public key is no secret, and a sealed value can't be read back to check it.
        secretEnv: [],
        projectId: ctx.projectId,
      }));
    } catch (error) {
      throw (
        placeRefusal(error) ??
        maybeDone(error, "The Akash Console may have placed the order: its answer was lost.")
      );
    }
    let view: DeploymentView;
    try {
      view = await this.read(client, ctx, { owner: null, dseq });
    } catch (error) {
      throw new AkashApiError(
        "outcome-unknown",
        `The Akash Console placed order ${dseq}, but Daintree couldn't read it back: ${errorText(error)}`,
        null,
        null
      );
    }
    if (view.name.createKey !== request.idempotencyKey) {
      throw new AkashApiError(
        "outcome-unknown",
        `The Akash Console placed order ${dseq}, but it doesn't carry this create's mark`,
        null,
        null
      );
    }
    return { id: akashResourceId(view.id) };
  }

  /** Open orders carrying the create's labels and key: placed, never leased, not closed. */
  private async findOrders(
    credentials: ProviderCredentials,
    match: Pick<ProviderCreateRequest, "labels" | "idempotencyKey">
  ): Promise<CloudCreateOrder[]> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const search = akashMarkToken(AKASH_CREATE_KEY_LABEL, match.idempotencyKey);
    const views = await this.everyDeployment(client, ctx, "active", search);
    const orders = new Map<string, CloudCreateOrder>();
    for (const view of views) {
      if (
        view.state === "active" &&
        view.name.createKey === match.idempotencyKey &&
        sameLabels(view.name.labels, match.labels) &&
        // Any lease, ended or not, means one of its offers was taken.
        view.leases.length === 0 &&
        groupsOpen(view.groups)
      ) {
        const id = akashResourceId(view.id);
        orders.set(id, { id });
      }
    }
    return [...orders.values()];
  }

  /** Every bid on the order now, priced in dollars per hour as Console prices them. */
  private async listOffers(
    credentials: ProviderCredentials,
    orderId: string
  ): Promise<CloudCreateOffer[]> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const id = parseAkashResourceId(orderId);
    const bids = await this.bidsOf(client, ctx, id);
    // No bid names the order's wallet yet, so the order itself is read to be sure it is this one.
    if (bids.length === 0) await this.read(client, ctx, id);
    const open = new Map<string, number>();
    for (const bid of bids) {
      if (bid.state === "open") open.set(tupleOf(bid.id), (open.get(tupleOf(bid.id)) ?? 0) + 1);
    }
    return bids.map((bid): CloudCreateOffer => {
      const offer = {
        id: akashOfferId({ ...bid.id, bseq: bseqOf(bid.id) }),
        hourlyDollars: hourlyOf(bid.price),
        // Who the bidder is, beyond its address, is the trusted provider list's to look up (#18237).
        bidder: { id: bid.id.provider, name: bid.id.provider, region: null },
      };
      const reason = offerReason(bid.state, open.get(tupleOf(bid.id)) ?? 0);
      return reason === null
        ? { ...offer, choosable: true, reason: null }
        : { ...offer, choosable: false, reason };
    });
  }

  /**
   * Leases exactly the chosen bid. A lease an earlier try made, whose answer
   * was lost, is answered as it stands; a bid that isn't open is refused with
   * nothing sent, and a lease of another offer is never passed off as this one.
   */
  private async leaseOffer(
    credentials: ProviderCredentials,
    orderId: string,
    offerId: string
  ): Promise<ProviderResource> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const id = parseAkashResourceId(orderId);
    const offer = parseAkashOfferId(offerId);
    const view = await this.read(client, ctx, id);
    if (view.state !== "active") {
      throw new AkashApiError(
        "offer-gone",
        "That order was closed, so nothing can be leased from it.",
        null,
        null
      );
    }
    const bids = await this.bidsOf(client, ctx, id);
    const chosen =
      bids.find((bid) => tupleOf(bid.id) === tupleOf(offer) && bseqOf(bid.id) === offer.bseq) ??
      null;
    if (view.leases.length > 0) {
      const taken = view.leases.find((lease) => tupleOf(lease.id) === tupleOf(offer));
      if (!taken) throw otherOfferLeased();
      // Its manifest may never have reached the provider, which then reports nothing of it:
      // Console takes the same request again to send the manifest again.
      if (taken.state === "active" && !taken.status) {
        return this.sendLease(client, ctx, view, offer, chosen);
      }
      return this.leased(client, view, offer, chosen, ctx.signal);
    }
    if (!chosen || chosen.state !== "open") {
      throw new AkashApiError(
        "offer-gone",
        "That offer isn't open any more. Choose another.",
        null,
        null
      );
    }
    // A lease names no bid number, so another open bid from the same bidder would make it ambiguous.
    if (
      bids.some(
        (bid) => bid !== chosen && bid.state === "open" && tupleOf(bid.id) === tupleOf(offer)
      )
    ) {
      throw new AkashApiError(
        "offer-gone",
        "That provider made more than one offer on this order. Choose another.",
        null,
        null
      );
    }
    return this.sendLease(client, ctx, view, offer, chosen);
  }

  /**
   * Sends the lease, and once more when Console says the lease exists but its
   * manifest didn't arrive, as Console asks. Whatever else comes back, the
   * order is read again before anything is said about what was leased.
   */
  private async sendLease(
    client: AkashConsoleClient,
    ctx: AkashRequestContext,
    view: DeploymentView,
    offer: AkashOfferId,
    chosen: AkashBid | null
  ): Promise<ProviderResource> {
    const lease = {
      dseq: view.id.dseq,
      gseq: offer.gseq,
      oseq: offer.oseq,
      provider: offer.provider,
    };
    let undelivered = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let answer: unknown[];
      try {
        answer = await client.createLease(ctx, lease);
      } catch (error) {
        if (!(error instanceof AkashApiError) || error.kind === "cancelled") throw error;
        if (error.code === "provider_unreachable" && !undelivered && view.leases.length === 0) {
          throw new AkashApiError(
            "offer-gone",
            "The provider couldn't be reached, so nothing was leased. Choose another offer.",
            error.status,
            error.code
          );
        }
        if (error.code === "manifest_not_delivered") {
          undelivered = true;
          continue;
        }
        if (error.code === "provider_manifest_invalid") {
          return this.reconcile(client, ctx, view.id, offer, chosen, error, {
            machine: "error",
            problem: "The provider refused the deployment as invalid, so it won't run. Delete it.",
          });
        }
        return this.reconcile(
          client,
          ctx,
          view.id,
          offer,
          chosen,
          error,
          undelivered ? UNDELIVERED : null
        );
      }
      let made: AkashLease | undefined;
      try {
        made = parseItems(answer, akashLeaseSchema).find(
          (entry) => sameDeployment(entry.id, view.id) && tupleOf(entry.id) === tupleOf(offer)
        );
      } catch {
        made = undefined;
      }
      if (!made) {
        return this.reconcile(
          client,
          ctx,
          view.id,
          offer,
          chosen,
          new AkashApiError(
            "bad-response",
            "The Akash Console answered the lease unreadably",
            null,
            null
          ),
          null
        );
      }
      return this.leased(client, { ...view, leases: [made] }, offer, chosen, ctx.signal);
    }
    return this.reconcile(client, ctx, view.id, offer, chosen, null, UNDELIVERED);
  }

  /**
   * What the order holds after a lease that didn't answer plainly: the lease of
   * this offer if it was made, with what went wrong; a refusal Console named
   * when nothing was; otherwise that it may yet have been.
   */
  private async reconcile(
    client: AkashConsoleClient,
    ctx: AkashRequestContext,
    id: AkashDeploymentId,
    offer: AkashOfferId,
    chosen: AkashBid | null,
    error: AkashApiError | null,
    note: { machine?: CloudMachineState; problem: string } | null
  ): Promise<ProviderResource> {
    let view: DeploymentView;
    try {
      view = await this.read(client, ctx, id);
    } catch (readError) {
      if (readError instanceof AkashApiError && readError.kind === "cancelled") throw readError;
      throw new AkashApiError(
        "outcome-unknown",
        `${note?.problem ?? "The Akash Console's answer to the lease was lost."} Daintree couldn't read the order back: ${errorText(readError)}`,
        null,
        null
      );
    }
    const taken = view.leases.find((lease) => tupleOf(lease.id) === tupleOf(offer));
    if (taken) {
      const resource = await this.leased(client, view, offer, chosen, ctx.signal);
      return note
        ? { ...resource, machine: note.machine ?? resource.machine, error: note.problem }
        : resource;
    }
    if (view.leases.length > 0) throw otherOfferLeased();
    // Nothing was leased: a refusal the Console named stands as it was said.
    if (error && DEFINITE.has(error.kind)) throw error;
    throw new AkashApiError(
      "outcome-unknown",
      "The Akash Console may still lease the offer: its answer was lost.",
      error?.status ?? null,
      error?.code ?? null
    );
  }

  /** The leased machine, saying so when the provider swapped its bid as it was leased. */
  private async leased(
    client: AkashConsoleClient,
    view: DeploymentView,
    offer: AkashOfferId,
    chosen: AkashBid | null,
    signal: AbortSignal | undefined
  ): Promise<ProviderResource> {
    const resource = await this.resourceOf(client, view, signal);
    const lease = view.leases.find((entry) => tupleOf(entry.id) === tupleOf(offer));
    if (!lease) return resource;
    const bseq = (lease.id as { bseq?: unknown }).bseq;
    const swapped =
      (typeof bseq === "number" && bseq !== offer.bseq) ||
      (chosen !== null &&
        (lease.price.denom !== chosen.price.denom ||
          Number(lease.price.amount) !== Number(chosen.price.amount)));
    if (!swapped) return resource;
    const rate = lease.price.denom === AKASH_UACT ? akashHourlyDollars(lease.price.amount) : null;
    return {
      ...resource,
      error: `The provider replaced its offer as it was leased: the lease is at ${rate === null ? `${lease.price.amount} ${lease.price.denom} a block` : `$${rate.toFixed(4)} an hour`}, not the offer chosen.`,
    };
  }

  /**
   * Closes an order nobody leased. Console can't close a deployment only
   * while it is unleased, so this reads, closes, and reads again: the close is
   * never sent twice, and a lease that landed in between, which the close
   * ended, is answered as leased rather than hidden. The lifecycle sends one
   * lease or close for an order at a time, which keeps that window shut.
   */
  private async closeOrder(
    credentials: ProviderCredentials,
    orderId: string
  ): Promise<CloseOrderOutcome> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const id = parseAkashResourceId(orderId);
    let view: DeploymentView;
    try {
      view = await this.read(client, ctx, id);
    } catch (error) {
      if (error instanceof AkashApiError && error.kind === "not-found") return { kind: "closed" };
      throw error;
    }
    if (view.state === "closed" && view.leases.length === 0) return { kind: "closed" };
    if (view.state !== "active" && view.state !== "closed") {
      throw new AkashApiError(
        "bad-response",
        `The Akash Console says order ${id.dseq} is ${view.state}`,
        null,
        null
      );
    }
    if (view.leases.length > 0) {
      return { kind: "leased", resource: await this.resourceOf(client, view, ctx.signal) };
    }
    await client.closeDeployment(ctx, id.dseq, { retry: false });
    let after: DeploymentView;
    try {
      after = await this.read(client, ctx, id);
    } catch (error) {
      if (error instanceof AkashApiError && error.kind === "cancelled") throw error;
      return { kind: "closed" };
    }
    return after.leases.length > 0
      ? { kind: "leased", resource: await this.resourceOf(client, after, ctx.signal) }
      : { kind: "closed" };
  }

  async rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const id = parseAkashResourceId(resourceId);
    const view = await this.read(client, ctx, id);
    await client.renameDeployment(ctx, id.dseq, akashRenamed(view.rawName, name));
  }

  /** Closes the deployment, ending its lease: the container and its disk are gone. */
  async delete(credentials: ProviderCredentials, resourceId: string): Promise<void> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const id = parseAkashResourceId(resourceId);
    const view = await this.read(client, ctx, id);
    if (view.state === "closed") return;
    // Closing this one machine again after a lost answer closes nothing else.
    await client.closeDeployment(ctx, id.dseq, { retry: true });
  }

  /**
   * Where the provider forwards the container's port 22 now, read afresh:
   * the port can change while the machine runs. The provider vouches for no
   * host key, so the person confirms the first one (#18238 pins it).
   */
  async sshAccess(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderSshAccess> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.account(credentials);
    const view = await this.read(client, ctx, parseAkashResourceId(resourceId));
    const state = machineOf(view);
    if (state === null || state.machine === "deleted") {
      throw new AkashApiError("not-found", "That machine's deployment was closed", null, null);
    }
    const lease = currentLease(view.leases);
    if (state.machine !== "running" || !lease) {
      throw new AkashApiError(
        "conflict",
        `Its lease is ${lease?.state ?? "gone"}, so it can't be reached`,
        null,
        null
      );
    }
    const forwarded = (lease.status?.forwarded_ports?.[AKASH_SERVICE] ?? [])
      .map((entry) => akashForwardedPortSchema.safeParse(entry))
      .flatMap((parsed) => (parsed.success && parsed.data.port === 22 ? [parsed.data] : []))
      .filter((entry) => entry.host && entry.available !== 0);
    if (forwarded.length === 0) {
      throw new AkashApiError(
        "not-ready",
        "The provider doesn't say where the machine's SSH port is yet",
        null,
        null
      );
    }
    const endpoint = forwarded
      .map((entry) => ({ host: entry.host!, port: entry.externalPort }))
      .find((candidate) => isValidSshEndpoint(candidate));
    if (!endpoint) {
      throw new AkashApiError(
        "bad-response",
        "The provider reported an SSH address Daintree can't use",
        null,
        null
      );
    }
    return { user: AKASH_SSH_USER, endpoint, hostKey: null };
  }

  /**
   * One deployment, from the account's project, checked to be the wallet's and
   * the dseq's asked for. Another wallet's deployment of the same number is a
   * key that acts for another wallet, never this machine gone. `owner: null`
   * takes whichever wallet the account deploys from.
   */
  private async read(
    client: AkashConsoleClient,
    ctx: AkashRequestContext,
    id: { owner: string | null; dseq: string }
  ): Promise<DeploymentView> {
    const view = viewOf(await client.deployment(ctx, id.dseq));
    if (view.id.dseq !== id.dseq) {
      throw new AkashApiError(
        "bad-response",
        "The Akash Console answered with another deployment",
        null,
        null
      );
    }
    if (id.owner !== null && view.id.owner !== id.owner) throw otherWallet();
    return view;
  }

  /** The order's bids, every one checked to be on that order of that wallet. */
  private async bidsOf(
    client: AkashConsoleClient,
    ctx: AkashRequestContext,
    id: AkashDeploymentId
  ): Promise<AkashBid[]> {
    const bids = parseItems(await client.bids(ctx, id.dseq), akashBidSchema).map(
      (entry) => entry.bid
    );
    if (bids.some((bid) => bid.id.dseq.replace(/^0+/, "") !== id.dseq)) {
      throw new AkashApiError(
        "bad-response",
        "The Akash Console listed bids on another order",
        null,
        null
      );
    }
    if (bids.some((bid) => !sameDeployment(bid.id, id))) throw otherWallet();
    return bids;
  }

  /**
   * Every page of the account's deployments in `state`. A search the Console
   * won't run, over too many deployments or while its archive's index is
   * down, is run again as a plain listing read whole, rather than answered
   * with part of one.
   */
  private async everyDeployment(
    client: AkashConsoleClient,
    ctx: AkashRequestContext,
    state: "active" | "closed",
    search: string | undefined
  ): Promise<DeploymentView[]> {
    try {
      return await this.pages(client, ctx, state, search);
    } catch (error) {
      if (
        search === undefined ||
        !(error instanceof AkashApiError) ||
        error.kind !== "unprocessable"
      ) {
        throw error;
      }
      return this.pages(client, ctx, state, undefined);
    }
  }

  /** Every page, read again from the start when the list moved under it; refused when it never holds still. */
  private async pages(
    client: AkashConsoleClient,
    ctx: AkashRequestContext,
    state: "active" | "closed",
    search: string | undefined
  ): Promise<DeploymentView[]> {
    for (let attempt = 0; attempt < MAX_SCANS; attempt++) {
      const views = await this.scan(client, ctx, state, search);
      if (views) return views;
    }
    throw new AkashApiError(
      "bad-response",
      "The Akash Console's deployments kept changing while Daintree read them",
      null,
      null
    );
  }

  /**
   * One pass over every page; null when the list moved. Each page after the
   * first starts at the last row already read, so a row that left the list
   * meanwhile, moving every later row up, shows as that row missing.
   */
  private async scan(
    client: AkashConsoleClient,
    ctx: AkashRequestContext,
    state: "active" | "closed",
    search: string | undefined
  ): Promise<DeploymentView[] | null> {
    const views: DeploymentView[] = [];
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        throw new AkashApiError(
          "bad-response",
          "The Akash Console listed more deployments than Daintree reads",
          null,
          null
        );
      }
      const last = views.at(-1);
      const answer = await client.deployments(ctx, {
        state,
        skip: last ? views.length - 1 : 0,
        limit: PAGE_SIZE,
        search,
      });
      const rows = answer.deployments.map(viewOf);
      if (last) {
        const overlap = rows.shift();
        if (!overlap || akashResourceId(overlap.id) !== akashResourceId(last.id)) return null;
      }
      views.push(...rows);
      if (!answer.hasMore) return views;
      if (rows.length === 0) {
        throw new AkashApiError(
          "bad-response",
          "The Akash Console said more deployments followed, then listed none",
          null,
          null
        );
      }
    }
  }

  /**
   * The machine a deployment is. `strict` is for a create's lookup, which
   * must not take a block it couldn't read for a machine made at an unknown
   * time: a removal would then forget a machine it should have found.
   */
  private async resourceOf(
    client: AkashConsoleClient,
    view: DeploymentView,
    signal: AbortSignal | undefined,
    strict = false
  ): Promise<ProviderResource> {
    const state = machineOf(view) ?? { machine: "unknown" as const, error: null };
    const lease = currentLease(view.leases);
    const size = view.groups
      ? akashGroupsFacts(view.groups).size
      : akashDefinitionSize(view.definition);
    // Only a create's lookup reads when it was made, and only a marked deployment is one it looks for.
    const marked = view.name.createKey !== null;
    const createdAt = marked
      ? await this.blockTime(client, view.createdHeight, signal, strict)
      : null;
    return {
      resourceId: akashResourceId(view.id),
      name: view.name.display || akashResourceId(view.id),
      machine: state.machine,
      rawState: `deployment ${view.state}, lease ${lease?.state ?? "none"}`,
      machineType: size.machineType,
      vcpu: size.vcpu,
      memoryGB: size.memoryGB,
      autoStopAt: null,
      lifetimeSeconds: null,
      stoppedAt: null,
      createdAt,
      stop: null,
      lastSnapshotAt: null,
      dataExpired: false,
      snapshotsDisabled: false,
      labels: { ...view.name.labels },
      restricted: false,
      error: state.error,
    };
  }

  /**
   * When the order was placed, from the chain's block: a deployment carries
   * its height, not a time. Null when the Console has no such block, or,
   * unless `strict`, when it couldn't be read: a create's lookup takes that
   * as maybe made by it, never as not made.
   */
  private async blockTime(
    client: AkashConsoleClient,
    height: number | null,
    signal: AbortSignal | undefined,
    strict: boolean
  ): Promise<string | null> {
    if (height === null) return null;
    const key = `${client.baseUrl} ${height}`;
    const known = this.blockTimes.get(key);
    if (known) return known;
    let time: string | null;
    try {
      time = await client.blockTime(height, signal);
    } catch (error) {
      if (strict || (error instanceof AkashApiError && error.kind === "cancelled")) throw error;
      return null;
    }
    if (time === null) return null;
    // A block's time never changes; only how many are kept is bounded.
    if (this.blockTimes.size >= MAX_BLOCK_TIMES) {
      this.blockTimes.delete(this.blockTimes.keys().next().value!);
    }
    this.blockTimes.set(key, time);
    return time;
  }

  describeError(error: unknown): CloudHostError {
    const at = Date.now();
    if (!(error instanceof AkashApiError)) {
      return {
        code: "failed",
        message:
          error instanceof AppError && error.userMessage
            ? error.userMessage
            : formatErrorMessage(error, "Something went wrong talking to the Akash Console"),
        at,
      };
    }
    // Names the Console supplied (an organization's, a project's) go into some messages.
    const said = redactAkashText(error.message);
    switch (error.kind) {
      case "unauthorized":
        return {
          code: "credential-invalid",
          message:
            "The Akash Console didn't accept this account's API key. Replace it in Settings → Hosts.",
          at,
        };
      case "wrong-scope":
        return { code: "credential-invalid", message: said, at };
      case "forbidden":
        return error.code === "project_budget_exceeded"
          ? {
              code: "billing",
              message: `The Akash Console needs a budget change first: ${said}`,
              at,
            }
          : {
              code: "permission",
              message: `This key isn't allowed to do that (${said}). Give it access on the Akash Console, or use another key.`,
              at,
            };
      case "payment-required":
        return {
          code: "billing",
          message: `The Akash Console needs a billing change first: ${said}`,
          at,
        };
      case "rate-limited":
        return {
          code: "rate-limited",
          message: "The Akash Console's request limit was reached. Try again in a few minutes.",
          at,
        };
      case "not-found":
        return {
          code: "not-found",
          message: "The Akash Console doesn't know this in this account's project.",
          at,
        };
      case "invalid-request":
      case "conflict":
      case "unprocessable":
        return { code: "refused", message: `The Akash Console turned this down: ${said}`, at };
      case "network":
      case "timeout":
        return { code: "provider-unreachable", message: "Couldn't reach the Akash Console.", at };
      case "server":
        return {
          code: "provider-unreachable",
          message: `The Akash Console had a problem: ${said}`,
          at,
        };
      case "unsupported":
        return { code: "unsupported", message: said, at };
      case "offer-gone":
      case "declined":
        return { code: "refused", message: said, at };
      case "outcome-unknown":
        return { code: "outcome-unknown", message: said, at };
      case "not-ready":
        return { code: "provider-unreachable", message: said, at };
      case "cancelled":
        return { code: "failed", message: "Cancelled.", at };
      default:
        return { code: "failed", message: said, at };
    }
  }
}
