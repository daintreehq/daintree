import net from "node:net";
import type {
  CloudAccountCheckResult,
  CloudBillingScope,
  CloudCredentialValues,
  CloudHostError,
  CloudMachineType,
  CloudProviderInfo,
  CloudProvisioningChoice,
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
  DigitalOceanApiError,
  type DigitalOceanClient,
  type DigitalOceanRequestContext,
} from "./DigitalOceanClient.js";
import type {
  DigitalOceanAccount,
  DigitalOceanAction,
  DigitalOceanDroplet,
  DigitalOceanImage,
  DigitalOceanSize,
} from "./digitalOceanSchemas.js";
import { digitalOceanMachineState } from "./digitalOceanState.js";
import {
  DROPLET_SSH_USER,
  dropletUserData,
  md5Fingerprint,
  parsePublicKey,
  type ParsedPublicKey,
} from "./digitalOceanUserData.js";

const MAX_TOKEN_LENGTH = 4096;

function invalidToken(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

/** The personal access token from an entered set: one line of printable ASCII, as DigitalOcean issues them. */
export function digitalOceanToken(values: Readonly<CloudCredentialValues>): string {
  const token = values.apiKey;
  if (typeof token !== "string" || token.length === 0) {
    throw invalidToken("Paste a personal access token.");
  }
  if (/PRIVATE KEY/.test(token)) throw invalidToken("That's a private key, not an access token.");
  if (token.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(token)) {
    throw invalidToken(
      "That doesn't look like an access token: it should be one line of letters, digits and symbols."
    );
  }
  return token;
}

/** DigitalOcean's tag alphabet; a label is kept as the tag `key:value`. */
const TAG = /^[A-Za-z0-9_:-]{1,255}$/;
/** Below this the Host and its agents don't fit beside apt on first boot. */
const MIN_MEMORY_MIB = 2048;
const PREFERRED_IMAGE = "ubuntu-24-04-x64";
const PREFERRED_REGION = "nyc3";
/**
 * How long `stop()` follows the shutdown it asked for: enough for a graceful
 * shutdown to finish or be given up on, so an errored one is reported rather
 * than waited out, while the lifecycle's own stop deadline still governs.
 */
const SHUTDOWN_FOLLOW_MS = 3 * 60_000;
const SHUTDOWN_POLL_MS = 3_000;

/**
 * The distribution images whose apt can install what the Host needs and
 * whose glibc runs it: Ubuntu LTS from 22.04 and Debian from 12, x86-64.
 */
export function isSupportedDropletImage(image: DigitalOceanImage): boolean {
  const slug = image.slug ?? "";
  if (image.public === false) return false;
  if (image.status && image.status.toLowerCase() !== "available") return false;
  const ubuntu = /^ubuntu-(\d{2})-04-x64$/.exec(slug);
  if (ubuntu) {
    const year = Number(ubuntu[1]);
    return year >= 22 && year % 2 === 0;
  }
  const debian = /^debian-(\d+)-x64$/.exec(slug);
  return debian !== null && Number(debian[1]) >= 12;
}

/** The labels a create asked for, as DigitalOcean tags; refused rather than changed when one won't fit. */
export function labelsToTags(labels: Record<string, string>): string[] {
  return Object.entries(labels).map(([key, value]) => {
    const tag = `${key}:${value}`;
    if (key.includes(":") || !TAG.test(tag)) {
      throw new DigitalOceanApiError(
        "invalid-request",
        `The label ${JSON.stringify(key)} can't be kept as a DigitalOcean tag`,
        null,
        null,
        null
      );
    }
    return tag;
  });
}

/** The tag a `key=value` label filter names; null when it can't be one. */
export function labelFilterToTag(filter: string): string | null {
  const equals = filter.indexOf("=");
  if (equals <= 0) return null;
  const key = filter.slice(0, equals);
  const tag = `${key}:${filter.slice(equals + 1)}`;
  return !key.includes(":") && TAG.test(tag) ? tag : null;
}

/** A Droplet's `key:value` tags back as labels; tags of any other shape are left out. */
export function tagsToLabels(tags: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tag of tags) {
    const colon = tag.indexOf(":");
    if (colon > 0) labels[tag.slice(0, colon)] = tag.slice(colon + 1);
  }
  return labels;
}

/**
 * A name as a Droplet's hostname: one DNS label of lowercase letters, digits
 * and hyphens, at most 63 long; `fallback` when nothing of the name survives.
 */
export function dropletHostname(name: string, fallback: string): string {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return label.length > 0 ? label : fallback;
}

/** The Droplet's public IPv4 address, once DigitalOcean has given it one. */
export function publicIpv4(droplet: DigitalOceanDroplet): string | null {
  const entry = droplet.networks?.v4?.find(
    (network) => network.type === "public" && net.isIPv4(network.ip_address)
  );
  return entry?.ip_address ?? null;
}

function pendingStop(action: DigitalOceanAction | null): ProviderResource["stop"] {
  if (!action) return null;
  return {
    id: String(action.id),
    status: action.status === "completed" ? "completed" : "pending",
    error: null,
  };
}

/** A Droplet as a machine. One without a public address yet is still coming up: nothing can reach it. */
export function dropletResource(
  droplet: DigitalOceanDroplet,
  inFlight: DigitalOceanAction | null = null
): ProviderResource {
  let machine = digitalOceanMachineState(droplet.status);
  if (machine === "running" && !publicIpv4(droplet)) machine = "starting";
  const shuttingDown = inFlight?.type === "shutdown" && inFlight.status === "in-progress";
  const poweringOn = inFlight?.type === "power_on" && inFlight.status === "in-progress";
  if (shuttingDown && machine === "running") machine = "stopping";
  if (poweringOn && machine === "stopped") machine = "starting";
  return {
    resourceId: String(droplet.id),
    name: droplet.name,
    machine,
    rawState: droplet.status,
    machineType: droplet.size_slug ?? null,
    vcpu: droplet.vcpus ?? null,
    memoryGB: typeof droplet.memory === "number" ? droplet.memory / 1024 : null,
    autoStopAt: null,
    lifetimeSeconds: null,
    stoppedAt: null,
    createdAt: droplet.created_at ?? null,
    stop: shuttingDown ? pendingStop(inFlight) : null,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: false,
    labels: tagsToLabels(droplet.tags),
    restricted: false,
    error: null,
  };
}

function scopeOf(account: DigitalOceanAccount): CloudBillingScope {
  return account.team
    ? { kind: "organization", id: account.team.uuid, name: account.team.name }
    : { kind: "personal", id: account.uuid, name: "Personal" };
}

function sizeChoice(size: DigitalOceanSize): CloudMachineType {
  return {
    id: size.slug,
    label: size.description ? `${size.description} ${size.slug}` : size.slug,
    vcpu: size.vcpus,
    memoryGB: size.memory / 1024,
    hourlyDollars: typeof size.price_hourly === "number" ? size.price_hourly : null,
    available: true,
    reason: null,
  };
}

function imageChoice(
  image: DigitalOceanImage,
  regions: ReadonlySet<string>
): CloudProvisioningChoice {
  return {
    id: image.slug!,
    label: `${image.distribution} ${image.name}`,
    description: image.description ?? null,
    available: true,
    reason: null,
    locations: image.regions.filter((region) => regions.has(region)),
  };
}

export class DigitalOceanProvider implements CloudProvider {
  readonly id = "digitalocean" as const;

  constructor(
    private readonly clientFor: (apiUrl: string) => DigitalOceanClient,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
    private readonly now: () => number = Date.now
  ) {}

  info(platform: NodeJS.Platform): CloudProviderInfo {
    return {
      id: "digitalocean",
      name: "DigitalOcean",
      description:
        "Droplets on your own DigitalOcean team: a Linux machine that runs until you stop it and bills until you delete it.",
      apiKeyUrl: "https://cloud.digitalocean.com/account/api/tokens",
      dashboardUrl: "https://cloud.digitalocean.com/droplets",
      docsUrl: "https://docs.digitalocean.com/products/droplets/",
      credentialFields: [
        {
          id: "apiKey",
          label: "Personal access token",
          secret: true,
          input: "single-line",
          required: true,
          help: "Full access, or custom scopes covering Droplets, SSH keys, tags, regions, sizes, images and account reads",
        },
      ],
      capabilities: {
        persistence: {
          kept: "Files on its disk",
          lost: "running processes and memory",
          retentionDays: null,
          saveRetryBilled: true,
          stoppedComputeBilled: true,
          // Stopping doesn't cut the bill to the disk: the whole Droplet keeps billing.
          stoppedStorageBilled: false,
          stoppedBilling: "DigitalOcean bills a stopped Droplet in full until it's deleted.",
        },
        typicalStartSeconds: null,
        lifetime: { kind: "none" },
        sshTrust: "confirm-on-first-connect",
        transport: "direct",
        tunnel: null,
        provisioning: {
          location: "required",
          image: "required",
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

  private ctx(credentials: ProviderCredentials): DigitalOceanRequestContext {
    const token = credentials.values.apiKey;
    // Never sent without one: an empty bearer would only come back as DigitalOcean's refusal.
    if (!token) throw new DigitalOceanApiError("unauthorized", "No token", null, null, null);
    return { token, signal: credentials.signal };
  }

  async checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal?: AbortSignal
  ): Promise<CloudAccountCheckResult> {
    const client = this.clientFor(apiUrl);
    const ctx = { token: digitalOceanToken(values), signal };
    const account = await client.account(ctx);
    // Signing in isn't enough: the token must be allowed to see Droplets.
    await client.probeDroplets(ctx);
    return {
      identity: account.email ?? null,
      // A token belongs to exactly one team, which every request it makes bills.
      scopes: [{ scope: scopeOf(account), active: true }],
    };
  }

  async validate(credentials: ProviderCredentials): Promise<{ identity: string | null }> {
    const client = this.clientFor(credentials.apiUrl);
    const account = await client.account(this.ctx(credentials));
    const scope = scopeOf(account);
    if (scope.id !== credentials.scopeId) {
      throw new DigitalOceanApiError(
        "wrong-team",
        `This token belongs to ${scope.kind === "personal" ? "another DigitalOcean account" : `the DigitalOcean team ${scope.name}`}, not the one this account bills. Replace it with a token from that team, or connect the other team as its own account.`,
        null,
        null,
        null
      );
    }
    await client.probeDroplets(this.ctx(credentials));
    return { identity: account.email ?? null };
  }

  async catalog(credentials: ProviderCredentials): Promise<ProviderCatalog> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.ctx(credentials);
    const [account, regions, sizes, images] = await Promise.all([
      client.account(ctx),
      client.listRegions(ctx),
      client.listSizes(ctx),
      client.listDistributionImages(ctx),
    ]);
    const offeredImages = images.filter(isSupportedDropletImage);
    const imageRegions = new Set(offeredImages.flatMap((image) => image.regions));
    const usableSizes = sizes.filter(
      (size) =>
        size.available &&
        size.memory >= MIN_MEMORY_MIB &&
        !size.slug.startsWith("gpu-") &&
        size.regions.length > 0
    );
    const sizeRegions = new Set(usableSizes.flatMap((size) => size.regions));
    // A region is offered when it takes new Droplets and has a size and an image to make one with.
    let candidateRegions = regions
      .filter(
        (region) =>
          region.available && sizeRegions.has(region.slug) && imageRegions.has(region.slug)
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    // A size can't say which regions have it, so only one every offered region has is offered:
    // any region and size the person picks together then make a Droplet. When no size is in
    // all of them, the regions narrow to those of the size most of them have.
    const inEvery = (size: DigitalOceanSize, among: typeof candidateRegions) =>
      among.length > 0 && among.every((region) => size.regions.includes(region.slug));
    if (!usableSizes.some((size) => inEvery(size, candidateRegions))) {
      const widest = usableSizes
        .map((size) => ({
          size,
          covered: candidateRegions.filter((region) => size.regions.includes(region.slug)).length,
        }))
        .sort((a, b) => b.covered - a.covered)[0];
      candidateRegions = widest
        ? candidateRegions.filter((region) => widest.size.regions.includes(region.slug))
        : [];
    }
    const offeredRegions = candidateRegions;
    const regionIds = new Set(offeredRegions.map((region) => region.slug));
    const offeredSizes = usableSizes
      .filter((size) => inEvery(size, offeredRegions))
      .sort(
        (a, b) =>
          (a.price_hourly ?? Number.POSITIVE_INFINITY) -
            (b.price_hourly ?? Number.POSITIVE_INFINITY) || a.memory - b.memory
      );
    const imageChoices = offeredImages
      .map((image) => imageChoice(image, regionIds))
      .sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
    const defaultImage =
      imageChoices.find((choice) => choice.id === PREFERRED_IMAGE)?.id ??
      imageChoices.find((choice) => choice.id.startsWith("ubuntu-"))?.id ??
      imageChoices[0]?.id ??
      null;
    const locked = account.status === "locked";
    return {
      machineTypes: offeredSizes.map(sizeChoice),
      canStart: !locked,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
      provisioning: {
        location: {
          label: "Region",
          choices: offeredRegions.map((region) => ({
            id: region.slug,
            label: region.name,
            description: region.slug,
            available: true,
            reason: null,
            locations: null,
          })),
          defaultId: regionIds.has(PREFERRED_REGION)
            ? PREFERRED_REGION
            : (offeredRegions[0]?.slug ?? null),
        },
        image: { label: "Image", choices: imageChoices, defaultId: defaultImage },
      },
    };
  }

  async list(
    credentials: ProviderCredentials,
    options: { label?: string } = {}
  ): Promise<ProviderResource[]> {
    let tag: string | undefined;
    if (options.label !== undefined) {
      const filter = labelFilterToTag(options.label);
      if (!filter) {
        throw new DigitalOceanApiError(
          "invalid-request",
          "That label can't be looked up as a DigitalOcean tag",
          null,
          null,
          null
        );
      }
      tag = filter;
    }
    const droplets = await this.clientFor(credentials.apiUrl).listDroplets(
      this.ctx(credentials),
      tag
    );
    if (tag !== undefined) {
      // How a lost create is found again: an answer that doesn't plainly hold the one tag asked
      // for (a row without it, or carrying two values for its key) fails, rather than reading as none.
      const key = tag.slice(0, tag.indexOf(":") + 1);
      for (const droplet of droplets) {
        const values = new Set(droplet.tags.filter((entry) => entry.startsWith(key)));
        if (!values.has(tag) || values.size > 1) {
          throw new DigitalOceanApiError(
            "bad-response",
            "DigitalOcean's tag lookup listed a Droplet that doesn't carry that tag alone",
            null,
            null,
            null
          );
        }
      }
    }
    return droplets.map((droplet) => dropletResource(droplet));
  }

  async inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource> {
    const client = this.clientFor(credentials.apiUrl);
    const droplet = await client.getDroplet(this.ctx(credentials), resourceId);
    // A Droplet is locked while an action runs on it; only then is it worth asking which.
    if (!droplet.locked) return dropletResource(droplet);
    const actions = await client
      .recentDropletActions(this.ctx(credentials), resourceId)
      .catch(() => [] as DigitalOceanAction[]);
    const inFlight =
      actions.find(
        (action) =>
          action.status === "in-progress" &&
          (action.type === "shutdown" || action.type === "power_on")
      ) ?? null;
    return dropletResource(droplet, inFlight);
  }

  async create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource> {
    const { location: region, image } = request.provisioning;
    if (!region || !image) {
      throw new DigitalOceanApiError(
        "invalid-request",
        "A Droplet needs a region and an image",
        null,
        null,
        null
      );
    }
    const key = request.publicKey ? parsePublicKey(request.publicKey) : null;
    if (!key) {
      throw new DigitalOceanApiError(
        "invalid-request",
        "This account's SSH key isn't one DigitalOcean can take",
        null,
        null,
        null
      );
    }
    const tags = labelsToTags(request.labels);
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.ctx(credentials);
    const keyId = await this.accountKeyId(client, ctx, key);
    const binding = request.labels["daintree-binding"];
    const droplet = await client.createDroplet(ctx, {
      name: dropletHostname(
        request.name,
        binding ? dropletHostname(`daintree-${binding}`, "daintree") : "daintree"
      ),
      region,
      size: request.machineType,
      image,
      ssh_keys: [keyId],
      tags,
      user_data: dropletUserData(key),
    });
    return dropletResource(droplet);
  }

  /**
   * The id DigitalOcean files this key under on the account, registering it
   * the first time. Looked up by fingerprint first, and again when a
   * registration is refused, since another create may have just made it.
   */
  private async accountKeyId(
    client: DigitalOceanClient,
    ctx: DigitalOceanRequestContext,
    key: ParsedPublicKey
  ): Promise<number> {
    const fingerprint = md5Fingerprint(key);
    const known = await client.findSshKey(ctx, fingerprint);
    if (known) return known.id;
    try {
      const made = await client.createSshKey(ctx, {
        name: `Daintree ${fingerprint.slice(-11)}`,
        public_key: `${key.type} ${key.blob}`,
      });
      return made.id;
    } catch (error) {
      if (!(error instanceof DigitalOceanApiError) || error.kind !== "unprocessable") throw error;
      const raced = await client.findSshKey(ctx, fingerprint);
      if (raced) return raced.id;
      throw error;
    }
  }

  async start(
    credentials: ProviderCredentials,
    resourceId: string,
    _options: { lifetimeSeconds?: number | null }
  ): Promise<ProviderResource | null> {
    await this.clientFor(credentials.apiUrl).dropletAction(this.ctx(credentials), resourceId, {
      type: "power_on",
    });
    return null;
  }

  /**
   * A graceful shutdown, never a forced power-off. DigitalOcean only promises
   * to send it, so the action is followed for a while: one the Droplet's
   * system ignored fails the stop instead of leaving it to wait out its deadline.
   */
  async stop(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderResource | null> {
    const client = this.clientFor(credentials.apiUrl);
    const ctx = this.ctx(credentials);
    let action = await client.dropletAction(ctx, resourceId, { type: "shutdown" });
    const deadline = this.now() + SHUTDOWN_FOLLOW_MS;
    while (action.status === "in-progress" && this.now() < deadline) {
      await this.sleep(SHUTDOWN_POLL_MS, ctx.signal);
      action = await client.getDropletAction(ctx, resourceId, action.id);
    }
    if (action.status === "errored") {
      throw new DigitalOceanApiError(
        "action-errored",
        "The Droplet didn't shut down: its system didn't answer DigitalOcean's shutdown request. Stop it again, or power it off from DigitalOcean's console.",
        null,
        null,
        null
      );
    }
    const droplet = await client.getDroplet(ctx, resourceId);
    return dropletResource(droplet, action);
  }

  async rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void> {
    await this.clientFor(credentials.apiUrl).dropletAction(this.ctx(credentials), resourceId, {
      type: "rename",
      name: dropletHostname(name, `daintree-${resourceId}`),
    });
  }

  async delete(credentials: ProviderCredentials, resourceId: string): Promise<void> {
    await this.clientFor(credentials.apiUrl).deleteDroplet(this.ctx(credentials), resourceId);
  }

  /** The Droplet took the key with its create; this only reads where it answers. */
  async sshAccess(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<ProviderSshAccess> {
    const droplet = await this.clientFor(credentials.apiUrl).getDroplet(
      this.ctx(credentials),
      resourceId
    );
    const host = publicIpv4(droplet);
    if (!host) {
      throw new DigitalOceanApiError(
        "not-ready",
        "DigitalOcean hasn't given the Droplet a public address yet",
        null,
        null,
        null
      );
    }
    // No API returns a Droplet's host key: the person confirms the one it presents.
    return { user: DROPLET_SSH_USER, endpoint: { host, port: 22 }, hostKey: null };
  }

  describeError(error: unknown): CloudHostError {
    const at = Date.now();
    if (!(error instanceof DigitalOceanApiError)) {
      return {
        code: "failed",
        message:
          error instanceof AppError && error.userMessage
            ? error.userMessage
            : formatErrorMessage(error, "Something went wrong talking to DigitalOcean"),
        at,
      };
    }
    const said = error.message;
    switch (error.kind) {
      case "unauthorized":
        return {
          code: "credential-invalid",
          message:
            "DigitalOcean didn't accept this account's token. Replace it in Settings → Hosts.",
          at,
        };
      case "wrong-team":
        return { code: "credential-invalid", message: said, at };
      case "forbidden":
        return {
          code: "permission",
          message: `This token isn't allowed to do that (${said}). Give it the scope on DigitalOcean, or use another token.`,
          at,
        };
      case "payment-required":
        return {
          code: "billing",
          message: `DigitalOcean needs a billing change first: ${said}`,
          at,
        };
      case "rate-limited":
        return {
          code: "rate-limited",
          message: "DigitalOcean's API limit was reached. Try again in a few minutes.",
          at,
        };
      case "unprocessable":
        return { code: "refused", message: `DigitalOcean turned this down: ${said}`, at };
      case "not-found":
        return {
          code: "not-found",
          message: "DigitalOcean doesn't know this Droplet in this account's team.",
          at,
        };
      case "network":
      case "timeout":
        return { code: "provider-unreachable", message: "Couldn't reach DigitalOcean.", at };
      case "server":
        return {
          code: "provider-unreachable",
          message: `DigitalOcean had a problem: ${said}`,
          at,
        };
      case "not-ready":
        return { code: "provider-unreachable", message: `${said}.`, at };
      case "cancelled":
        return { code: "failed", message: "Cancelled.", at };
      default:
        return { code: "failed", message: said, at };
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => new DigitalOceanApiError("cancelled", "Cancelled", null, null, null);
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
