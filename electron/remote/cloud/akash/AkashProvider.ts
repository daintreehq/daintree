import type {
  CloudAccountCheckResult,
  CloudAccountScopeChoice,
  CloudCredentialValues,
  CloudHostError,
  CloudMachineType,
  CloudProviderInfo,
  CloudProvisioningChoice,
} from "../../../../shared/types/cloudHosts.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { pluralize } from "../../../../shared/utils/pluralize.js";
import { AppError } from "../../../utils/errorTypes.js";
import {
  CLOUD_HOSTS_UNSUPPORTED_ON_WINDOWS,
  type CloudProvider,
  type OfferCreate,
  type ProviderCatalog,
  type ProviderCredentials,
  type ProviderResource,
  type ProviderSshAccess,
} from "../provider.js";
import {
  AkashApiError,
  type AkashConsoleClient,
  type AkashRequestContext,
} from "./AkashConsoleClient.js";
import {
  AKASH_INSTANCE_TYPES,
  akashInstanceTypeLabel,
  akashScreeningRequest,
} from "./akashInstanceTypes.js";
import type { AkashPlacementOptions, AkashScreenedProvider } from "./akashSchemas.js";

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

/** Until deployments are placed, reached and closed through the Console (#18236). */
function notYet(): Promise<never> {
  return Promise.reject(unsupported("Daintree can't manage Akash deployments yet."));
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

  constructor(private readonly clientFor: (apiUrl: string) => AkashConsoleClient) {}

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
    let project;
    try {
      project = await client.project({ ...ctx, projectId }, projectId);
    } catch (error) {
      const lost =
        error instanceof AkashApiError &&
        (error.kind === "not-found" ||
          (error.kind === "forbidden" && error.code === "project_forbidden"));
      if (!lost) throw error;
      throw new AkashApiError(
        "wrong-scope",
        "This key no longer reaches the Akash Console project this account deploys into. Replace it with a key that does, or connect the other project as its own account.",
        error.status,
        error.code
      );
    }
    if (project.id.toLowerCase() !== projectId) {
      throw new AkashApiError(
        "bad-response",
        "The Akash Console answered with another project than the one asked for",
        null,
        null
      );
    }
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
    const busiest = regionChoices
      .filter((choice) => choice.available)
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

  list(): Promise<ProviderResource[]> {
    return notYet();
  }

  inspect(): Promise<ProviderResource> {
    return notYet();
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
    placeOrder: notYet,
    findOrders: notYet,
    listOffers: notYet,
    leaseOffer: notYet,
    closeOrder: notYet,
  };

  rename(): Promise<void> {
    return notYet();
  }

  delete(): Promise<void> {
    return notYet();
  }

  sshAccess(): Promise<ProviderSshAccess> {
    return notYet();
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
    const said = error.message;
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
      case "cancelled":
        return { code: "failed", message: "Cancelled.", at };
      default:
        return { code: "failed", message: said, at };
    }
  }
}
