import { AkashApiError } from "./AkashConsoleClient.js";
import {
  AKASH_CONSOLE_AUDITOR,
  AKASH_INSTANCE_TYPES,
  type AkashInstanceType,
} from "./akashInstanceTypes.js";
import { AKASH_DSEQ, akashGroupSpecSchema } from "./akashSchemas.js";

/**
 * How Daintree spells an Akash deployment: its id across accounts, the mark
 * in its name that finds it again, the SDL it is created from, and the size
 * it reports.
 */

/** The image a deployment runs, which Daintree publishes and names by digest (docs/distribution/host-image.md). */
export const AKASH_HOST_IMAGE = /^ghcr\.io\/daintreehq\/daintree-host@sha256:[0-9a-f]{64}$/;

/** The image's one login, which takes Daintree's key when the container starts. */
export const AKASH_SSH_USER = "daintree";

/** The one service, and compute profile, every deployment Daintree makes declares. */
export const AKASH_SERVICE = "daintree";

const PLACEMENT = "region";

/**
 * The most an order accepts per block, in uact: Console's own ceiling for a
 * new service (akash-network/console apps/api/src/feedback/lib/sdl-pricing/sdl-pricing.ts,
 * `DEFAULT_MAX_PRICE`). Bids under it are what the person chooses from.
 */
const MAX_PRICE_UACT = 100_000;

/** The name a deployment can carry, as the Console limits it. */
export const AKASH_MAX_NAME_LENGTH = 256;

/** Carries the create's idempotency key in the mark, beside the request's labels. */
export const AKASH_CREATE_KEY_LABEL = "daintree-create";

const GIB = 1024 ** 3;

export interface AkashDeploymentId {
  owner: string;
  dseq: string;
}

// A wallet address is lowercase bech32; nothing in it may be a separator.
const OWNER = /^akash1[0-9a-z]{1,120}$/;

/**
 * A deployment's id across every account: the managed wallet that owns it,
 * and its sequence number there. Two wallets number their deployments apart.
 */
export function akashResourceId(id: AkashDeploymentId): string {
  return `${id.owner}/${id.dseq.replace(/^0+/, "")}`;
}

/** The wallet and dseq an id names; refused, asking nothing, when it names none. */
export function parseAkashResourceId(resourceId: string): AkashDeploymentId {
  const slash = resourceId.indexOf("/");
  const owner = resourceId.slice(0, slash);
  const dseq = resourceId.slice(slash + 1);
  if (slash < 0 || !OWNER.test(owner) || !AKASH_DSEQ.test(dseq)) {
    throw new AkashApiError("invalid-request", "That isn't an Akash deployment id", null, null);
  }
  return { owner, dseq: dseq.replace(/^0+/, "") };
}

/** One offer on an order: the bid's order, its bidder, and which of that bidder's bids. */
export interface AkashOfferId {
  gseq: number;
  oseq: number;
  provider: string;
  bseq: number;
}

const OFFER_ID = /^(\d{1,9})\/(\d{1,9})\/(akash1[0-9a-z]{1,120})\/(\d{1,9})$/;

export function akashOfferId(offer: AkashOfferId): string {
  return `${offer.gseq}/${offer.oseq}/${offer.provider}/${offer.bseq}`;
}

export function parseAkashOfferId(offerId: string): AkashOfferId {
  const match = OFFER_ID.exec(offerId);
  if (!match) {
    throw new AkashApiError("invalid-request", "That isn't an Akash offer id", null, null);
  }
  return {
    gseq: Number(match[1]),
    oseq: Number(match[2]),
    provider: match[3]!,
    bseq: Number(match[4]),
  };
}

const LABEL_KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const TOKEN = /^([a-z0-9][a-z0-9._-]{0,62})=([^\s=[\]]*)$/;
const SUFFIX = /^(?:([\s\S]*) )?\[([^[\]]*)\]$/;

/** One `key=value` of the mark, its value encoded so nothing in it can end the token or the mark. */
export function akashMarkToken(key: string, value: string): string {
  return `${key}=${encodeURIComponent(value)}`;
}

function invalidName(message: string): AkashApiError {
  return new AkashApiError("invalid-request", message, null, null);
}

/**
 * The name a deployment is created with: what the person called it, then the
 * create's labels and idempotency key in brackets, where a search of the
 * account's deployments finds them again after a lost answer or a restart.
 * Console keeps no labels of its own.
 */
export function akashMarkedName(
  display: string,
  labels: Readonly<Record<string, string>>,
  createKey: string
): string {
  const keys = Object.keys(labels).sort();
  for (const key of keys) {
    if (!LABEL_KEY.test(key) || key === AKASH_CREATE_KEY_LABEL) {
      throw invalidName(`Daintree can't put the label ${JSON.stringify(key)} on an Akash name`);
    }
  }
  const tokens = [
    ...keys.map((key) => akashMarkToken(key, labels[key]!)),
    akashMarkToken(AKASH_CREATE_KEY_LABEL, createKey),
  ];
  return withSuffix(display, `[${tokens.join(" ")}]`);
}

function withSuffix(display: string, suffix: string): string {
  const name = display.length > 0 ? `${display} ${suffix}` : suffix;
  if (name.length > AKASH_MAX_NAME_LENGTH) {
    throw invalidName(
      `That name is too long for the Akash Console, which takes ${AKASH_MAX_NAME_LENGTH} characters with Daintree's mark`
    );
  }
  return name;
}

export interface AkashParsedName {
  /** The name without the mark: what the person called it. */
  display: string;
  /** The create's labels; empty for a name that carries no mark. */
  labels: Record<string, string>;
  /** The create's idempotency key; null without one. */
  createKey: string | null;
  /** The mark exactly as written, kept by a rename; null for an unmarked name. */
  suffix: string | null;
}

/**
 * Reads a name back into what made it. Only a well-formed bracket at the very
 * end is a mark; anything else, a person's own brackets included, is name.
 */
export function parseAkashName(name: string | null | undefined): AkashParsedName {
  const text = name ?? "";
  const plain: AkashParsedName = { display: text, labels: {}, createKey: null, suffix: null };
  const match = SUFFIX.exec(text);
  if (!match || match[2]!.length === 0) return plain;
  const labels: Record<string, string> = {};
  let createKey: string | null = null;
  for (const token of match[2]!.split(" ")) {
    const parts = TOKEN.exec(token);
    if (!parts) return plain;
    let value: string;
    try {
      value = decodeURIComponent(parts[2]!);
    } catch {
      return plain;
    }
    const key = parts[1]!;
    if (key === AKASH_CREATE_KEY_LABEL) {
      if (createKey !== null) return plain;
      createKey = value;
    } else {
      if (Object.hasOwn(labels, key)) return plain;
      labels[key] = value;
    }
  }
  return { display: match[1] ?? "", labels, createKey, suffix: `[${match[2]}]` };
}

/** A new display name with the old name's mark kept, so a renamed deployment is still found. */
export function akashRenamed(current: string | null | undefined, display: string): string {
  const { suffix } = parseAkashName(current);
  if (suffix === null) {
    if (display.length === 0 || display.length > AKASH_MAX_NAME_LENGTH) {
      throw invalidName(
        `An Akash name takes 1 to ${AKASH_MAX_NAME_LENGTH} characters, and that one doesn't fit`
      );
    }
    return display;
  }
  return withSuffix(display, suffix);
}

export interface AkashDefinitionInput {
  image: string;
  type: AkashInstanceType;
  region: string;
  publicKey: string;
}

/**
 * The SDL, as the JSON object Console takes in place of the YAML text: the
 * host image on amd64, the account's public key in the environment the image
 * reads it from, sshd's port 22 exposed to the internet, and one machine of
 * the size, placed with an audited provider in the region.
 */
export function akashDefinition(input: AkashDefinitionInput): Record<string, unknown> {
  const { type } = input;
  return {
    version: "2.0",
    services: {
      [AKASH_SERVICE]: {
        image: input.image,
        env: [`DAINTREE_AUTHORIZED_KEYS=${input.publicKey}`],
        expose: [{ port: 22, proto: "tcp", to: [{ global: true }] }],
      },
    },
    profiles: {
      compute: {
        [AKASH_SERVICE]: {
          resources: {
            // The image is published for linux/amd64 only.
            cpu: { units: type.vcpu, attributes: { arch: "amd64" } },
            memory: { size: `${type.memoryGiB}Gi` },
            storage: [{ size: `${type.diskGiB}Gi` }],
          },
        },
      },
      placement: {
        [PLACEMENT]: {
          attributes: { "location-region": input.region.toLowerCase() },
          signedBy: { anyOf: [AKASH_CONSOLE_AUDITOR] },
          pricing: { [AKASH_SERVICE]: { denom: "uact", amount: MAX_PRICE_UACT } },
        },
      },
    },
    deployment: { [AKASH_SERVICE]: { [PLACEMENT]: { profile: AKASH_SERVICE, count: 1 } } },
  };
}

export interface AkashSize {
  machineType: string | null;
  vcpu: number | null;
  memoryGB: number | null;
}

const UNKNOWN_SIZE: AkashSize = { machineType: null, vcpu: null, memoryGB: null };

function sizeOf(millicores: number, memoryBytes: number, storageBytes: number): AkashSize {
  if (![millicores, memoryBytes, storageBytes].every((value) => Number.isFinite(value))) {
    return UNKNOWN_SIZE;
  }
  const type = AKASH_INSTANCE_TYPES.find(
    (entry) =>
      entry.vcpu * 1000 === millicores &&
      entry.memoryGiB * GIB === memoryBytes &&
      entry.diskGiB * GIB === storageBytes
  );
  return {
    machineType: type?.id ?? null,
    vcpu: millicores > 0 ? millicores / 1000 : null,
    memoryGB: memoryBytes > 0 ? memoryBytes / GIB : null,
  };
}

/** The group's one machine, in the chain's units, and its placement region. */
function groupFacts(group: unknown): { size: AkashSize; region: string | null } {
  const parsed = akashGroupSpecSchema.safeParse(group);
  if (!parsed.success) return { size: UNKNOWN_SIZE, region: null };
  const spec = parsed.data.group_spec;
  const region =
    spec?.requirements?.attributes?.find((attribute) => attribute.key === "location-region")
      ?.value ?? null;
  const units = spec?.resources ?? [];
  if (units.length !== 1 || units[0]!.count !== 1) return { size: UNKNOWN_SIZE, region };
  const { resource } = units[0]!;
  const size = sizeOf(
    Number(resource.cpu?.units?.val),
    Number(resource.memory?.quantity?.val),
    (resource.storage ?? []).reduce((sum, volume) => sum + Number(volume.quantity?.val), 0)
  );
  return { size, region: region?.toLowerCase() ?? null };
}

/** What a deployment's groups say about its size and region, as the list reports them. */
export function akashGroupsFacts(groups: readonly unknown[] | undefined): {
  size: AkashSize;
  region: string | null;
} {
  if (!groups || groups.length !== 1) return { size: UNKNOWN_SIZE, region: null };
  return groupFacts(groups[0]);
}

const QUANTITY = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/;
const UNIT: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: GIB,
  Ti: 1024 ** 4,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

function bytesOf(size: unknown): number {
  const match = typeof size === "string" ? QUANTITY.exec(size) : null;
  return match ? Number(match[1]) * (match[2] ? UNIT[match[2]]! : 1) : Number.NaN;
}

/**
 * What a stored SDL says about the size, where a deployment's own route
 * carries no groups: its one compute profile, read only when it is plain.
 */
export function akashDefinitionSize(definition: unknown): AkashSize {
  const compute = (definition as { profiles?: { compute?: unknown } } | null)?.profiles?.compute;
  if (typeof compute !== "object" || compute === null) return UNKNOWN_SIZE;
  const profiles = Object.values(compute);
  if (profiles.length !== 1) return UNKNOWN_SIZE;
  const resources = (
    profiles[0] as {
      resources?: { cpu?: { units?: unknown }; memory?: { size?: unknown }; storage?: unknown };
    }
  )?.resources;
  const cpu = Number(resources?.cpu?.units);
  const storage = Array.isArray(resources?.storage)
    ? resources.storage.reduce(
        (sum: number, volume: { size?: unknown }) => sum + bytesOf(volume?.size),
        0
      )
    : bytesOf((resources?.storage as { size?: unknown } | undefined)?.size);
  return sizeOf(Math.round(cpu * 1000), bytesOf(resources?.memory?.size), storage);
}
