import crypto from "node:crypto";
import {
  CLOUD_LIFETIME_CHOICES,
  CLOUD_PROVISIONING_DIMENSIONS,
  cloudChoiceFitsLocation,
  cloudMachineTypeLocationReason,
  cloudLifetimeIsChosen,
  cloudMarkNamesWorktree,
  cloudProviderNamespace,
  cloudProvisioningArticleNoun,
  cloudProvisioningNoun,
  isCloudProviderId,
  type CloudCatalog,
  type CloudCreateOffer,
  type CloudCreateOfferChoice,
  type CloudCreateOrder,
  type CloudHostCreatedFor,
  type CloudHostCreateRequest,
  type CloudHostProvisioning,
  type CloudHostError,
  type CloudHostErrorCode,
  type CloudHostImportRequest,
  type CloudHostKeyReview,
  type CloudHostStatus,
  type CloudLifetimeModel,
  type CloudLinkedIdleStop,
  type CloudMachineState,
  type CloudOperation,
  type CloudOperationKind,
  type CloudProviderId,
  type CloudProvisioningSelection,
  type CloudSshTrust,
  type CloudSshTunnelCommand,
  type CloudTunnelLookup,
  type CloudWorktreeCleanupOutcome,
  type CloudWorktreeCleanupRequest,
  type CloudWorktreeRef,
} from "../../../shared/types/cloudHosts.js";
import {
  cloudConnection,
  isLocalHostId,
  isValidRemoteHostId,
  type HostConnection,
  type HostDescriptor,
  type HostId,
  type PendingHostPlacement,
} from "../../../shared/types/remoteHosts.js";
import { isHostIdleMinutes, type HostIdleObservation } from "../../../shared/types/hostIdle.js";
import type { HostSettingLeaf } from "../../../shared/types/hostSettings.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { withHostIdleClaim, type HostIdleClaimOutcome } from "../client/claimHostIdle.js";
import { TransportError, UnusableConnectionError } from "../client/transport.js";
import type { LinkSession } from "../link/session.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import {
  CLOUD_BINDING_LABEL,
  cloudMachineClaim,
  madeInSendWindow,
  mayHaveMade,
  readCreatedFor,
  type CloudHostStore,
  type StoredCloudBinding,
  type StoredCloudObservation,
  type StoredCreateOrder,
  type StoredWorktreeCleanup,
} from "./CloudHostStore.js";
import { findOnPath } from "../../utils/findOnPath.js";
import { raceAbort } from "../../utils/raceAbort.js";
import type {
  CloudSshAccessRecord,
  CloudSshFiles,
  CloudSshResolvedTunnel,
  CloudSshRoute,
} from "./CloudSshFiles.js";
import {
  formatSshEndpoint,
  hostKeyFingerprint,
  hostKeyTypeLabel,
  isSafeSshUser,
  isValidSshEndpoint,
  keyscanTypeOf,
  normalizeHostKey,
  type SshEndpoint,
} from "./sshEndpoint.js";
import { sshDeclarationProblem } from "./sshTunnel.js";
import {
  canRenewLifetime,
  canSleepIdle,
  sshKeyContractProblem,
  type IdleSleepingCloudProvider,
  sshKeyTiming,
  type CloudProvider,
  type OfferCreate,
  type ProviderCreateRequest,
  type ProviderCredentials,
  type ProviderResource,
  type ProviderSshAccess,
} from "./provider.js";
import { lifetimeRenewalDue, stopUnderWay } from "./lifetimeRenewal.js";
import type { CloudGuestPowerOff } from "./CloudGuestPowerOff.js";
import type { CloudKeepAwakeLinks } from "./CloudKeepAwakeLinks.js";
import { awaitsRevoke, type CloudMachineKeys } from "./CloudMachineKeys.js";

/** How often a machine is asked about while Daintree changes it. */
const TRANSITION_POLL_MS = 3_000;
/** Background cadence by what was last seen: running machines often, stopped ones rarely. */
const RUNNING_POLL_MS = 30_000;
const STOPPED_POLL_MS = 5 * 60_000;
const UNKNOWN_POLL_MS = 60_000;
const START_DEADLINE_MS = 10 * 60_000;
const STOP_DEADLINE_MS = 15 * 60_000;
/** An observation this fresh is good enough to decide whether a dial can go ahead. */
const DIAL_OBSERVATION_MS = 15_000;
/** The same for a provider that sleeps idle machines, where a stale "running" can be a sleeper. */
const SLEEPER_DIAL_OBSERVATION_MS = 2_000;
/** SSH access is resolved again after this long, or after any start. */
const ACCESS_TTL_MS = 10 * 60_000;
const MAX_NAME_LENGTH = 64;
/** How often the keeper looks for a lifetime to renew. */
const KEEPER_INTERVAL_MS = 60_000;
/** After an idle stop whose answer was lost, how long a machine still read as running is followed. */
const LOST_STOP_SETTLE_MS = 60_000;
/** How often the offers on an order waiting for a choice are read again. */
const OFFER_POLL_MS = 10_000;
/**
 * How long a placement whose answer was lost must go unseen by every lookup
 * of one run before it counts as never placed. Counted from that run's first
 * empty lookup, so a clock corrected at startup can't cut it short.
 */
const PLACEMENT_SETTLE_MS = 10 * 60_000;
const IDLE_STOP_SNAPSHOTS_OFF =
  "This device doesn't stop the machine when the host's idle time ends: snapshots are off on it, so a stop would erase its disk.";
const IDLE_STOP_HOST_TOO_OLD =
  "The Daintree on this machine is too old for this device to stop it when the host's idle time ends. Update it to let it.";
/** The same for a machine this device puts to sleep instead (#17916). */
export const IDLE_SLEEP_HOST_TOO_OLD =
  "The Daintree on this machine is too old for this device to put it to sleep when the host's idle time ends. Update it to let it.";

/** The provider's own name, for messages: this layer never assumes which provider it is. */
function nameOf(provider: CloudProvider): string {
  return provider.info(process.platform).name;
}

/**
 * A start or stop refused because the machine's provider has neither, before
 * anything is sent. Its own class so a Bring back can tell it from a start
 * that was tried and failed: such a machine has no wake to fail.
 */
export class NoStopOrStartError extends AppError {}

function noStopOrStart(provider: CloudProvider): AppError {
  const message = `${nameOf(provider)} machines don't stop or start, so this one can only be deleted.`;
  return new NoStopOrStartError({ code: "UNSUPPORTED", message, userMessage: message });
}

/** Whether the provider declares that its machines end only by Delete (#18227). */
function deleteOnly(provider: CloudProvider): boolean {
  return provider.info(process.platform).stopMode === "delete-only";
}

/** A worktree's machine on a provider whose create waits for the person to choose an offer. */
function offersNotForWorktrees(provider: CloudProvider): AppError {
  const message = `${nameOf(provider)} machines are leased from an offer you choose, which New Worktree can't show.`;
  return new AppError({ code: "UNSUPPORTED", message, userMessage: message });
}

function sameError(a: CloudHostError | null, b: CloudHostError | null): boolean {
  return a === b || (!!a && !!b && a.at === b.at && a.code === b.code && a.message === b.message);
}

/** A provider's own words, ended as a sentence so more can follow them. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** A lost create's lookup saw machines with its label but couldn't tell which one it made. */
function unclearCreateMessage(provider: CloudProvider, afterRestart: boolean): string {
  const name = nameOf(provider);
  return `${afterRestart ? "Setup didn't finish: " : ""}Daintree can't tell whether a machine carrying this host's label in ${name} is the one it asked for, so it takes none and asks for no other. Check your ${name} account: Retry looks again, and once this host is removed, Add host can add the right one.`;
}

/**
 * A machine's host key may come to the person for confirmation: always, or
 * whenever the provider's API didn't vouch for the first one.
 */
function confirmsHostKeys(provider: CloudProvider): boolean {
  const trust = provider.info(process.platform).capabilities.sshTrust;
  return trust === "confirm-on-first-connect" || trust === "api-or-confirm";
}

/** A presented key nobody has confirmed, as the person reviews it. */
function hostKeyReviewOf(binding: StoredCloudBinding): CloudHostKeyReview | null {
  const offered = binding.offeredHostKey;
  if (!offered) return null;
  const trusted = binding.trustedHostKey;
  return {
    reason: trusted ? "changed" : "first-connect",
    fingerprint: hostKeyFingerprint(offered.key),
    keyType: hostKeyTypeLabel(offered.key),
    seenAt: offered.at,
    previousFingerprint: trusted ? hostKeyFingerprint(trusted.key) : null,
    previousTrustedAt: trusted?.at ?? null,
  };
}

function lifetimeModelOf(provider: CloudProvider): CloudLifetimeModel {
  return provider.info(process.platform).capabilities.lifetime;
}

/**
 * Why this device may stop a machine once its host's idle time ends: a plugin
 * provider's, none of whose machines can stop themselves (#17923); or one of
 * a provider whose machines stop themselves, standing in for a self-stop that
 * was refused in a way that leaves a stop through the provider's API (#17924).
 */
type IdleStopRole = "plugin" | "stand-in";

/** An idle time to ask a host for, on the link it ended on. */
interface IdleStopDue {
  hostId: HostId;
  session: LinkSession;
  interval: string;
  provider: CloudProvider;
  role: IdleStopRole;
}

/** The provider sleeps this machine on its own timer, as it reported it or declares it. */
function sleepsOnItsOwn(
  model: CloudLifetimeModel,
  idleSleep: { enabled: boolean } | null | undefined
): boolean {
  if (idleSleep) return idleSleep.enabled;
  return model.kind === "idle-sleep";
}

/**
 * What a start tells the provider about the machine's runtime limit: the one
 * kept here, where the provider takes one at start; nothing where it would
 * keep its own (a limit fixed at create, an idle sleep, or none at all).
 */
function startOptions(
  model: CloudLifetimeModel,
  lifetimeSeconds: number | null
): { lifetimeSeconds?: number | null } {
  const takesLimit =
    model.kind === "renewable" || (model.kind === "fixed-at-create" && model.canChangeWhileStopped);
  return takesLimit ? { lifetimeSeconds } : {};
}
/**
 * What a failed read records (see inspectInto), which the next good answer
 * makes obsolete. Codes a refused start or stop also uses (a start limit is
 * "rate-limited") stay until that operation succeeds.
 */
const INSPECTION_ERRORS: ReadonlySet<CloudHostErrorCode> = new Set(["not-found"]);
/** An idle time the provider refused for one of these reasons isn't sent again until it changes. */
const IDLE_TIME_REFUSALS: ReadonlySet<CloudHostErrorCode> = new Set([
  "credential-invalid",
  "permission",
  "billing",
]);
/** After a failed renewal, the next try waits this long. */
const RENEW_RETRY_MS = 2 * 60_000;

const LABEL_MARKER = "daintree";
/**
 * Failures that are the provider refusing the request: nothing was created.
 * From a create, `ssh-authorization` is a provider that couldn't take
 * Daintree's key ahead of the machine, so it never asked for one, and
 * `unsupported` is a request the provider rejected as invalid.
 */
const DEFINITE_REFUSALS = new Set<CloudHostError["code"]>([
  "credential-invalid",
  "permission",
  "billing",
  "rate-limited",
  "capacity",
  "ssh-authorization",
  "unsupported",
  "refused",
]);

export interface CloudHostLifecycleDeps {
  store: CloudHostStore;
  accounts: CloudAccountService;
  files: CloudSshFiles;
  clientDir: string;
  hosts: {
    add(
      name: string,
      connection: HostConnection,
      pendingPlacement?: PendingHostPlacement
    ): HostDescriptor;
    get(hostId: HostId): HostDescriptor | null;
    list(): HostDescriptor[];
    /** Removes the host from this device as Settings → Remove host does. */
    forget(hostId: HostId): Promise<void>;
    /** Lets go of the host's link without touching the machine. */
    disconnect(hostId: HostId): Promise<void>;
    onChange(listener: () => void): () => void;
  };
  /** The cloud picture changed outside the store (an operation's stage). */
  changed(): void;
  /**
   * What this device sees of a host's use right now: its link, whether its
   * agents are working or waiting there, and whether a window shows it. Only
   * Daintree's own observations; passive polling never counts as use.
   */
  activity?(hostId: HostId): { connected: boolean; busy: boolean; shown: boolean } | null;
  /**
   * The host's machine was seen running where the last look saw it otherwise,
   * or with a different reported stop time: it may have restarted, so what was
   * last found about starting Daintree there is worth checking again. Called
   * before the change reaches any view, ahead of the dials it prompts.
   */
  onMachineStarted?(hostId: HostId): void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Where a tunnel's command is on this device's PATH; null when it isn't there. */
  findCommand?: (command: string) => Promise<string | null>;
  /** The keys machines renew and stop themselves with (#17361); absent where nothing issues them. */
  machineKeys?: Pick<
    CloudMachineKeys,
    "problemFor" | "standsInFor" | "tick" | "revokePending" | "forgetRemoved"
  >;
  /** EC2 and Compute Engine machines powering themselves off once idle (#17362). */
  guestPowerOff?: Pick<
    CloudGuestPowerOff,
    "problemFor" | "standsInFor" | "arm" | "tick" | "forgetRemoved"
  >;
  /** The links Agent 37 instances' hosts hold them awake with while they see work (#17918). */
  keepAwake?: Pick<CloudKeepAwakeLinks, "statusFor" | "tick" | "forgetRemoved">;
  /**
   * What this device hears of a host's idle clock, for stopping a machine
   * once its idle time ends where the machine can't stop itself (#17923,
   * #17924); absent where nothing reads hosts' summaries.
   */
  idleClaims?: {
    /** The host's open link, or null while it has none. Never dials. */
    sessionFor(hostId: HostId): LinkSession | null;
    /** The host's idle clock from a summary that came lately on `session`, and when it was taken by the host's clock. */
    idleOn(
      hostId: HostId,
      session: LinkSession
    ): { idle: HostIdleObservation; sampledAt: number } | null;
    /**
     * Lets go of `session` once a sleep went out on its claim (#17916), unless
     * another link has replaced it: the connection's own traffic would keep a
     * sleeping machine's provider from counting it idle, or wake it.
     */
    release?(hostId: HostId, session: LinkSession): void;
    /** Brings back a link let go for a sleep that didn't happen. */
    reconnect?(hostId: HostId): void;
  };
  /**
   * Whether a worktree on this device is gone: true once its root reads as
   * missing, false while it is there, null when that couldn't be told (a hung
   * mount, a permission error). Only ever asked about a worktree on this device.
   */
  worktreeGone?(worktreePath: string): Promise<boolean | null>;
  /** A worktree on this device may have been removed: a hint only, checked with `worktreeGone`. */
  onWorktreeRemoved?(listener: (worktreeId: string) => void): () => void;
}

const PATH_LOOKUP_MS = 5_000;

/**
 * Where a tunnel's command is on PATH, or null when it isn't there. A lookup
 * that ran out of time (a hung mount on PATH) proves nothing, so it fails as
 * something to retry rather than as a command to install.
 */
async function findTunnelCommand(command: string): Promise<string | null> {
  let timedOut = false;
  const found = await findOnPath(command, {
    timeoutMs: PATH_LOOKUP_MS,
    onTimeout: () => {
      timedOut = true;
    },
  });
  if (found === null && timedOut) {
    throw new TransportError(
      `Looking for ${command} on this device took too long`,
      `Daintree couldn't finish looking for ${command} on this device's PATH.`
    );
  }
  return found;
}

/** A tunnel's command missing from this device, and what the person does about it before `then`. */
function tunnelMissingMessage(
  providerName: string,
  tunnel: CloudSshTunnelCommand,
  then: string
): string {
  return `${providerName} machines are reached through its ${tunnel.command} command, which isn't installed on this device or isn't on Daintree's PATH. Install it and sign in to it as ${tunnel.installUrl} describes, then ${then}.`;
}

/** A public key as ssh compares it: its algorithm and blob, never its comment. */
function keyIdentity(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** One way of reaching a machine: a new one closes the master the old one opened. */
function routeGeneration(access: CloudSshAccessRecord): string {
  return JSON.stringify([
    access.user,
    access.endpoint.host,
    access.endpoint.port,
    access.hostKey,
    access.tunnel?.commandPath ?? null,
    access.tunnel?.args ?? [],
  ]);
}

/**
 * The key to pin from what the provider returned, or why it can't be used.
 * A provider that vouches with its API returns a key, and one that vouches
 * through its tunnel returns none; anything else is a provider bug, never a
 * quiet change of what is trusted.
 */
function checkedAccess(
  resolved: ProviderSshAccess,
  trust: CloudSshTrust,
  providerName: string
): { hostKey: string | null } | { problem: string } {
  if (
    typeof resolved?.user !== "string" ||
    !isSafeSshUser(resolved.user) ||
    !isValidSshEndpoint(resolved.endpoint)
  ) {
    return { problem: `${providerName} didn't return a usable SSH address for the machine` };
  }
  if (trust === "provider-tunnel") {
    return resolved.hostKey === null
      ? { hostKey: null }
      : {
          problem: `${providerName} returned a host key to pin for a machine it vouches for through its tunnel`,
        };
  }
  // The person's confirmation supplies the key; the API's is never taken for it.
  if (trust === "confirm-on-first-connect") return { hostKey: null };
  // The API's key, when it names one, can only stand in for a first confirmation.
  if (trust === "api-or-confirm") {
    if (resolved.hostKey === null || resolved.hostKey === undefined) return { hostKey: null };
    const vouched = normalizeHostKey(resolved.hostKey);
    return vouched === null
      ? { problem: `${providerName} returned a host key Daintree can't read` }
      : { hostKey: vouched };
  }
  const hostKey = normalizeHostKey(resolved.hostKey);
  return hostKey === null
    ? { problem: `${providerName} didn't say which host key the machine has` }
    : { hostKey };
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

/** The binding's mark for a request that asks for its host's MCP server on first connection. */
function mcpServerOnConnectMark(
  value: unknown
): { mcpServerOnConnect: true } | Record<string, never> {
  if (value === undefined || value === false) return {};
  if (value !== true) throw invalid("Say whether to turn on the host's MCP server.");
  return { mcpServerOnConnect: true };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError({ code: "CANCELLED", message: "Cancelled" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError({ code: "CANCELLED", message: "Cancelled" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Checks what a create names against the catalog just read and the
 * provider's own word on what it takes. Nothing is filled in: a required
 * dimension left out is refused, and only an optional one may be left to the
 * provider. Returns the ids to send and, for the host's details, the words
 * they were chosen by; null words when the provider takes none of them.
 */
function checkProvisioning(
  provider: CloudProvider,
  catalog: CloudCatalog,
  raw: unknown
): { selection: CloudProvisioningSelection; picks: CloudHostProvisioning | null } {
  if (raw !== undefined && raw !== null && typeof raw !== "object") {
    throw invalid("Choose where the machine runs and what it boots.");
  }
  const requested = (raw ?? {}) as Record<string, unknown>;
  const name = nameOf(provider);
  const takes = provider.info(process.platform).capabilities.provisioning;
  const selection: CloudProvisioningSelection = { location: null, image: null, network: null };
  const picks: CloudHostProvisioning = { location: null, image: null, network: null };
  let named = false;
  for (const dimension of CLOUD_PROVISIONING_DIMENSIONS) {
    const value = requested[dimension];
    const options = catalog.provisioning[dimension];
    if (takes[dimension] === "none" || options === null) {
      if (value !== undefined && value !== null) {
        throw invalid(`${name} doesn't take a ${dimension} for a new machine.`);
      }
      continue;
    }
    named = true;
    const noun = cloudProvisioningNoun(options.label);
    if (value === undefined || value === null) {
      if (takes[dimension] === "required") {
        throw invalid(`Choose ${cloudProvisioningArticleNoun(options.label)}.`);
      }
      picks[dimension] = { label: options.label, id: null, value: `Chosen by ${name}` };
      continue;
    }
    const choice =
      typeof value === "string" ? options.choices.find((entry) => entry.id === value) : undefined;
    if (!choice)
      throw invalid(`${name} doesn't offer that ${noun} to this account. Choose another.`);
    if (!choice.available) {
      throw invalid(
        choice.reason
          ? `${choice.label} isn't available: ${choice.reason}`
          : `${choice.label} isn't available on this account.`
      );
    }
    if (!cloudChoiceFitsLocation(choice, selection.location)) {
      const where = catalog.provisioning.location;
      throw invalid(
        `${choice.label} isn't offered in ${where ? `that ${cloudProvisioningNoun(where.label)}` : "every location"}. Choose another.`
      );
    }
    selection[dimension] = choice.id;
    picks[dimension] = { label: options.label, id: choice.id, value: choice.label };
  }
  return { selection, picks: named ? picks : null };
}

const DIMENSION_WORDS = { location: "Location", image: "Image", network: "Network" } as const;

/** The ids a create sends, from what its binding keeps. */
function selectionOf(picks: CloudHostProvisioning | null): CloudProvisioningSelection {
  return {
    location: picks?.location?.id ?? null,
    image: picks?.image?.id ?? null,
    network: picks?.network?.id ?? null,
  };
}

function observationOf(resource: ProviderResource, at: number): StoredCloudObservation {
  return {
    machine: resource.machine,
    name: resource.name || null,
    rawState: resource.rawState,
    machineType: resource.machineType,
    vcpu: resource.vcpu,
    memoryGB: resource.memoryGB,
    autoStopAt: resource.autoStopAt,
    lifetimeSeconds: resource.lifetimeSeconds,
    stoppedAt: resource.stoppedAt,
    stop: resource.stop ? { status: resource.stop.status, error: resource.stop.error } : null,
    lastSnapshotAt: resource.lastSnapshotAt,
    dataExpired: resource.dataExpired,
    asleep: resource.machine === "stopped" && resource.asleep === true,
    idleSleep: resource.idleSleep
      ? { enabled: resource.idleSleep.enabled, idleSeconds: resource.idleSleep.idleSeconds }
      : null,
    snapshotsDisabled: resource.snapshotsDisabled === true,
    observedAt: at,
  };
}

/**
 * The lifetime this machine has: its provider's model, narrowed by what the
 * provider reported for this machine where it sleeps machines on idle. An
 * imported machine may have sleeping turned off, or another idle time.
 */
function machineLifetime(
  model: CloudLifetimeModel | null,
  observation: StoredCloudObservation | null
): CloudLifetimeModel | null {
  const reported = observation?.idleSleep;
  if (model?.kind !== "idle-sleep" || !reported) return model;
  if (!reported.enabled) return { kind: "none" };
  return { kind: "idle-sleep", idleSeconds: reported.idleSeconds ?? model.idleSeconds };
}

/** Whether the machine's own idle timeout follows its host's idle time: Daintree made it, or the person picked one. */
export function followsHostIdleTime(binding: StoredCloudBinding): boolean {
  return binding.ownership === "created-by-daintree" || binding.idleTimeChosen === true;
}

/** A mark given by main code, checked as strictly as one read back from disk. */
function checkedCreatedFor(raw: CloudHostCreatedFor): CloudHostCreatedFor {
  const local = raw && typeof raw === "object" && isLocalHostId(raw.hostId);
  const mark = readCreatedFor(local ? { ...raw, hostId: null } : raw);
  if (!mark) throw invalid("The worktree this machine is for is missing its project or path.");
  return mark;
}

/** A worktree as the renderer names it, checked before it is compared with any mark. */
function checkedWorktreeRef(raw: unknown): CloudWorktreeRef {
  const value = raw as Record<string, unknown> | null;
  const projectId = typeof value?.projectId === "string" ? value.projectId.trim() : "";
  const worktreeId = typeof value?.worktreeId === "string" ? value.worktreeId.trim() : "";
  // Missing is not "this device": only null or "local" says so.
  const rawHostId = value?.hostId;
  const hostId =
    rawHostId === null || (typeof rawHostId === "string" && isLocalHostId(rawHostId))
      ? null
      : typeof rawHostId === "string" && isValidRemoteHostId(rawHostId)
        ? rawHostId
        : undefined;
  if (!projectId || !worktreeId || hostId === undefined) {
    throw invalid("The worktree being deleted is missing its project or path.");
  }
  return { hostId, projectId, worktreeId };
}

/** The view's id for one worktree delete, or null when it named none. */
function checkedMutationId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
    throw invalid("The worktree delete this belongs to isn't named properly.");
  }
  return raw;
}

function sameWorktree(a: CloudWorktreeRef, b: CloudWorktreeRef): boolean {
  return a.hostId === b.hostId && a.projectId === b.projectId && a.worktreeId === b.worktreeId;
}

/** What a Bring back's wake asks of the start it runs (#18183). */
interface WakeRequest {
  hostId: HostId;
  /** The Bring back's own signal: once it aborts, the wake no longer wants the machine. */
  asked: AbortSignal;
  /** Hears the provider take the start. */
  sent(): void;
  /** A person's Start joined it: it starts the machine as that Start would. */
  joined: boolean;
}

/** Whether the provider's last word on the machine is that it is asleep. */
function readsAsleep(binding: StoredCloudBinding): boolean {
  return machineOf(binding) === "stopped" && binding.observation?.asleep === true;
}

function machineOf(binding: StoredCloudBinding): CloudMachineState {
  if (!binding.resourceId) return "not-created";
  return (binding.observation?.machine as CloudMachineState | undefined) ?? "unknown";
}

/**
 * What settling an order record came to: every order it held `closed` with
 * nothing leased; one `leased`, bound to its host or left in the account; a
 * lost placement found `open` again, waiting on a choice; or one still
 * `pending`, unseen but inside its settle window.
 */
type OrderSettlement =
  { kind: "closed" } | { kind: "leased"; bound: boolean } | { kind: "open" } | { kind: "pending" };

const ORDER_GONE = "That order isn't waiting on a choice any more. Check the host and try again.";

/** A provider's id for an order or offer, kept whatever its length; null for none. */
function opaqueId(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** An id a view sends back: one it read from a snapshot, so never an unbounded string. */
function checkedOpaqueId(raw: unknown, what: string): string {
  const id = opaqueId(raw);
  if (id === null || id.length > 4096) throw invalid(`Missing the ${what}.`);
  return id;
}

/** Lease refusals that leave nothing leased: the provider's own refusal, or an offer it no longer has. */
function leaseRefused(code: CloudHostErrorCode): boolean {
  return DEFINITE_REFUSALS.has(code) || code === "not-found";
}

/** Why an offer can't be leased as the person chose it; null when it can. */
function offerRefusal(offer: CloudCreateOffer | undefined, sawHourly: number): string | null {
  if (!offer) return "That offer isn't on the order now. Choose one from the list.";
  if (!offer.choosable) return `That offer can't be chosen: ${offer.reason}`;
  // The same offer id quoted again at another rate: never leased at a rate nobody saw.
  if (Math.abs(offer.hourlyDollars - sawHourly) > 1e-9) {
    return `That offer now quotes $${offer.hourlyDollars.toFixed(4)} an hour, not the rate you saw. Nothing was leased; check it and choose again.`;
  }
  return null;
}

interface RunningOperation extends CloudOperation {
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * The lifecycle of every cloud host's machine. Each machine has at most one
 * operation at a time (create, start, stop, delete), which every caller joins;
 * the operation's intent is written down before anything that costs money is
 * sent, so a lost answer or a restart is reconciled instead of repeated.
 *
 * Nothing here starts a machine unless a person asked: observing, listing,
 * a window restoring or a link redialling only ever reads. A dial to a
 * stopped machine fails with a reason and waits for Start.
 */
export class CloudHostLifecycle {
  private readonly operations = new Map<string, RunningOperation>();
  private readonly nextPollAt = new Map<string, number>();
  private readonly accessInFlight = new Map<string, Promise<CloudSshRoute>>();
  /** The route last written for each machine this run, so only a changed one retires its master. */
  private readonly writtenRoutes = new Map<string, string>();
  /**
   * The account key each machine Daintree created is known to hold, this run:
   * the one its create sent, or one put on it since. A machine holding another
   * key, or none known, has the key on disk put on it before it is reached.
   */
  private readonly heldKeys = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private keeperTimer: ReturnType<typeof setInterval> | null = null;
  /** When each machine's lifetime was last renewed or tried, this run. */
  private readonly renewals = new Map<string, { at: number; ok: boolean }>();
  private readonly renewInFlight = new Map<string, Promise<void>>();
  /** Creates sent before a restart whose provider wasn't registered to look for them yet. */
  private readonly awaitingProvider = new Set<string>();
  /** Creates being looked for right now, so two passes never ask about one at once. */
  private readonly reconciling = new Set<string>();
  /** Lookups a provider change overtook: a failure may be the old provider's, not the machine's. */
  private readonly reconcileOvertaken = new Set<string>();
  /** Removals under way per binding, from the first look until the host is forgotten or it fails. */
  private readonly removing = new Map<string, number>();
  /** Worktree cleanups carrying out now, which every caller joins. */
  private readonly cleanupRuns = new Map<string, Promise<CloudWorktreeCleanupOutcome | null>>();
  /** Keeps chosen in Settings, by binding and delete: that delete's replay never arms it again. */
  private readonly keptForDelete = new Set<string>();
  private stopWatchingWorktrees: (() => void) | null = null;
  private renewingAll = false;
  /** Operations admitted per binding this run, so an idle stop can tell one came and went while it asked. */
  private readonly admitted = new Map<string, number>();
  /** The idle time each machine's host was last asked about, on which link: asked once, whatever the answer. */
  private readonly idleAsked = new Map<string, { session: LinkSession; interval: string }>();
  /** The link on which a host answered that its Daintree can't grant an idle claim. */
  private readonly idleUnsupported = new Map<string, LinkSession>();
  /**
   * Some machine is bound to a host, so the keeper looks for an idle one to
   * stop; whether it may is its keepers' word, read as the pass goes.
   */
  private idleCandidates = false;
  /** Some order waits on a choice, or is still to settle: the timers' passes over orders read them. */
  private ordersChoosing = false;
  private ordersSettling = false;
  /** An idle stop being prepared or carried out, per binding. */
  private readonly idleAttempts = new Map<string, Promise<void>>();
  /** The stopping operation each idle stop runs as, so a person's Stop can tell it from their own. */
  private readonly idleStops = new Map<string, Promise<void>>();
  /**
   * Every request whose answer becomes an observation takes a ticket when it
   * is sent; an answer is written only if no request sent after it has been
   * written already. A poll or refresh that a start or stop overtook arrives
   * late, and its wall-clock arrival time says nothing about how old it is.
   */
  private lastTicket = 0;
  private readonly observedTicket = new Map<string, number>();
  private stopWatchingHosts: (() => void) | null = null;
  private stopWatchingStore: (() => void) | null = null;
  /** Machines being put to sleep by their host's idle time: no dial resolves access to them meanwhile (#17916). */
  private readonly idleSleeping = new Set<string>();
  /** A Bring back's start under way per binding (#18183), which may yet decide not to start. */
  private readonly wakeStarts = new Map<string, WakeRequest>();
  /** Idle times being sent to each machine's provider, so a later one never lands first. */
  private readonly idleTimeWrites = new Map<string, Promise<void>>();
  /**
   * Per machine: until when its host's summary sends no idle time to it,
   * whether the next send turns its idle sleep on (a pick that didn't land),
   * and a value the provider refused or kept another for, sent again only
   * once the host's idle time changes.
   */
  private readonly idleTimeHolds = new Map<
    string,
    { until: number; enable: boolean; stuckOn: number | null }
  >();
  /** The offers last read on each order waiting for a choice, this run, by its record. */
  private readonly offerReads = new Map<
    string,
    { orderId: string; offers: CloudCreateOffer[]; readAt: number }
  >();
  /** Offer reads under way, by order record, which a refresh joins. */
  private readonly offerReading = new Map<string, Promise<void>>();
  /** When each order record's offers are next read. */
  private readonly offersDueAt = new Map<string, number>();
  /** Each order record's latest offer read: only its answer is shown, so a slow one never undoes a newer. */
  private readonly offerReadSeq = new Map<string, number>();
  /** Order records being looked for or closed now, which every caller joins. */
  private readonly orderWork = new Map<string, Promise<OrderSettlement>>();
  /** When the keeper last tried each order record, so a failing close waits for its next pass. */
  private readonly orderTriedAt = new Map<string, number>();
  /** When this run first looked for a lost placement and found nothing. */
  private readonly placementUnseenSince = new Map<string, number>();
  /** The account key each placement sent, this run: the machine leased from it holds that key. */
  private readonly placedKeys = new Map<string, string>();
  private disposed = false;

  constructor(private readonly deps: CloudHostLifecycleDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.deps.sleep ?? defaultSleep)(ms, signal);
  }

  /** A provider registered or left: a create left unreconciled for want of its provider is looked for now. */
  providersChanged(): void {
    if (this.disposed) return;
    // Whether the keeper's idle pass has anything to look at depends on which providers are here.
    this.armTimers();
    for (const bindingId of this.reconciling) this.reconcileOvertaken.add(bindingId);
    this.resumeDueCleanups();
    // An order whose provider was away is settled now it may be back.
    this.settleOrdersDue(true);
    if (this.awaitingProvider.size === 0) return;
    void this.reconcileUnfinishedCreates(new Set(this.awaitingProvider));
  }

  /** Begins background observation and reconciles what a previous run left unfinished. */
  start(): void {
    this.stopWatchingStore = this.deps.store.onChange(() => this.armTimers());
    this.armTimers();
    this.stopWatchingHosts = this.deps.hosts.onChange(() => void this.dropOrphanBindings());
    void this.dropOrphanBindings();
    this.markInterruptedCreates();
    void this.reconcileUnfinishedCreates();
    this.reconcileOrders();
    this.stopWatchingWorktrees =
      this.deps.onWorktreeRemoved?.((worktreeId) => void this.worktreeRemoved(worktreeId)) ?? null;
    this.resumeDueCleanups();
    void this.reconcileWaitingCleanups();
  }

  /**
   * Each timer runs only while it has work: the poll while a machine is bound
   * to a host, the keeper too while a key is left to revoke. A device with no
   * cloud machine wakes for neither (#17795).
   */
  private armTimers(): void {
    if (this.disposed) return;
    const bindings = this.deps.store.bindings();
    const machines = bindings.some((binding) => Boolean(binding.resourceId && binding.hostId));
    const orders = this.deps.store.createOrders();
    // An order waiting on a choice has its offers read; any other is still to settle.
    const choosing = orders.some((order) => order.state === "open");
    const withMachine = new Set(bindings.filter((b) => b.resourceId).map((b) => b.id));
    const settling = orders.some(
      (order) => order.state !== "open" || withMachine.has(order.bindingId)
    );
    const keeper =
      machines ||
      settling ||
      (this.deps.machineKeys !== undefined && this.deps.store.machineKeys().some(awaitsRevoke));
    const polling = machines || choosing;
    this.ordersChoosing = choosing;
    this.ordersSettling = settling;
    if (polling && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pollDue();
        if (this.ordersChoosing) this.pollOffersDue();
      }, 5_000);
      this.pollTimer.unref?.();
    } else if (!polling && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.idleCandidates = machines;
    if (keeper && !this.keeperTimer) {
      this.keeperTimer = setInterval(() => {
        if (this.ordersSettling) this.settleOrdersDue();
        void this.renewDue();
        if (this.idleCandidates) void this.stopIdleDue();
        void this.deps.machineKeys?.tick();
        void this.deps.guestPowerOff?.tick();
        void this.deps.keepAwake?.tick();
      }, KEEPER_INTERVAL_MS);
      this.keeperTimer.unref?.();
    } else if (!keeper && this.keeperTimer) {
      clearInterval(this.keeperTimer);
      this.keeperTimer = null;
      // Its pass would have forgotten a removed machine's findings; none comes now.
      this.deps.guestPowerOff?.forgetRemoved(bindings);
      this.deps.machineKeys?.forgetRemoved(bindings);
      this.deps.keepAwake?.forgetRemoved(bindings);
    }
  }

  /**
   * A create Daintree quit before sending (while it read the key or made the
   * SSH key) left nothing to look for, and no error to offer Retry with.
   */
  private markInterruptedCreates(): void {
    const ordered = new Set(this.deps.store.createOrders().map((order) => order.bindingId));
    for (const binding of this.deps.store.bindings()) {
      if (binding.resourceId || !binding.hostId || binding.creation?.sentAt !== null) continue;
      // An order placed for it is settled or chosen from instead.
      if (ordered.has(binding.id)) continue;
      if (binding.lastError || this.operations.has(binding.id)) continue;
      this.recordError(binding.id, {
        code: "failed",
        message:
          binding.provisioning === "unreadable"
            ? "Setup stopped before a machine was asked for, and where it was meant to run can't be read back. Remove the host and create it again."
            : "Setup stopped before a machine was asked for. Retry to create it.",
        at: this.now(),
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatchingStore?.();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.keeperTimer) clearInterval(this.keeperTimer);
    this.pollTimer = null;
    this.keeperTimer = null;
    this.stopWatchingHosts?.();
    this.stopWatchingWorktrees?.();
    for (const operation of this.operations.values()) operation.controller.abort();
  }

  // --- Reading -------------------------------------------------------------

  statuses(): CloudHostStatus[] {
    const accounts = new Map(this.deps.store.accounts().map((account) => [account.id, account]));
    const lifetimes = new Map<string, CloudLifetimeModel | null>();
    const lifetimeFor = (providerId: string): CloudLifetimeModel | null => {
      if (!lifetimes.has(providerId)) {
        lifetimes.set(
          providerId,
          this.deps.accounts.providerUnavailable(providerId)
            ? null
            : lifetimeModelOf(this.deps.accounts.provider(providerId))
        );
      }
      return lifetimes.get(providerId)!;
    };
    const choices = this.offerChoices();
    return this.deps.store
      .bindings()
      .filter(
        (binding): binding is StoredCloudBinding & { hostId: HostId } => binding.hostId !== null
      )
      .map((binding) => {
        const account = accounts.get(binding.accountId);
        const observation = binding.observation;
        const operation = this.operations.get(binding.id);
        const machineType = observation?.machineType ?? binding.creation?.machineType ?? null;
        // A key the person trusted stays the machine's identity between the dials that pin it.
        // Access, once resolved, says what is pinned now: none, when the tunnel vouches.
        const pinnedKey = binding.access
          ? binding.access.hostKey
          : (binding.trustedHostKey?.key ?? null);
        return {
          hostId: binding.hostId,
          providerId: binding.providerId,
          providerUnavailable: this.deps.accounts.providerUnavailable(binding.providerId),
          pluginProvider: account?.pluginProvider ?? null,
          accountId: binding.accountId,
          accountName: account?.displayName ?? "Disconnected account",
          resourceId: binding.resourceId,
          machineName: observation?.name ?? binding.creation?.name ?? null,
          ownership: binding.ownership,
          createdFor: binding.createdFor,
          worktreeCleanup: binding.worktreeCleanup
            ? {
                choice: binding.worktreeCleanup.choice,
                phase:
                  binding.worktreeCleanup.phase === "due"
                    ? ("running" as const)
                    : binding.worktreeCleanup.phase,
                worktreeHostId: binding.worktreeCleanup.worktree.hostId,
                error: binding.worktreeCleanup.error,
              }
            : null,
          provisioning: binding.provisioning === "unreadable" ? null : binding.provisioning,
          machine: machineOf(binding),
          rawState: observation?.rawState ?? null,
          machineType,
          vcpu: observation?.vcpu ?? null,
          memoryGB: observation?.memoryGB ?? null,
          hourlyDollars: this.deps.accounts.cachedHourly(binding.accountId, machineType),
          lifetime: machineLifetime(lifetimeFor(binding.providerId), observation),
          autoStopAt: observation?.autoStopAt ?? null,
          lifetimeSeconds: binding.lifetimeSeconds,
          stoppedAt: observation?.stoppedAt ?? null,
          stop: observation?.stop
            ? {
                status:
                  observation.stop.status === "pending" ||
                  observation.stop.status === "failing" ||
                  observation.stop.status === "completed" ||
                  observation.stop.status === "superseded"
                    ? observation.stop.status
                    : "unknown",
                error: observation.stop.error,
              }
            : null,
          lastSnapshotAt: observation?.lastSnapshotAt ?? null,
          dataExpired: observation?.dataExpired ?? false,
          operation: operation
            ? {
                id: operation.id,
                kind: operation.kind,
                startedAt: operation.startedAt,
                stage: operation.stage,
              }
            : null,
          // Only on a host whose create waits on a choice, so every other snapshot reads as before.
          ...(choices.has(binding.id) ? { pendingCreate: choices.get(binding.id)! } : {}),
          lastError: binding.lastError,
          observedAt: observation?.observedAt ?? null,
          lastEndpoint: binding.access
            ? `${binding.access.user}@${formatSshEndpoint({ host: binding.access.host, port: binding.access.port })}`
            : null,
          hostKeyFingerprint: pinnedKey ? hostKeyFingerprint(pinnedKey) : null,
          hostKeyReview: hostKeyReviewOf(binding),
          keptRunningAt: this.renewals.get(binding.id)?.ok
            ? this.renewals.get(binding.id)!.at
            : null,
          selfStopProblem:
            this.deps.machineKeys?.problemFor(binding.id) ??
            this.deps.guestPowerOff?.problemFor(binding.id) ??
            null,
          linkedIdleStop: this.linkedIdleStopOf(binding),
          asleep: machineOf(binding) === "stopped" && observation?.asleep === true,
          idleTimeFollowsHost: followsHostIdleTime(binding),
          keepAwake: this.deps.keepAwake?.statusFor(binding.id) ?? null,
        };
      });
  }

  private requireBindingForHost(hostId: unknown): StoredCloudBinding & { hostId: HostId } {
    const binding = typeof hostId === "string" ? this.deps.store.bindingForHost(hostId) : null;
    if (!binding || binding.hostId === null) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No cloud machine for host ${String(hostId)}`,
        userMessage: "That host isn't a cloud host on this device.",
      });
    }
    return binding as StoredCloudBinding & { hostId: HostId };
  }

  private async context(
    binding: StoredCloudBinding,
    signal?: AbortSignal
  ): Promise<{ provider: CloudProvider; credentials: ProviderCredentials }> {
    const account = this.deps.accounts.requireAccount(binding.accountId);
    const provider = this.deps.accounts.requireSupported(account.providerId);
    const credentials = await this.deps.accounts.credentials(account, signal);
    return { provider, credentials };
  }

  // --- Creating and importing ---------------------------------------------

  /**
   * Adds a cloud host and creates its machine. The binding and the create's
   * idempotency key are saved before the request goes out; the host is in the
   * list at once (as "Creating"), and the machine comes up in the background.
   *
   * `createdFor` marks the machine as made for a worktree, in that first write
   * so the mark holds through the create and any restart. It is a parameter of
   * its own, never read off the request: Settings → Hosts sends the request
   * over IPC and must never mark a machine. `pendingPlacement` is the worktree
   * waiting to open on the new host, written with the host itself.
   */
  async create(
    request: CloudHostCreateRequest,
    createdFor: CloudHostCreatedFor | null = null,
    pendingPlacement?: PendingHostPlacement
  ): Promise<{ hostId: HostId }> {
    if (!request || typeof request !== "object") throw invalid("Missing machine details.");
    const mark = createdFor === null ? null : checkedCreatedFor(createdFor);
    const account = this.deps.accounts.requireAccount(request.accountId);
    const provider = this.deps.accounts.requireSupported(account.providerId);
    // A worktree's machine is asked for without Add cloud host, so nobody could choose its offer.
    if (mark !== null && provider.info(process.platform).createMode === "offers") {
      throw offersNotForWorktrees(provider);
    }
    const name = typeof request.name === "string" ? request.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) throw invalid("Give the host a name.");
    if (cloudLifetimeIsChosen(lifetimeModelOf(provider))) {
      if (!CLOUD_LIFETIME_CHOICES.includes(request.lifetimeHours)) {
        throw invalid("Choose how long the machine may run before it stops by itself.");
      }
    } else if (request.lifetimeHours !== null) {
      // Refused, never dropped: a lifetime sent here means the asker thought it would hold.
      throw invalid(`${nameOf(provider)} doesn't take a lifetime for its machines.`);
    }
    // Before anything is written or asked for: a machine this device can't reach would run,
    // and bill, while the person installs the provider's command (#18180).
    const tunnel = await this.tunnelProblem(provider, "create the machine");
    if (tunnel) {
      throw tunnel.missing
        ? invalid(tunnel.said)
        : new AppError({
            code: "INTERNAL",
            message: tunnel.said,
            userMessage: `${tunnel.said} No machine was asked for.`,
          });
    }
    // A size is checked against the account's current catalog, never assumed.
    const catalog = await this.deps.accounts.catalog(account.id, { refresh: true });
    // The lifetime was checked against this provider; one registered in its place meanwhile wasn't asked.
    if (!this.stillRegistered(account.providerId, provider)) {
      throw invalid(`${nameOf(provider)} changed while the machine was being set up. Try again.`);
    }
    const size = catalog.machineTypes.find((type) => type.id === request.machineType);
    if (!size) throw invalid("Choose a machine size.");
    if (!size.available) {
      throw invalid(
        size.reason
          ? `${size.label} isn't available: ${size.reason}`
          : `${size.label} isn't available on this account.`
      );
    }
    const { selection, picks } = checkProvisioning(provider, catalog, request.provisioning);
    // Only a new create: one stored before its size was tied to a location is sent as it was.
    const unfit = cloudMachineTypeLocationReason(
      size,
      catalog.provisioning.location,
      selection.location
    );
    if (unfit) throw invalid(`${size.label} isn't available: ${unfit}.`);
    // Only Settings' create offers it, as with the mark: a worktree's machine is made without asking.
    const mcpMark = mark === null ? mcpServerOnConnectMark(request.mcpServerOnConnect) : {};
    // Checked with nothing awaited before the binding is written: a removal or key replacement
    // that began first refuses the create, and one that begins after sees the host. One that
    // finished while the catalog was read took the account with it.
    this.deps.accounts.requireAccount(account.id);
    const fenced = this.deps.accounts.createRefusal(account.id);
    if (fenced) throw invalid(fenced);
    const bindingId = `cb_${crypto.randomBytes(6).toString("hex")}`;
    const binding: StoredCloudBinding = {
      id: bindingId,
      hostId: null,
      accountId: account.id,
      providerId: account.providerId,
      resourceId: null,
      ownership: "created-by-daintree",
      createdFor: mark,
      worktreeCleanup: null,
      provisioning: picks,
      creation: {
        operationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        sentAt: null,
        lastSentAt: null,
        name,
        machineType: size.id,
      },
      lifetimeSeconds: request.lifetimeHours === null ? null : request.lifetimeHours * 3600,
      intent: "run",
      observation: null,
      access: null,
      trustedHostKey: null,
      offeredHostKey: null,
      lastError: null,
      createdAt: this.now(),
      ...mcpMark,
    };
    this.deps.store.putBinding(binding);
    let descriptor: HostDescriptor;
    try {
      descriptor = this.deps.hosts.add(name, cloudConnection(bindingId), pendingPlacement);
    } catch (error) {
      this.deps.store.removeBinding(bindingId);
      throw error;
    }
    this.deps.store.updateBinding(bindingId, (current) => ({ ...current, hostId: descriptor.id }));
    // What was asked for, whatever the provider makes of it: a retry never moves it.
    if (picks) this.deps.accounts.rememberProvisioning(account.id, selection);
    void this.operate(bindingId, "creating", (signal) => this.runCreate(bindingId, signal)).catch(
      () => {}
    );
    return { hostId: descriptor.id };
  }

  /** Sends the create again with the same key: the provider answers with the machine it made, if it made one. */
  async retryCreate(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    if (binding.resourceId) return;
    if (!binding.creation) throw invalid("This host has no machine to create.");
    // A machine made now would be one the removal under way never looks for.
    if (this.removing.has(binding.id)) throw invalid("This host is being removed.");
    await this.operate(binding.id, "creating", (signal) => this.runCreate(binding.id, signal));
  }

  private async runCreate(bindingId: string, signal: AbortSignal): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.creation || !binding.hostId) return;
    const creation = binding.creation;
    let context: { provider: CloudProvider; credentials: ProviderCredentials };
    try {
      context = await this.context(binding, signal);
    } catch (error) {
      if (creation.sentAt !== null && !signal.aborted) this.recordFailedLookup(bindingId, error);
      throw error;
    }
    const { provider, credentials } = context;
    // An order this host placed is never left behind by a create of another kind.
    if (
      !provider.offerCreate &&
      this.deps.store.createOrders().some((o) => o.bindingId === bindingId)
    ) {
      const message = `${nameOf(provider)} no longer creates through offers, and this host still holds an order with it. Remove the host and add it again.`;
      this.recordError(bindingId, { code: "unsupported", message, at: this.now() });
      throw invalid(message);
    }
    // What an offer-based create already placed is chosen from or settled, never placed over.
    if (provider.offerCreate && (await this.resumeOrders(bindingId, provider, signal))) return;
    // A create already sent may have made the machine: look for it (a read) before asking again.
    if (creation.sentAt !== null) {
      this.stage(bindingId, `Looking for the machine ${nameOf(provider)} may already have made`);
      let found: ProviderResource | "unclear" | null;
      try {
        found = await this.findCreated(bindingId, provider, { ...credentials, signal });
      } catch (error) {
        // Recorded here too: a startup lookup that failed while this ran left that to it.
        if (!signal.aborted) this.recordFailedLookup(bindingId, error);
        throw error;
      }
      if (found && found !== "unclear") {
        const bound = this.bindCreated(bindingId, found);
        if (bound === "held") throw invalid(this.recordHeldElsewhere(bindingId, provider, found));
        if (bound === "bound") {
          await this.waitFor(
            bindingId,
            "running",
            START_DEADLINE_MS,
            signal,
            "Starting the machine"
          );
        }
        return;
      }
      // Machines that may be its own are there: a send could only add another, wherever a
      // provider's key isn't honoured. Without an idempotency key, only ever look again.
      if (found === "unclear" || provider.createReplay === "lookup-only") {
        const message =
          found === "unclear"
            ? unclearCreateMessage(provider, false)
            : `${nameOf(provider)} didn't confirm the machine, and it isn't in the account. Retry looks for it again; if it doesn't show up in your ${nameOf(provider)} account either, remove the host and add it again.`;
        this.recordError(bindingId, { code: "outcome-unknown", message, at: this.now() });
        throw invalid(message);
      }
    }
    // Only a send gets this far. A retry asks for nothing this device couldn't reach, as
    // create() did. What the lookup found is said only of the provider still registered: one
    // replaced while it looked is refused below, never named with its old command.
    const tunnel = await this.tunnelProblem(provider, "retry");
    if (tunnel && this.stillRegistered(binding.providerId, provider)) {
      const sentBefore = creation.sentAt !== null;
      const message = sentBefore
        ? `${tunnel.said} The create wasn't sent again; Retry looks for a machine from the earlier request first.`
        : tunnel.missing
          ? tunnel.said
          : `${tunnel.said} No machine was asked for; Retry looks again.`;
      this.recordError(bindingId, {
        code: sentBefore
          ? "outcome-unknown"
          : tunnel.missing
            ? "ssh-tunnel-command-missing"
            : "failed",
        message,
        at: this.now(),
      });
      throw tunnel.missing
        ? invalid(message)
        : new AppError({ code: "INTERNAL", message, userMessage: message });
    }
    // Asked only of the provider registered now, and only for what it still takes: a limit
    // asked for under a model it has since dropped is refused, never sent as none.
    const changed = !this.stillRegistered(binding.providerId, provider);
    if (
      changed ||
      (binding.lifetimeSeconds !== null && !cloudLifetimeIsChosen(lifetimeModelOf(provider)))
    ) {
      // An earlier send may still have made a machine: that stays "outcome unknown", so
      // removing the host goes the delete way, which looks for it first.
      const sent = creation.sentAt !== null;
      const reason = changed
        ? `${nameOf(provider)} changed while the machine was being asked for.`
        : `${nameOf(provider)} no longer takes a lifetime for its machines, so Daintree won't ask for one with it.`;
      const next = sent
        ? provider.info(process.platform).capabilities.deletion
          ? "An earlier request may still have made it; removing the host checks once and deletes any machine it finds."
          : `An earlier request may still have made it; check your ${nameOf(provider)} account for it.`
        : changed
          ? "Nothing was asked for; Retry asks again."
          : "Nothing was created; remove the host and add it again.";
      const message = `${reason} ${next}`;
      this.recordError(bindingId, {
        code: sent ? "outcome-unknown" : changed ? "failed" : "unsupported",
        message,
        at: this.now(),
      });
      throw invalid(message);
    }
    const provisioning = this.sendableProvisioning(binding, provider);
    // A provider that only takes the key at create gets this account's own key with every attempt.
    let publicKey: string | null = null;
    if (sshKeyTiming(provider) === "at-create") {
      try {
        publicKey = await this.deps.files.publicKey(binding.accountId);
      } catch (error) {
        const detail = formatErrorMessage(error, "ssh-keygen failed");
        this.recordUnsentCreate(bindingId, creation.sentAt !== null, {
          code: "ssh-authorization",
          reason: `This account's SSH key couldn't be made (${detail})`,
        });
        throw error;
      }
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
      this.requireSameProvider(binding, provider, creation.sentAt !== null, "the SSH key was made");
    }
    // Cancelled while the credentials or the key were read: nothing is marked as sent.
    if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    // A lifetime saved meanwhile (Settings takes one for a machine not yet made) goes with it.
    const latest = this.deps.store.binding(bindingId) ?? binding;
    const request: ProviderCreateRequest = {
      name: creation.name,
      machineType: creation.machineType,
      lifetimeSeconds: latest.lifetimeSeconds,
      provisioning,
      labels: {
        [LABEL_MARKER]: "1",
        [CLOUD_BINDING_LABEL]: bindingId,
      },
      idempotencyKey: creation.idempotencyKey,
      publicKey,
    };
    if (provider.offerCreate) {
      await this.placeOrder(latest, provider, provider.offerCreate, credentials, request, signal);
      return;
    }
    const sentBefore = creation.sentAt !== null;
    let send = () => provider.create(credentials, request);
    if (provider.prepareCreate) {
      this.stage(bindingId, `Getting ${nameOf(provider)} ready to make the machine`);
      // Stopped while readied (a removal, say, that may yet fail): the host says nothing was
      // asked for, so Retry is there if it survives.
      const stopped = () => {
        this.recordUnsentCreate(bindingId, sentBefore, {
          code: "failed",
          reason: "Setup was stopped while the machine was readied",
        });
        return new AppError({ code: "CANCELLED", message: "Cancelled" });
      };
      try {
        send = await provider.prepareCreate(credentials, request);
      } catch (error) {
        if (signal.aborted) throw stopped();
        this.recordUnpreparedCreate(bindingId, provider, sentBefore, error);
        throw error;
      }
      if (signal.aborted) throw stopped();
      this.requireSameProvider(binding, provider, sentBefore, "the machine was readied");
    }
    this.stage(bindingId, `Asking ${nameOf(provider)} for a machine`);
    // Written before the request: a lost answer is then found again, never sent blind.
    const sendingAt = this.now();
    const marked = this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      creation: current.creation
        ? {
            ...current.creation,
            sentAt: current.creation.sentAt ?? sendingAt,
            lastSentAt: sendingAt,
          }
        : null,
      lastError: null,
    }));
    if (!marked?.creation) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    let resource: ProviderResource;
    try {
      resource = await send();
    } catch (error) {
      const described = provider.describeError(error);
      // Only the provider's own refusal proves nothing was made; anything else (lost answer,
      // cancellation, an unreadable reply, a create still being minted) may have.
      const refused = !signal.aborted && DEFINITE_REFUSALS.has(described.code);
      // Turning down a retry says nothing of an earlier send, whose machine may still exist.
      const earlier = refused && creation.sentAt !== null;
      this.recordError(bindingId, {
        ...described,
        code: refused && !earlier ? described.code : "outcome-unknown",
        message: earlier
          ? `${described.message} An earlier request may still have made the machine: Retry and removal look for it first.`
          : refused
            ? described.message
            : provider.createReplay === "lookup-only"
              ? `${nameOf(provider)} didn't confirm the machine. Retry looks for it, and never asks for another.`
              : `${nameOf(provider)} didn't confirm the machine. Retry looks for it before creating another.`,
      });
      if (refused) {
        const sentAt = earlier ? creation.sentAt : null;
        const lastSentAt = earlier ? creation.lastSentAt : null;
        // Nothing was made: a retry needs a fresh key, or the provider replays this refusal.
        this.deps.store.updateBinding(bindingId, (current) => ({
          ...current,
          creation: current.creation
            ? { ...current.creation, idempotencyKey: crypto.randomUUID(), sentAt, lastSentAt }
            : null,
        }));
      }
      throw error;
    }
    // A same-key replay answers with the machine the key made, which may since be another host's.
    const bound = this.bindCreated(bindingId, resource);
    if (bound === "held") throw invalid(this.recordHeldElsewhere(bindingId, provider, resource));
    if (bound === "settled") {
      // The provider made it for this host, which has since settled on another: never dropped unsaid.
      const message = `${nameOf(provider)} answered with a machine (${resource.name || resource.resourceId}) after this host had settled on another, so Daintree left it alone. Check your ${nameOf(provider)} account for it.`;
      if (this.deps.store.binding(bindingId)) {
        this.recordError(bindingId, { code: "failed", message, at: this.now() });
      }
      throw invalid(message);
    }
    // The provider answered the create the key went with: the machine holds it.
    if (publicKey !== null) this.heldKeys.set(bindingId, keyIdentity(publicKey));
    await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
  }

  /**
   * What this create was asked to name, exactly as it was checked. Refused
   * when it can't be read back, or when the provider now needs a dimension it
   * never named: sending its defaults instead would make another machine
   * than the one asked for.
   */
  private sendableProvisioning(
    binding: StoredCloudBinding,
    provider: CloudProvider
  ): CloudProvisioningSelection {
    const refuse = (message: string): never => {
      this.recordError(binding.id, { code: "failed", message, at: this.now() });
      throw invalid(message);
    };
    if (binding.provisioning === "unreadable") {
      refuse(
        "Daintree can't read back where this machine was meant to run, so it won't guess. Remove the host and create it again."
      );
    }
    const picks = binding.provisioning === "unreadable" ? null : binding.provisioning;
    const takes = provider.info(process.platform).capabilities.provisioning;
    for (const dimension of CLOUD_PROVISIONING_DIMENSIONS) {
      if (takes[dimension] === "required" && !picks?.[dimension]?.id) {
        refuse(
          `${nameOf(provider)} needs ${cloudProvisioningArticleNoun(DIMENSION_WORDS[dimension])} for this machine that its create never named, so Daintree won't guess one. Remove the host and create it again.`
        );
      }
    }
    return selectionOf(picks);
  }

  /**
   * A create stopped before this attempt was sent. When an earlier attempt was
   * sent, that one may still have made the machine, so it stays a create whose
   * outcome is unknown.
   */
  private recordUnsentCreate(
    bindingId: string,
    sentBefore: boolean,
    { code, reason }: { code: CloudHostErrorCode; reason: string }
  ): void {
    this.recordError(bindingId, {
      code: sentBefore ? "outcome-unknown" : code,
      message: sentBefore
        ? `${reason}, so the create wasn't sent again. Retry looks for a machine from the earlier request first.`
        : `${reason}, so no machine was asked for. Retry to create it.`,
      at: this.now(),
    });
  }

  /** The provider leaving, or another registering in its place, while a create was readied: ask nobody. */
  private requireSameProvider(
    binding: StoredCloudBinding,
    provider: CloudProvider,
    sentBefore: boolean,
    meanwhile: string
  ): void {
    const registered = this.deps.accounts.providerUnavailable(binding.providerId)
      ? null
      : this.deps.accounts.provider(binding.providerId);
    if (registered === provider) return;
    const reason = `${nameOf(provider)} was ${registered ? "replaced" : "removed"} while ${meanwhile}`;
    this.recordUnsentCreate(binding.id, sentBefore, { code: "unsupported", reason });
    throw new AppError({ code: "UNSUPPORTED", message: reason, userMessage: reason });
  }

  /** Readying the create failed, so this attempt asked for nothing; an earlier one still may have. */
  private recordUnpreparedCreate(
    bindingId: string,
    provider: CloudProvider,
    sentBefore: boolean,
    error: unknown
  ): void {
    const described = provider.describeError(error);
    const said = asSentence(described.message);
    this.recordError(bindingId, {
      ...described,
      code: sentBefore ? "outcome-unknown" : described.code,
      message: sentBefore
        ? `${said} The machine wasn't asked for again, but an earlier request may still have made it: Retry and removal look for it first.`
        : `${said} No machine was asked for; Retry to create it.`,
    });
  }

  /**
   * The machine a create for this binding made, found by its label. A copy of a
   * machine (a fork) carries its labels too, and only its create time tells
   * them apart: so it is the one labelled machine made in the first send's
   * window. "unclear" when more than one was, one can't be dated, or one was
   * made after it while a later send could have made it (a replay's, or a copy
   * made then); null when none was, or it was deleted (a copy outliving it is
   * never promoted).
   */
  private async findCreated(
    bindingId: string,
    provider: CloudProvider,
    credentials: ProviderCredentials
  ): Promise<ProviderResource | "unclear" | null> {
    const binding = this.deps.store.binding(bindingId);
    const creation = binding?.creation;
    if (!binding || !creation || creation.sentAt === null) return null;
    // Where the create was sent: a provider whose machines live per location looks there only.
    const picks = binding.provisioning;
    const location = picks && picks !== "unreadable" ? (picks.location?.id ?? null) : null;
    const found = await provider.list(credentials, {
      label: `${CLOUD_BINDING_LABEL}=${bindingId}`,
      ...(location ? { location } : {}),
    });
    const inWindow = new Map<string, ProviderResource>();
    let unclear = false;
    for (const candidate of found) {
      if (candidate.labels[CLOUD_BINDING_LABEL] !== bindingId) continue;
      if (madeInSendWindow(creation.sentAt, candidate.createdAt)) {
        inWindow.set(candidate.resourceId, candidate);
      } else if (mayHaveMade(creation, candidate.createdAt)) {
        unclear = true;
      }
    }
    const [resource, ...others] = inWindow.values();
    if (unclear || others.length > 0) return "unclear";
    if (!resource || resource.machine === "deleted") return null;
    return resource;
  }

  /** The other binding of this provider that already holds the machine, if any. */
  private heldElsewhere(
    providerId: CloudProviderId,
    bindingId: string,
    resourceId: string
  ): StoredCloudBinding | null {
    const claim = cloudMachineClaim(
      this.deps.store.bindings(),
      providerId,
      { resourceId },
      bindingId
    );
    return claim && !claim.pending ? claim.binding : null;
  }

  /**
   * Binds what a create made, checked as it is written: a machine another
   * host holds is never this one's ("held"), and a create settled meanwhile
   * (by a Retry's own answer) is never overwritten by an older look ("settled").
   */
  private bindCreated(bindingId: string, resource: ProviderResource): "bound" | "held" | "settled" {
    const current = this.deps.store.binding(bindingId);
    if (current?.resourceId === resource.resourceId) return "bound";
    if (!current || current.resourceId || !current.creation) return "settled";
    if (this.heldElsewhere(current.providerId, bindingId, resource.resourceId)) return "held";
    this.deps.store.updateBinding(bindingId, (latest) => ({
      ...latest,
      resourceId: resource.resourceId,
      creation: null,
      observation: observationOf(resource, this.now()),
      lastError: null,
    }));
    return "bound";
  }

  /** Says the machine a create may have made is already another host's, and leaves it to that host. */
  private recordHeldElsewhere(
    bindingId: string,
    provider: CloudProvider,
    resource: ProviderResource
  ): string {
    const holder = this.heldElsewhere(provider.id, bindingId, resource.resourceId);
    const host = holder?.hostId ? this.deps.hosts.get(holder.hostId) : null;
    const where = host ? ` as ${host.name}` : "";
    const message = `The machine ${nameOf(provider)} has for this host is already in your host list${where}, so Daintree leaves it to that host.`;
    // Still unsettled: if that host lets the machine go, removing this one looks for it again.
    this.recordError(bindingId, { code: "outcome-unknown", message, at: this.now() });
    return message;
  }

  /**
   * After a restart, a create that was sent but never answered is looked for
   * by its label, which is a read. If it isn't found, the host shows that
   * setup didn't finish and offers Retry; nothing is created on its own.
   */
  private async reconcileUnfinishedCreates(only?: ReadonlySet<string>): Promise<void> {
    const again = new Set<string>();
    for (const binding of this.deps.store.bindings()) {
      if (only && !only.has(binding.id)) continue;
      if (binding.resourceId || !binding.creation?.sentAt || !binding.hostId) continue;
      if (this.operations.has(binding.id) || this.reconciling.has(binding.id)) continue;
      if (this.deps.accounts.providerUnavailable(binding.providerId)) {
        this.awaitingProvider.add(binding.id);
        continue;
      }
      this.awaitingProvider.delete(binding.id);
      this.reconciling.add(binding.id);
      const key = binding.creation.idempotencyKey;
      try {
        const { provider, credentials } = await this.context(binding);
        const resource = await this.findCreated(binding.id, provider, credentials);
        // A Retry, a delete or dispose while the provider was asked: its answer is about the past.
        const current = this.deps.store.binding(binding.id);
        if (
          this.disposed ||
          !current ||
          current.resourceId ||
          current.creation?.idempotencyKey !== key ||
          this.operations.has(binding.id)
        ) {
          continue;
        }
        if (resource === "unclear") {
          this.recordError(binding.id, {
            code: "outcome-unknown",
            message: unclearCreateMessage(provider, true),
            at: this.now(),
          });
        } else if (resource) {
          if (this.bindCreated(binding.id, resource) === "held") {
            this.recordHeldElsewhere(binding.id, provider, resource);
          }
        } else {
          this.recordError(binding.id, {
            code: "outcome-unknown",
            message:
              provider.createReplay === "lookup-only"
                ? `Setup didn't finish: ${nameOf(provider)} hasn't shown a machine for this host yet. Retry looks for it again; if it doesn't show up in your ${nameOf(provider)} account either, remove the host and add it again.`
                : `Setup didn't finish: ${nameOf(provider)} has no machine for this host yet. Retry to create it.`,
            at: this.now(),
          });
        }
      } catch (error) {
        // One that left while it was asked looks again when it's back, and one
        // that came back meanwhile is asked again now. Any other failure (offline
        // at login, say) leaves Retry, since nothing here looks again on its own.
        if (this.deps.accounts.providerUnavailable(binding.providerId)) {
          this.awaitingProvider.add(binding.id);
        } else if (this.reconcileOvertaken.has(binding.id)) {
          again.add(binding.id);
        } else if (this.lookupStillCurrent(binding.id, key, binding.lastError)) {
          this.recordFailedLookup(binding.id, error);
        }
      } finally {
        this.reconciling.delete(binding.id);
        this.reconcileOvertaken.delete(binding.id);
      }
    }
    if (again.size > 0 && !this.disposed) void this.reconcileUnfinishedCreates(again);
  }

  /**
   * Whether a restart's lookup still speaks for the create: nothing has said
   * more since it began (a Retry, a removal, a bind). An error from an
   * earlier run gives way to why this lookup failed.
   */
  private lookupStillCurrent(
    bindingId: string,
    key: string,
    errorBefore: CloudHostError | null
  ): boolean {
    const current = this.deps.store.binding(bindingId);
    return (
      !this.disposed &&
      !!current &&
      !current.resourceId &&
      current.creation?.idempotencyKey === key &&
      !this.operations.has(bindingId) &&
      sameError(current.lastError, errorBefore)
    );
  }

  /** A sent create that couldn't be looked for: the host says so and offers Retry, which looks again. */
  private recordFailedLookup(bindingId: string, error: unknown): void {
    const binding = this.deps.store.binding(bindingId);
    if (!binding) return;
    const provider = this.deps.accounts.providerUnavailable(binding.providerId)
      ? null
      : this.deps.accounts.provider(binding.providerId);
    const said = asSentence(
      error instanceof AppError
        ? (error.userMessage ?? error.message)
        : provider
          ? provider.describeError(error).message
          : formatErrorMessage(error, "The lookup failed")
    );
    this.recordError(bindingId, {
      code: "outcome-unknown",
      message: `Setup didn't finish, and Daintree couldn't look for the machine ${provider ? nameOf(provider) : "the provider"} may have made. ${said} ${
        provider?.createReplay === "lookup-only"
          ? "Retry looks for it again."
          : "Retry looks for it, and asks for it again if it isn't there."
      }`,
      at: this.now(),
    });
  }

  // --- Creating through offers (#18230) ----------------------------------

  /**
   * Whether a record names the account and provider its host does, and an
   * account of its provider: one that doesn't is kept and never acted on.
   */
  private orderConsistent(order: StoredCreateOrder): boolean {
    const account = this.deps.store.account(order.accountId);
    if (account && account.providerId !== order.providerId) return false;
    const binding = this.deps.store.binding(order.bindingId);
    return (
      !binding || (binding.accountId === order.accountId && binding.providerId === order.providerId)
    );
  }

  private actionableOrders(): StoredCreateOrder[] {
    return this.deps.store.createOrders().filter((order) => this.orderConsistent(order));
  }

  private ordersFor(bindingId: string): StoredCreateOrder[] {
    return this.actionableOrders().filter((order) => order.bindingId === bindingId);
  }

  private registeredProvider(providerId: CloudProviderId): CloudProvider | null {
    return this.deps.accounts.providerUnavailable(providerId)
      ? null
      : this.deps.accounts.provider(providerId);
  }

  /** Each host's create waiting on a choice, with its order's offers as last read. */
  private offerChoices(): Map<string, CloudCreateOfferChoice> {
    const choices = new Map<string, CloudCreateOfferChoice>();
    for (const order of this.actionableOrders()) {
      if (order.state !== "open") continue;
      const orderId = order.orderIds![0]!;
      const read = this.offerReads.get(order.id);
      const current = read?.orderId === orderId ? read : null;
      choices.set(order.bindingId, {
        kind: "awaiting-offer",
        order: { id: orderId },
        waitingSince: order.waitingSince ?? order.placedAt,
        offers: current?.offers ?? [],
        offersReadAt: current?.readAt ?? null,
      });
    }
    return choices;
  }

  /** Nothing may be leased from it any more; a lease that already landed is found by its close. */
  private markClosing(orderRecordId: string): void {
    this.deps.store.updateCreateOrder(orderRecordId, (order) =>
      order.state === "close" ? order : { ...order, state: "close", offerId: null }
    );
    this.offerReads.delete(orderRecordId);
  }

  private retireOrder(orderRecordId: string): void {
    this.deps.store.removeCreateOrder(orderRecordId);
    this.offerReads.delete(orderRecordId);
    this.offersDueAt.delete(orderRecordId);
    this.offerReadSeq.delete(orderRecordId);
    this.orderTriedAt.delete(orderRecordId);
    this.placementUnseenSince.delete(orderRecordId);
    this.placedKeys.delete(orderRecordId);
  }

  /**
   * Places the order a create on an offer-based provider asks for, leasing
   * nothing. Its record is written first, under a key of its own, so a lost
   * answer or a restart finds it again. Once placed, the operation ends: the
   * person's choice may be minutes away, and leasing it is its own operation.
   */
  private async placeOrder(
    binding: StoredCloudBinding,
    provider: CloudProvider,
    offers: OfferCreate,
    credentials: ProviderCredentials,
    request: ProviderCreateRequest,
    signal: AbortSignal
  ): Promise<void> {
    const record: StoredCreateOrder = {
      id: `co_${crypto.randomBytes(6).toString("hex")}`,
      bindingId: binding.id,
      accountId: binding.accountId,
      providerId: binding.providerId,
      labels: request.labels,
      idempotencyKey: crypto.randomUUID(),
      state: "placing",
      orderIds: null,
      placedAt: this.now(),
      waitingSince: null,
      offerId: null,
    };
    this.stage(binding.id, `Placing an order with ${nameOf(provider)}`);
    const current = this.deps.store.binding(binding.id);
    if (signal.aborted || !current) {
      throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    }
    // A lease bound while this was readied gave the host its machine: nothing more is placed.
    if (current.resourceId) return;
    const fenced = this.deps.accounts.createRefusal(binding.accountId);
    if (fenced) throw invalid(fenced);
    this.deps.store.putCreateOrder(record);
    if (request.publicKey !== null) this.placedKeys.set(record.id, keyIdentity(request.publicKey));
    let placedId: string | null;
    try {
      const placed: CloudCreateOrder = await offers.placeOrder(
        { ...credentials, signal },
        { ...request, idempotencyKey: record.idempotencyKey }
      );
      placedId = opaqueId(placed?.id);
    } catch (error) {
      const described = provider.describeError(error);
      if (!signal.aborted && DEFINITE_REFUSALS.has(described.code)) {
        // Turned down: no order was placed, so there is none to look for or close.
        this.retireOrder(record.id);
        this.recordError(binding.id, {
          ...described,
          message: `${asSentence(described.message)} No order was placed; Retry to try again.`,
        });
        throw error;
      }
      // Stopped by a removal, which closes whatever was placed.
      if (signal.aborted) throw error;
      if (await this.placementLost(record.id, binding.id, provider)) return;
      throw error;
    }
    // An answer that names no order Daintree can keep is no answer: it is looked for instead.
    if (placedId === null) {
      if (await this.placementLost(record.id, binding.id, provider)) return;
      const message = `${nameOf(provider)} answered the order without saying which it was.`;
      throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
    }
    const id = placedId;
    const opened = this.deps.store.updateCreateOrder(record.id, (current) =>
      current.state === "placing"
        ? { ...current, state: "open", orderIds: [id], waitingSince: this.now() }
        : { ...current, orderIds: current.orderIds ?? [id] }
    );
    if (opened?.state !== "open") {
      // Its host was removed while it was placed: the close takes it from here.
      void this.settleOrder(record.id).catch(() => {});
      throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    }
    this.clearSupersededError(binding.id);
    void this.readOffers(record.id).catch(() => {});
  }

  /**
   * A placement whose answer was lost may still have made the order: it is
   * looked for now, and the keeper looks again until it is found or can't
   * have been placed. True when it was found, waiting on a choice.
   */
  private async placementLost(
    orderRecordId: string,
    bindingId: string,
    provider: CloudProvider
  ): Promise<boolean> {
    const outcome = await this.settleOrder(orderRecordId).catch((): OrderSettlement => ({
      kind: "pending",
    }));
    if (outcome.kind === "open") return true;
    this.recordError(bindingId, {
      code: outcome.kind === "pending" ? "outcome-unknown" : "failed",
      message:
        outcome.kind === "pending"
          ? `${nameOf(provider)} didn't confirm the order. Daintree keeps looking for it and brings back the choice if it turns up; Retry places a new order.`
          : `${nameOf(provider)} didn't confirm the order and had placed more than one, so Daintree closed them. Retry places a new order.`,
      at: this.now(),
    });
    return false;
  }

  /**
   * Before a create places an order: one its host still holds is chosen from,
   * a lost placement is looked for, and a lease that may have landed is
   * settled by closing its order. True when that leaves the host a choice or
   * a machine, so nothing new is placed.
   */
  private async resumeOrders(
    bindingId: string,
    provider: CloudProvider,
    signal: AbortSignal
  ): Promise<boolean> {
    for (const order of this.ordersFor(bindingId)) {
      if (order.state === "open") {
        void this.readOffers(order.id).catch(() => {});
        return true;
      }
      if (order.state === "leasing") this.markClosing(order.id);
      let outcome: OrderSettlement;
      try {
        outcome = await this.settleOrder(order.id);
      } catch (error) {
        throw this.deps.accounts.asAppError(provider, error);
      }
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
      if (outcome.kind === "open") return true;
      if (outcome.kind === "leased" && outcome.bound) {
        await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
        return true;
      }
      // Unseen so far: the keeper keeps looking for it, to close it, while a new one is placed.
      if (outcome.kind === "pending") this.markClosing(order.id);
    }
    return this.deps.store.binding(bindingId)?.resourceId != null;
  }

  /**
   * Settles one order record: a lost placement is looked for by its labels
   * and key (one found waits on a choice again), and a record marked for
   * closing has each of its orders closed, binding a lease one of them
   * answers with to its host while that host is still here. Throws when the
   * provider couldn't be asked; the record stays for the keeper.
   */
  private settleOrder(orderRecordId: string): Promise<OrderSettlement> {
    const running = this.orderWork.get(orderRecordId);
    if (running) return running;
    const work = this.runSettleOrder(orderRecordId).finally(() => {
      if (this.orderWork.get(orderRecordId) === work) this.orderWork.delete(orderRecordId);
    });
    this.orderWork.set(orderRecordId, work);
    return work;
  }

  private async runSettleOrder(orderRecordId: string): Promise<OrderSettlement> {
    let order = this.deps.store.createOrder(orderRecordId);
    if (!order) return { kind: "closed" };
    if (order.state === "open") return { kind: "open" };
    // A lease under way is its operation's to settle.
    if (order.state === "leasing") return { kind: "pending" };
    const account = this.deps.store.account(order.accountId);
    if (!account) {
      // Its credentials left without it being closed (an edit outside Daintree): nothing here can ask.
      console.warn(
        `[CloudHostLifecycle] An order record outlived its cloud account; dropping it (${order.id}).`
      );
      this.retireOrder(order.id);
      return { kind: "closed" };
    }
    // Never another provider's credentials for it, nor a lease bound to another account's host.
    if (!this.orderConsistent(order)) {
      throw new Error("The order record names an account or host of another provider");
    }
    const provider = this.deps.accounts.requireSupported(order.providerId);
    const offers = provider.offerCreate;
    if (!offers) throw new Error(`${nameOf(provider)} no longer creates through offers`);
    const credentials = await this.deps.accounts.credentials(account);
    if (order.orderIds === null) {
      const answered = await offers.findOrders(credentials, {
        labels: order.labels,
        idempotencyKey: order.idempotencyKey,
      });
      const found = answered.flatMap((placed) => {
        const id = opaqueId(placed?.id);
        return id === null ? [] : [{ id }];
      });
      order = this.deps.store.createOrder(orderRecordId);
      if (!order) return { kind: "closed" };
      if (order.orderIds === null) {
        if (found.length === 0) {
          const since = this.placementUnseenSince.get(order.id) ?? this.now();
          this.placementUnseenSince.set(order.id, since);
          if (this.now() - since < PLACEMENT_SETTLE_MS) return { kind: "pending" };
          // Looked for all along and never there: the placement never reached the provider.
          this.retireOrder(order.id);
          return { kind: "closed" };
        }
        this.placementUnseenSince.delete(order.id);
        const ids = [...new Set(found.map((placed) => placed.id))];
        // One order for a host still waiting on it: the choice comes back.
        const reopened =
          order.state === "placing" && ids.length === 1
            ? this.deps.store.updateCreateOrder(order.id, (current) =>
                current.state === "placing" && current.orderIds === null
                  ? { ...current, state: "open", orderIds: ids, waitingSince: this.now() }
                  : current
              )
            : null;
        if (reopened?.state === "open") {
          this.clearSupersededError(order.bindingId);
          void this.readOffers(order.id).catch(() => {});
          return { kind: "open" };
        }
        // More than one, or nothing waits on it any more: every one found is closed.
        this.deps.store.updateCreateOrder(order.id, (current) => ({
          ...current,
          state: "close",
          orderIds: current.orderIds ?? ids,
          offerId: null,
        }));
        order = this.deps.store.createOrder(orderRecordId);
        if (!order) return { kind: "closed" };
      }
    }
    if (order.state !== "close") return { kind: "pending" };
    let leased = false;
    let bound = false;
    for (const orderId of order.orderIds ?? []) {
      if (this.disposed) throw new AppError({ code: "CANCELLED", message: "Stopping" });
      const outcome = await offers.closeOrder(credentials, orderId);
      // Bound before the order is struck off, so a crash between the two binds it again.
      if (outcome.kind === "leased") {
        leased = true;
        if (this.adoptLease(order, provider, outcome.resource)) bound = true;
      }
      this.deps.store.updateCreateOrder(order.id, (current) => ({
        ...current,
        orderIds: (current.orderIds ?? []).filter((id) => id !== orderId),
      }));
    }
    this.retireOrder(order.id);
    return leased ? { kind: "leased", bound } : { kind: "closed" };
  }

  /**
   * A lease the provider answered with, for the host that placed its order:
   * bound to it while the host is still here and holds no other machine.
   * Otherwise it stays in the provider account, as every machine of a host
   * removed from this device does. True when it is the host's machine now.
   */
  private adoptLease(
    order: StoredCreateOrder,
    provider: CloudProvider,
    resource: ProviderResource
  ): boolean {
    const binding = this.deps.store.binding(order.bindingId);
    // The host as it is now: one rewritten for another account meanwhile is never given it.
    const ours = binding?.accountId === order.accountId && binding.providerId === order.providerId;
    const bound = binding && ours ? this.bindCreated(binding.id, resource) : "settled";
    if (bound === "bound") {
      const key = this.placedKeys.get(order.id);
      if (key) this.heldKeys.set(order.bindingId, key);
      // The host has its machine: any other order it holds is closed, never chosen from.
      for (const other of this.ordersFor(order.bindingId)) {
        if (other.id === order.id || other.state === "close") continue;
        if (other.state === "leasing" && this.operations.has(order.bindingId)) continue;
        this.markClosing(other.id);
        void this.settleOrder(other.id).catch(() => {});
      }
      return true;
    }
    if (bound === "held") {
      this.recordHeldElsewhere(order.bindingId, provider, resource);
      return false;
    }
    console.warn(
      `[CloudHostLifecycle] A ${nameOf(provider)} order was leased after its host was settled or removed; the machine stays in the account (${resource.resourceId}).`
    );
    return false;
  }

  /** The host's create waits on a choice now: what was said about an earlier attempt is history. */
  private clearSupersededError(bindingId: string): void {
    this.deps.store.updateBinding(bindingId, (binding) =>
      binding.lastError && !binding.resourceId ? { ...binding, lastError: null } : binding
    );
  }

  /** Says on a host that its order couldn't be settled yet, once per reason; the keeper keeps trying. */
  private orderSettleFailed(
    order: StoredCreateOrder,
    error: unknown,
    provider: CloudProvider | null
  ): void {
    const binding = this.deps.store.binding(order.bindingId);
    if (!binding?.hostId || binding.resourceId || this.operations.has(binding.id)) return;
    // A choice waiting on the person speaks for the host.
    if (this.ordersFor(binding.id).some((other) => other.state === "open")) return;
    const said = asSentence(
      provider
        ? (this.deps.accounts.asAppError(provider, error).userMessage ??
            formatErrorMessage(error, "The provider couldn't be asked"))
        : formatErrorMessage(error, "The provider couldn't be asked")
    );
    const message = `Setup didn't finish: Daintree couldn't settle the order this host placed${provider ? ` with ${nameOf(provider)}` : ""} yet. ${said} It keeps trying.`;
    if (binding.lastError?.message === message) return;
    this.recordError(binding.id, { code: "outcome-unknown", message, at: this.now() });
  }

  /**
   * Says on a host what the background close of its order came to, unless
   * a newer order speaks for it or it has a machine now.
   */
  private orderSettled(
    order: StoredCreateOrder,
    outcome: OrderSettlement,
    provider: CloudProvider | null
  ): void {
    const binding = this.deps.store.binding(order.bindingId);
    if (!binding?.hostId || binding.resourceId || this.operations.has(binding.id)) return;
    const name = provider ? nameOf(provider) : "the provider";
    if (outcome.kind === "pending") {
      // A placement still unseen: the host says it is being looked for, once.
      if (order.state !== "placing" || binding.lastError) return;
      this.recordError(binding.id, {
        code: "outcome-unknown",
        message: `Setup didn't finish: ${name} hasn't confirmed the order this host placed. Daintree keeps looking for it and brings back the choice if it turns up; Retry places a new order.`,
        at: this.now(),
      });
      return;
    }
    if (outcome.kind !== "closed") return;
    // A newer order speaks for the host.
    if (this.ordersFor(binding.id).some((other) => other.state !== "close")) return;
    this.recordError(binding.id, {
      code: "failed",
      message: `Setup didn't finish: no order from this host is open with ${name}, and no machine was leased. Retry places a new order.`,
      at: this.now(),
    });
  }

  /**
   * Settles every order record not waiting on a choice: at startup, when a
   * provider returns, when a host is removed (`bindingId`), and on each keeper
   * pass for those whose last try failed. Nothing here places or leases.
   */
  private settleOrdersDue(now = false, bindingId?: string): void {
    if (this.disposed) return;
    const at = this.now();
    for (const order of this.actionableOrders()) {
      if (bindingId !== undefined && order.bindingId !== bindingId) continue;
      if (this.orderWork.has(order.id)) continue;
      if (order.state === "open") {
        // A host with its machine chooses nothing more: an order left open (a crash after the
        // bind, say) is closed.
        if (!this.deps.store.binding(order.bindingId)?.resourceId) continue;
        this.markClosing(order.id);
      }
      // A placement or lease still out is its operation's; a close is anyone's, joined if under way.
      if (
        order.state !== "close" &&
        this.operations.has(order.bindingId) &&
        this.deps.store.binding(order.bindingId)
      ) {
        continue;
      }
      if (this.deps.accounts.providerUnavailable(order.providerId)) continue;
      if (!now && at - (this.orderTriedAt.get(order.id) ?? 0) < KEEPER_INTERVAL_MS) continue;
      this.orderTriedAt.set(order.id, at);
      // A lease sent before a restart is settled by closing its order, never sent again.
      if (order.state === "leasing") this.markClosing(order.id);
      const provider = this.deps.accounts.provider(order.providerId);
      void this.settleOrder(order.id)
        .then((outcome) => this.orderSettled(order, outcome, provider))
        .catch((error: unknown) => this.orderSettleFailed(order, error, provider));
    }
  }

  /** After a restart: each choice comes back with its offers read again, and every other order is settled. */
  private reconcileOrders(): void {
    for (const order of this.actionableOrders()) {
      // A host gone without its orders marked (a record from an older write): they close.
      if (order.state !== "close" && !this.deps.store.binding(order.bindingId)) {
        this.markClosing(order.id);
      } else if (order.state === "open") {
        void this.readOffers(order.id).catch(() => {});
      }
    }
    this.settleOrdersDue(true);
  }

  /** Reads the offers on an order waiting for a choice; a read under way is joined. */
  private readOffers(orderRecordId: string): Promise<void> {
    const running = this.offerReading.get(orderRecordId);
    if (running) return running;
    const read = this.runReadOffers(orderRecordId).finally(() => {
      if (this.offerReading.get(orderRecordId) === read) this.offerReading.delete(orderRecordId);
      if (this.deps.store.createOrder(orderRecordId)?.state === "open") {
        this.offersDueAt.set(orderRecordId, this.now() + OFFER_POLL_MS);
      }
    });
    this.offerReading.set(orderRecordId, read);
    return read;
  }

  private async runReadOffers(orderRecordId: string): Promise<void> {
    const order = this.deps.store.createOrder(orderRecordId);
    const binding = order ? this.deps.store.binding(order.bindingId) : null;
    if (!order || order.state !== "open" || !binding || this.disposed) return;
    const orderId = order.orderIds![0]!;
    const { provider, credentials } = await this.context(binding);
    const offers = provider.offerCreate;
    if (!offers) return;
    const seq = this.beginOfferRead(orderRecordId);
    const stillOpen = () => {
      const current = this.deps.store.createOrder(orderRecordId);
      return !this.disposed && current?.state === "open" && current.orderIds?.[0] === orderId;
    };
    let read: CloudCreateOffer[];
    try {
      read = await offers.listOffers(credentials, orderId);
    } catch (error) {
      // An order the provider no longer has ended without a choice here: its close says how.
      if (
        stillOpen() &&
        this.offerReadSeq.get(orderRecordId) === seq &&
        provider.describeError(error).code === "not-found"
      ) {
        this.markClosing(orderRecordId);
        void this.settleOrder(orderRecordId)
          .then((outcome) => this.orderSettled(order, outcome, provider))
          .catch(() => {});
      }
      throw error;
    }
    this.publishOffers(orderRecordId, orderId, read, seq);
  }

  private beginOfferRead(orderRecordId: string): number {
    const seq = (this.offerReadSeq.get(orderRecordId) ?? 0) + 1;
    this.offerReadSeq.set(orderRecordId, seq);
    return seq;
  }

  /**
   * Shows what a read of the order's offers found, unless the order was
   * chosen, cancelled or closed while it read, or a newer read began.
   */
  private publishOffers(
    orderRecordId: string,
    orderId: string,
    offers: CloudCreateOffer[],
    seq: number
  ): void {
    const current = this.deps.store.createOrder(orderRecordId);
    if (this.disposed || current?.state !== "open" || current.orderIds?.[0] !== orderId) return;
    if (this.offerReadSeq.get(orderRecordId) !== seq) return;
    this.offerReads.set(orderRecordId, { orderId, offers, readAt: this.now() });
    this.deps.changed();
  }

  /** The poll's pass over orders waiting on a choice: each one's offers, read again when due. */
  private pollOffersDue(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const order of this.actionableOrders()) {
      if (order.state !== "open" || this.offerReading.has(order.id)) continue;
      if (now < (this.offersDueAt.get(order.id) ?? 0)) continue;
      if (this.deps.accounts.providerUnavailable(order.providerId)) continue;
      void this.readOffers(order.id).catch(() => {});
    }
  }

  /** The record of the order a host's create waits on, as the asking view named it. */
  private requireOpenOrder(
    binding: StoredCloudBinding,
    orderId: string
  ): StoredCreateOrder & { orderIds: [string] } {
    const order = this.ordersFor(binding.id).find(
      (candidate) => candidate.state === "open" && candidate.orderIds?.[0] === orderId
    );
    if (!order) throw invalid(ORDER_GONE);
    return order as StoredCreateOrder & { orderIds: [string] };
  }

  /** Reads the offers on the order a host's create waits on again now. */
  async refreshOffers(hostId: unknown, orderId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    const order = this.requireOpenOrder(binding, checkedOpaqueId(orderId, "order"));
    try {
      await this.readOffers(order.id);
    } catch (error) {
      const provider = this.registeredProvider(order.providerId);
      throw provider ? this.deps.accounts.asAppError(provider, error) : error;
    }
  }

  /**
   * Leases the offer the person chose, the only path that leases a machine
   * through offers. Resolves once the provider answers with the machine and
   * it is bound to the host; the create then carries on as any other (wait
   * for it to run, then setup). An offer the provider turns down leaves the
   * order open for another choice. `hourlyDollars` is the rate the person
   * saw: a bidder can quote again under the same offer id, and a lease is
   * never sent at a rate nobody saw.
   */
  async chooseOffer(
    hostId: unknown,
    orderId: unknown,
    offerId: unknown,
    hourlyDollars: unknown
  ): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    const order = this.requireOpenOrder(binding, checkedOpaqueId(orderId, "order"));
    const offer = checkedOpaqueId(offerId, "offer");
    if (typeof hourlyDollars !== "number" || !Number.isFinite(hourlyDollars) || hourlyDollars < 0) {
      throw invalid("Missing the rate of the offer you chose.");
    }
    if (this.removing.has(binding.id)) throw invalid("This host is being removed.");
    if (binding.resourceId) throw invalid("This host has its machine already.");
    // Never joined: a second choice while one is leased would be a second lease asked for.
    if (this.operations.has(binding.id)) {
      throw invalid("An offer is being leased for this host already. Wait for it to finish.");
    }
    const read = this.offerReads.get(order.id);
    const known = read?.orderId === order.orderIds[0] ? read.offers : [];
    const refusal = offerRefusal(
      known.find((candidate) => candidate.id === offer),
      hourlyDollars
    );
    if (refusal) throw invalid(refusal);
    let accepted!: () => void;
    const leased = new Promise<void>((resolve) => (accepted = resolve));
    const work = this.operate(binding.id, "creating", (signal) =>
      this.runLease(
        binding.id,
        order.id,
        order.orderIds[0],
        { id: offer, hourlyDollars },
        signal,
        accepted
      )
    );
    work.catch(() => {});
    await Promise.race([leased, work]);
  }

  private async runLease(
    bindingId: string,
    orderRecordId: string,
    orderId: string,
    chosen: { id: string; hourlyDollars: number },
    signal: AbortSignal,
    accepted: () => void
  ): Promise<void> {
    const offerId = chosen.id;
    const binding = this.deps.store.binding(bindingId);
    if (!binding) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    const { provider, credentials } = await this.context(binding, signal);
    if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    const offers = provider.offerCreate;
    if (!offers || !this.stillRegistered(binding.providerId, provider)) {
      throw invalid(`${nameOf(provider)} changed while the offer was being leased. Try again.`);
    }
    // Read again just before the lease: the offer the person saw may have gone or been
    // quoted again since the last read. Nothing is leased then, and the order stays open.
    this.stage(bindingId, `Checking the offer you chose with ${nameOf(provider)}`);
    const seq = this.beginOfferRead(orderRecordId);
    let current: CloudCreateOffer[];
    try {
      current = await offers.listOffers({ ...credentials, signal }, orderId);
    } catch (error) {
      if (signal.aborted) throw error;
      throw this.deps.accounts.asAppError(provider, error);
    }
    if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    this.publishOffers(orderRecordId, orderId, current, seq);
    const refusal = offerRefusal(
      current.find((candidate) => candidate.id === offerId),
      chosen.hourlyDollars
    );
    if (refusal) throw invalid(refusal);
    // Written before the lease, the request that costs money: a lost answer is settled by
    // closing the order, never by leasing again.
    const marked = this.deps.store.updateCreateOrder(orderRecordId, (order) =>
      order.state === "open" && order.orderIds?.[0] === orderId
        ? { ...order, state: "leasing", offerId }
        : order
    );
    if (marked?.state !== "leasing" || marked.offerId !== offerId) throw invalid(ORDER_GONE);
    this.stage(bindingId, `Leasing the offer you chose from ${nameOf(provider)}`);
    let resource: ProviderResource;
    try {
      resource = await offers.leaseOffer({ ...credentials, signal }, orderId, offerId, {
        hourlyDollars: chosen.hourlyDollars,
      });
    } catch (error) {
      const described = provider.describeError(error);
      if (!signal.aborted && leaseRefused(described.code)) {
        // Nothing was leased: the order stays open for another choice, unless the host got its
        // machine meanwhile, when it is closed.
        const hasMachine = !!this.deps.store.binding(bindingId)?.resourceId;
        const reopened = this.deps.store.updateCreateOrder(orderRecordId, (order) =>
          order.state === "leasing" && order.offerId === offerId
            ? hasMachine
              ? { ...order, state: "close", offerId: null }
              : { ...order, state: "open", offerId: null }
            : order
        );
        if (reopened?.state === "close") void this.settleOrder(orderRecordId).catch(() => {});
        const read = this.offerReads.get(orderRecordId);
        if (read) {
          this.offerReads.set(orderRecordId, {
            ...read,
            offers: read.offers.filter((candidate) => candidate.id !== offerId),
          });
        }
        if (reopened?.state === "open") void this.readOffers(orderRecordId).catch(() => {});
        // Another offer can help only when this one was the problem, not the account.
        const offerAtFault =
          described.code === "refused" ||
          described.code === "not-found" ||
          described.code === "capacity";
        const message =
          reopened?.state === "close"
            ? `${asSentence(described.message)} Nothing was leased, and this host has its machine already.`
            : `${asSentence(described.message)} Nothing was leased, and the order is still open${offerAtFault ? ": choose another offer." : "."}`;
        throw new AppError({ code: "VALIDATION", message, userMessage: message });
      }
      // Stopped by a cancel or removal, which closes the order and keeps a lease that landed.
      if (signal.aborted) throw error;
      // The answer was lost, so the lease may have landed: only closing the order says.
      this.markClosing(orderRecordId);
      let outcome: OrderSettlement;
      try {
        outcome = await this.settleOrder(orderRecordId);
      } catch (closeError) {
        const said = asSentence(
          this.deps.accounts.asAppError(provider, closeError).userMessage ??
            formatErrorMessage(closeError, "No answer")
        );
        const message = `${nameOf(provider)} didn't confirm the lease, and the order couldn't be closed yet. ${said} Daintree keeps trying, and the machine is this host's if the lease went through.`;
        this.recordError(bindingId, { code: "outcome-unknown", message, at: this.now() });
        throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
      }
      if (outcome.kind === "leased" && outcome.bound) {
        accepted();
        await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
        return;
      }
      if (outcome.kind === "closed") {
        const message = `${nameOf(provider)} didn't confirm the lease, so Daintree closed the order and no machine was leased. Retry places a new order.`;
        this.recordError(bindingId, { code: "failed", message, at: this.now() });
        throw invalid(message);
      }
      throw this.deps.accounts.asAppError(provider, error);
    }
    // Leased: the order is done, whatever becomes of the machine.
    const bound = this.adoptLease(marked, provider, resource);
    this.retireOrder(orderRecordId);
    if (!bound) {
      const message = this.deps.store.binding(bindingId)?.lastError?.message ?? ORDER_GONE;
      throw invalid(message);
    }
    accepted();
    await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
  }

  /**
   * Withdraws the create waiting on this order: nothing more is leased from
   * it, and it is closed. The host stays, offering Retry. A lease that won
   * the race is kept as the host's machine, and the create carries on.
   */
  async cancelOrder(hostId: unknown, orderId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    const id = checkedOpaqueId(orderId, "order");
    const order = this.ordersFor(binding.id).find((candidate) => candidate.orderIds?.includes(id));
    if (!order) throw invalid(ORDER_GONE);
    // Written before anything is stopped: a lease that lands meanwhile is found by the close.
    this.markClosing(order.id);
    // Only this order's lease gives way; one already closing has none, and the host may be
    // placing a newer one. The close goes out at once, whatever the lease's request does with
    // the abort: whichever reaches the provider first decides, and the close says which.
    const running = order.state === "leasing" ? this.operations.get(binding.id) : undefined;
    if (running?.kind === "creating") running.controller.abort();
    let outcome: OrderSettlement;
    try {
      outcome = await this.settleOrder(order.id);
    } catch (error) {
      const provider = this.registeredProvider(order.providerId);
      const said = asSentence(
        (provider ? this.deps.accounts.asAppError(provider, error).userMessage : undefined) ??
          formatErrorMessage(error, "No answer")
      );
      const message = `The order couldn't be closed yet. ${said} Daintree keeps trying, and a machine a lease made is this host's.`;
      this.recordError(binding.id, { code: "outcome-unknown", message, at: this.now() });
      throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
    }
    if (outcome.kind === "leased" && outcome.bound) {
      // The lease won: the create carries on once the aborted lease's operation has let go.
      void (async () => {
        await running?.promise.catch(() => {});
        await this.operate(binding.id, "creating", (signal) =>
          this.waitFor(binding.id, "running", START_DEADLINE_MS, signal, "Starting the machine")
        );
      })().catch(() => {});
      return;
    }
    if (this.deps.store.binding(binding.id)?.resourceId) return;
    this.recordError(binding.id, {
      code: "failed",
      message: "The create was cancelled, and no machine was leased. Retry places a new order.",
      at: this.now(),
    });
  }

  /**
   * Before an account's credentials leave this device: closes every order
   * its creates placed, and refuses while one may still be open, since
   * nothing here could close it afterwards.
   */
  async settleAccountOrders(accountId: string): Promise<void> {
    const orders = this.deps.store.createOrders().filter((order) => order.accountId === accountId);
    for (const order of orders) {
      if (order.state !== "close" && !this.operations.has(order.bindingId)) {
        this.markClosing(order.id);
      }
      await this.settleOrder(order.id).catch(() => {});
    }
    if (this.deps.store.unreadableOrdersFor(accountId) > 0) {
      const message =
        "This device holds an order this account placed that this version of Daintree can't read, so it can't close it. Remove the account in the version of Daintree that placed it.";
      throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
    }
    const left = this.deps.store.createOrders().filter((order) => order.accountId === accountId);
    if (left.length === 0) return;
    const message = `Daintree couldn't yet close ${left.length === 1 ? "an order" : `${left.length} orders`} this account placed for new machines. Try again once the provider can be reached.`;
    throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
  }

  /** Adds an existing machine as a host. Importing never starts it, and never changes its lifetime. */
  async importMachine(request: CloudHostImportRequest): Promise<{ hostId: HostId }> {
    if (!request || typeof request !== "object") throw invalid("Missing machine details.");
    const account = this.deps.accounts.requireAccount(request.accountId);
    this.deps.accounts.requireSupported(account.providerId);
    const name = typeof request.name === "string" ? request.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) throw invalid("Give the host a name.");
    if (typeof request.resourceId !== "string") throw invalid("Choose a machine.");
    const mcpMark = mcpServerOnConnectMark(request.mcpServerOnConnect);
    const bound = this.deps.store
      .bindings()
      .find(
        (binding) =>
          binding.providerId === account.providerId && binding.resourceId === request.resourceId
      );
    if (bound?.hostId) {
      const host = this.deps.hosts.get(bound.hostId);
      throw invalid(`That machine is already in your host list${host ? ` as ${host.name}` : ""}.`);
    }
    const binding: StoredCloudBinding = {
      id: `cb_${crypto.randomBytes(6).toString("hex")}`,
      hostId: null,
      accountId: account.id,
      providerId: account.providerId,
      resourceId: null,
      ownership: "imported",
      createdFor: null,
      worktreeCleanup: null,
      provisioning: null,
      creation: null,
      lifetimeSeconds: null,
      intent: null,
      observation: null,
      access: null,
      trustedHostKey: null,
      offeredHostKey: null,
      lastError: null,
      createdAt: this.now(),
      ...mcpMark,
    };
    const { provider, credentials } = await this.context(binding);
    let resource: ProviderResource;
    try {
      resource = await provider.inspect(credentials, request.resourceId);
    } catch (error) {
      throw this.deps.accounts.asAppError(provider, error);
    }
    if (resource.restricted) {
      throw invalid(
        "That machine belongs to a teammate and isn't shared with you, so Daintree can't reach it."
      );
    }
    if (resource.dataExpired)
      throw invalid("That machine's saved disk was deleted; it can't be started again.");
    if (resource.machine === "deleted") throw invalid("That machine was deleted.");
    if (resource.snapshotsDisabled) {
      throw invalid(
        "That machine was created with snapshots off, so stopping it erases its disk. Daintree only adds machines whose disk survives a stop."
      );
    }
    // Its own lifetime stays as it is; a start renews to it, where the provider takes one then.
    binding.resourceId = resource.resourceId;
    binding.lifetimeSeconds = resource.lifetimeSeconds;
    binding.observation = observationOf(resource, this.now());
    // Another import, or a lost create's recovery, may have taken it while it was inspected;
    // and a create still unsettled may have made it, as its label says.
    const claim = cloudMachineClaim(this.deps.store.bindings(), account.providerId, resource);
    if (claim) {
      const host = claim.binding.hostId ? this.deps.hosts.get(claim.binding.hostId) : null;
      if (!claim.pending) {
        throw invalid(
          `That machine is already in your host list${host ? ` as ${host.name}` : ""}.`
        );
      }
      throw invalid(
        `${host?.name ?? "Another host"} is still being set up and may have made that machine, so it can't be added as a second host. Retry or remove ${host?.name ?? "that host"} first.`
      );
    }
    this.deps.store.putBinding(binding);
    let descriptor: HostDescriptor;
    try {
      descriptor = this.deps.hosts.add(name, cloudConnection(binding.id));
    } catch (error) {
      this.deps.store.removeBinding(binding.id);
      throw error;
    }
    this.deps.store.updateBinding(binding.id, (current) => ({ ...current, hostId: descriptor.id }));
    return { hostId: descriptor.id };
  }

  // --- Starting and stopping ----------------------------------------------

  /** A person's Start: resumes a stopped machine and waits until it runs. Joins one under way. */
  async startMachine(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    // Refused while its provider isn't registered, before the intent changes.
    this.deps.accounts.provider(binding.providerId);
    if (!binding.resourceId) {
      if (binding.creation) return this.retryCreate(hostId);
      throw invalid("This host has no machine yet.");
    }
    this.requireStopAndStart(binding.providerId);
    // A Bring back's wake under way becomes this Start: it joins it, and it starts the machine
    // as a Start would, whatever the wake would have decided. One a Stop or removal already
    // ended is waited out instead, so this Start comes after that, not into it.
    const waking = this.wakeStarts.get(binding.id);
    const running = this.operations.get(binding.id);
    if (waking && running?.kind === "starting" && running.controller.signal.aborted) {
      await running.promise.catch(() => {});
    } else if (waking) {
      waking.joined = true;
      this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "run" }));
    }
    await this.operate(
      binding.id,
      "starting",
      (signal) => this.runStart(binding.id, signal),
      () => this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "run" }))
    );
  }

  /**
   * An explicit Bring back's wake (#18183): when the provider, asked now, says
   * the machine is asleep, starts it as a person's Start would and waits until
   * it runs. Anything else is left as it is, for the dial to report: a machine
   * a person stopped, one its provider stopped rather than put to sleep, one
   * being removed or operated on. A start already under way is waited out, and
   * a sleep this device is putting it into finishes before it is read. Nothing
   * is sent once `signal` aborts; a start already sent runs to its end.
   * Resolves whether this sent a start, and `sent` hears the provider take it.
   */
  async wakeIfAsleep(
    hostId: HostId,
    bindingId: string,
    signal: AbortSignal,
    sent: () => void
  ): Promise<boolean> {
    // A machine that can't start is never woken: refused before it is waited on or read.
    const asked = this.deps.store.binding(bindingId);
    if (!this.disposed && !signal.aborted && asked?.resourceId && asked.hostId === hostId) {
      this.requireStopAndStart(asked.providerId);
    }
    // A few looks at most: a sleep or an operation beginning between two of them means look again.
    for (let look = 0; look < 3; look++) {
      const sleeping = this.idleSleeping.has(bindingId) ? this.idleAttempts.get(bindingId) : null;
      if (sleeping) await raceAbort(sleeping, signal, undefined);
      let binding = this.wakeable(hostId, bindingId, signal);
      if (!binding) return false;
      const running = this.operations.get(bindingId);
      if (running) {
        // Someone else's start: the dial follows it, but this attempt sent nothing.
        if (running.kind === "starting") {
          await raceAbort(
            running.promise.catch(() => {}),
            signal,
            undefined
          );
        }
        return false;
      }
      const { provider, credentials } = await this.context(binding);
      try {
        await this.inspectInto(bindingId, provider, credentials);
      } catch (error) {
        throw this.deps.accounts.asAppError(provider, error);
      }
      // Whether this read was written or a newer one overtook it, the binding holds the newest word.
      binding = this.wakeable(hostId, bindingId, signal);
      if (!binding) return false;
      if (this.idleSleeping.has(bindingId) || this.operations.has(bindingId)) continue;
      if (!readsAsleep(binding)) return false;
      let startSent = false;
      const request: WakeRequest = {
        hostId,
        asked: signal,
        joined: false,
        sent: () => {
          startSent = true;
          sent();
        },
      };
      // runStart reads it once more inside the operation and starts it only if still asleep
      // and still wakeable, so a Stop, cleanup or removal that came while this looked wins.
      const starting = this.operate(bindingId, "starting", (operation) =>
        this.runStart(bindingId, operation, request)
      );
      this.wakeStarts.set(bindingId, request);
      void starting
        .finally(() => {
          if (this.wakeStarts.get(bindingId) === request) this.wakeStarts.delete(bindingId);
        })
        .catch(() => {});
      try {
        // Let go of a caller that gave up; the start, once sent, is the lifecycle's to finish.
        await raceAbort(starting, signal, undefined);
      } catch (error) {
        throw this.deps.accounts.asAppError(provider, error);
      }
      return startSent;
    }
    return false;
  }

  /** The binding a Bring back may wake, while nothing rules a wake out. */
  private wakeable(
    hostId: HostId,
    bindingId: string,
    signal: AbortSignal
  ): StoredCloudBinding | null {
    if (this.disposed || signal.aborted || this.removing.has(bindingId)) return null;
    // A worktree's cleanup stops or deletes it: never started from under that.
    if (this.cleanupRuns.has(bindingId)) return null;
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId || binding.hostId !== hostId) return null;
    if (binding.worktreeCleanup?.phase === "due") return null;
    // A person's Stop holds until they Start it again.
    if (binding.intent === "stop") return null;
    if (this.deps.accounts.providerUnavailable(binding.providerId) !== null) return null;
    return binding;
  }

  private async runStart(
    bindingId: string,
    signal: AbortSignal,
    wake?: WakeRequest
  ): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) return;
    const { provider, credentials } = await this.context(binding, signal);
    this.stage(bindingId, "Checking the machine");
    let resource: ProviderResource | null;
    // A read overtaken by a newer one is asked again: a start acts on the newest word.
    while (!(resource = await this.inspectInto(bindingId, provider, credentials))) {
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    }
    // A Stop or removal that ended the wake while it read sends nothing, a joined Start included.
    if (wake && signal.aborted) return;
    // Whether this start is the wake's own decision, rather than a person's Start that joined it.
    const woken = wake !== undefined && !wake.joined;
    if (wake && woken) {
      // Only a machine asleep by this read and by the newest one, through the provider still
      // registered, while nothing has ruled a wake out and someone still wants it back.
      const current = this.wakeable(wake.hostId, bindingId, wake.asked);
      if (
        !current ||
        resource.machine !== "stopped" ||
        resource.asleep !== true ||
        !readsAsleep(current) ||
        !this.stillRegistered(current.providerId, provider)
      ) {
        return;
      }
    }
    if (resource.dataExpired) {
      const error: CloudHostError = {
        code: "data-expired",
        message: `${nameOf(provider)} deleted this machine's saved disk after its retention period, so it can't start. Nothing was created in its place.`,
        at: this.now(),
      };
      this.recordError(bindingId, error);
      throw new AppError({ code: "NOT_FOUND", message: error.message, userMessage: error.message });
    }
    let startable = resource.machine === "stopped" || resource.machine === "error";
    if (resource.machine === "stopping") {
      await this.waitFor(
        bindingId,
        "stopped",
        STOP_DEADLINE_MS,
        signal,
        "Waiting for the last stop to finish"
      );
      startable = true;
    }
    if (startable) {
      if (typeof provider.start !== "function") throw noStopOrStart(provider);
      this.stage(bindingId, "Starting the machine");
      // A wake is a Start asked for another way: the machine is meant to run from here.
      if (wake && binding.intent !== "run") {
        this.deps.store.updateBinding(bindingId, (current) => ({ ...current, intent: "run" }));
      }
      try {
        const ticket = this.ticket();
        const started = await provider.start(
          credentials,
          binding.resourceId!,
          startOptions(lifetimeModelOf(provider), binding.lifetimeSeconds)
        );
        if (wake && woken) wake.sent();
        if (started) this.observe(bindingId, started, ticket);
      } catch (error) {
        this.recordError(bindingId, provider.describeError(error));
        throw this.deps.accounts.asAppError(provider, error);
      }
    }
    // A start is a new machine as far as ssh knows: resolve access again.
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: null,
      lastError: null,
    }));
    await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
  }

  /**
   * A person's Stop: lets go of the link, asks for a normal (saving) stop and
   * follows it until the provider says the machine stopped. Never forced.
   */
  async stopMachine(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    // Refused while its provider isn't registered, before the intent changes.
    this.deps.accounts.provider(binding.providerId);
    if (!binding.resourceId) throw invalid("This host has no machine to stop.");
    this.requireStopAndStart(binding.providerId);
    const running = this.operations.get(binding.id);
    // A start, or a create whose machine exists and is still coming up, is
    // superseded by the stop the person asked for now.
    if (running && (running.kind === "starting" || running.kind === "creating")) {
      running.controller.abort();
      await running.promise.catch(() => {});
    }
    // An idle stop under way is joined and sends nothing more; the person's choice is still
    // recorded, and their link let go, as their own Stop would.
    if (running?.kind === "stopping" && this.idleStops.get(binding.id) === running.promise) {
      if (this.deps.store.binding(binding.id)?.intent !== "stop") {
        this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "stop" }));
      }
      const joined = running.promise;
      await this.deps.hosts.disconnect(binding.hostId).catch(() => {});
      return joined;
    }
    // The stop holds the machine before it waits on anything, so a Start meanwhile is refused.
    await this.operate(
      binding.id,
      "stopping",
      async (signal) => {
        await this.settleRenewal(binding.id);
        await this.deps.hosts.disconnect(binding.hostId).catch(() => {});
        if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
        await this.runStop(binding.id, signal);
      },
      () => this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "stop" }))
    );
  }

  private async runStop(bindingId: string, signal: AbortSignal): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) return;
    const { provider, credentials } = await this.context(binding, signal);
    // A delete or shutdown that took over meanwhile: the provider never hears of this stop.
    if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    if (typeof provider.stop !== "function") throw noStopOrStart(provider);
    this.stage(bindingId, "Saving the disk and stopping");
    try {
      const ticket = this.ticket();
      const stopping = await provider.stop(credentials, binding.resourceId);
      if (stopping) this.observe(bindingId, stopping, ticket);
    } catch (error) {
      this.recordError(bindingId, provider.describeError(error));
      throw this.deps.accounts.asAppError(provider, error);
    }
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: null,
      lastError: null,
    }));
    await this.waitFor(
      bindingId,
      "stopped",
      STOP_DEADLINE_MS,
      signal,
      "Saving the disk and stopping"
    );
  }

  /**
   * Deletes the machine at the provider, then removes the host here. The
   * person confirmed deleting this exact machine; saved snapshots stay.
   */
  async deleteMachine(hostId: unknown, confirmResourceId: unknown): Promise<void> {
    const confirmed = this.requireBindingForHost(hostId);
    // Before anything is aborted, looked up or forgotten: a provider that can't
    // delete from Daintree leaves its machine to its own console.
    this.requireDeletion(confirmed.providerId);
    if (confirmed.resourceId && confirmResourceId !== confirmed.resourceId) {
      throw invalid("The machine to delete changed since you confirmed. Check it and try again.");
    }
    // Held until the host is forgotten: a Retry meanwhile (the create this aborts leaves one)
    // could make a machine after the look below found none.
    this.removing.set(confirmed.id, (this.removing.get(confirmed.id) ?? 0) + 1);
    try {
      await this.removeMachine(confirmed, confirmResourceId);
    } finally {
      const left = (this.removing.get(confirmed.id) ?? 1) - 1;
      if (left > 0) this.removing.set(confirmed.id, left);
      else this.removing.delete(confirmed.id);
    }
  }

  private async removeMachine(
    confirmed: StoredCloudBinding & { hostId: HostId },
    confirmResourceId: unknown
  ): Promise<void> {
    const running = this.operations.get(confirmed.id);
    if (running && running.kind !== "deleting") {
      running.controller.abort();
      await running.promise.catch(() => {});
    }
    // Its orders are closed first, so a machine a lease made (here, or one this device never
    // heard of) is deleted with the host. One still being placed leased nothing: its close runs
    // once the host is forgotten. A provider that no longer takes orders can't close them here:
    // the host goes, its orders keep trying, unless one may hold a lease nobody could delete.
    const closesOrders = !!this.registeredProvider(confirmed.providerId)?.offerCreate;
    // A host with its machine has it deleted below whatever its leftover orders hold.
    if (!closesOrders && !this.deps.store.binding(confirmed.id)?.resourceId) {
      const mayHoldLease = this.ordersFor(confirmed.id).some(
        (order) => order.state === "leasing" || order.state === "close"
      );
      if (mayHoldLease) {
        throw invalid(
          "A lease for this host may have gone through, and its provider can't be asked about it now. Try again once it can."
        );
      }
    }
    for (const order of closesOrders ? this.ordersFor(confirmed.id) : []) {
      if (order.state === "placing") continue;
      this.markClosing(order.id);
      try {
        await this.settleOrder(order.id);
      } catch (error) {
        throw this.deps.accounts.asAppError(this.deps.accounts.provider(order.providerId), error);
      }
    }
    let binding = this.deps.store.binding(confirmed.id) ?? confirmed;
    // A create that reached the provider may have made a machine nothing here has heard
    // of yet: find it (a read) before the host, and its label, are forgotten.
    if (!binding.resourceId && binding.creation?.sentAt) {
      const { provider, credentials } = await this.context(binding);
      let found: ProviderResource | "unclear" | null;
      try {
        found = await this.findCreated(binding.id, provider, credentials);
      } catch (error) {
        throw this.deps.accounts.asAppError(provider, error);
      }
      // One another host holds stays with it, and one that can't be told apart stays too:
      // this host is forgotten, deleting nothing.
      if (found && found !== "unclear") this.bindCreated(binding.id, found);
      // Read again either way: a Retry, or a restart's lookup that began first, may have bound
      // the machine while this looked.
      binding = this.deps.store.binding(binding.id) ?? binding;
    }
    const resourceId = binding.resourceId;
    // Its own create made it for this host, so the confirmation covers it.
    if (resourceId && confirmResourceId !== resourceId && confirmed.resourceId !== null) {
      throw invalid("The machine to delete changed since you confirmed. Check it and try again.");
    }
    if (resourceId) await this.sendDelete(binding, confirmed.hostId, resourceId);
    await this.deps.hosts.forget(confirmed.hostId);
  }

  /** Lets go of the link and deletes this exact machine; one already gone counts as deleted. */
  private async sendDelete(
    binding: StoredCloudBinding,
    hostId: HostId,
    resourceId: string
  ): Promise<void> {
    await this.deps.hosts.disconnect(hostId).catch(() => {});
    // A Stop or Start that claimed the machine while this waited gives way too.
    await this.operateOver(binding.id, "deleting", async (signal) => {
      // The binding may have gone, or found another machine, while the link was let go.
      const current = this.deps.store.binding(binding.id);
      if (!current || current.resourceId !== resourceId) {
        throw invalid("The machine to delete changed since you confirmed. Check it and try again.");
      }
      const { provider, credentials } = await this.context(current, signal);
      // The provider may have left or been replaced while its credentials were read.
      if (!this.stillRegistered(current.providerId, provider)) {
        const message = `${nameOf(provider)} changed while the machine was being deleted. Try again.`;
        throw new AppError({ code: "UNSUPPORTED", message, userMessage: message });
      }
      this.requireDeletion(current.providerId);
      // Never a machine another host uses, however the two came to share it.
      const holder = this.heldElsewhere(current.providerId, binding.id, resourceId);
      if (holder) {
        const host = holder.hostId ? this.deps.hosts.get(holder.hostId) : null;
        throw invalid(
          `That machine is also in your host list${host ? ` as ${host.name}` : ""}, so Daintree won't delete it. Remove this host and keep its machine instead.`
        );
      }
      this.stage(binding.id, "Deleting the machine");
      try {
        await provider.delete(credentials, resourceId);
      } catch (error) {
        const described = provider.describeError(error);
        if (described.code !== "not-found") {
          this.recordError(binding.id, described);
          throw this.deps.accounts.asAppError(provider, error);
        }
      }
    });
  }

  /** Ends a start or create under way so a stop or delete asked for now goes ahead. */
  private async supersedeRunning(bindingId: string, kinds: readonly CloudOperationKind[]) {
    const running = this.operations.get(bindingId);
    if (!running || !kinds.includes(running.kind)) return;
    running.controller.abort();
    await running.promise.catch(() => {});
  }

  // --- With a worktree's delete -------------------------------------------

  /**
   * Writes down what the person chose for the machines made for a worktree,
   * before that worktree's delete is sent: nothing is done to them until the
   * worktree is gone. Each machine must carry this worktree's mark and be the
   * one the person confirmed; any other is refused, so an unmarked machine is
   * never touched. A machine of this worktree left out of the list is kept, and
   * a choice an earlier attempt wrote for it is dropped. Each write is a new
   * attempt, so an answer about an earlier one never changes it.
   */
  prepareWorktreeCleanup(worktree: unknown, machines: unknown, mutationId?: unknown): void {
    const ref = checkedWorktreeRef(worktree);
    const mutation = checkedMutationId(mutationId);
    if (!Array.isArray(machines)) throw invalid("Choose what happens to each machine.");
    const planned = new Map<string, StoredWorktreeCleanup>();
    for (const raw of machines as Array<Partial<CloudWorktreeCleanupRequest> | null>) {
      const choice = raw?.choice === "stop" || raw?.choice === "delete" ? raw.choice : null;
      if (!choice) throw invalid("Choose what happens to each machine.");
      const binding = this.requireBindingForHost(raw?.hostId);
      if (
        binding.ownership !== "created-by-daintree" ||
        !cloudMarkNamesWorktree(binding.createdFor, ref)
      ) {
        throw invalid(
          "That machine wasn't created for this worktree, so Daintree leaves it alone."
        );
      }
      if (!binding.resourceId || raw?.resourceId !== binding.resourceId) {
        throw invalid("The machine changed since you confirmed. Check it and try again.");
      }
      // Refused while its provider isn't registered, before anything is written.
      this.deps.accounts.provider(binding.providerId);
      if (choice === "delete") this.requireDeletion(binding.providerId);
      else this.requireStopAndStart(binding.providerId);
      if (planned.has(binding.id)) throw invalid("Choose once for each machine.");
      if (mutation && this.keptForDelete.has(`${binding.id}\u0000${mutation}`)) continue;
      const current = binding.worktreeCleanup;
      if (
        this.cleanupRuns.has(binding.id) &&
        (current?.choice !== choice || current.resourceId !== binding.resourceId)
      ) {
        throw invalid("The machine's stop or delete is under way. Wait for it to finish.");
      }
      planned.set(binding.id, {
        attemptId: crypto.randomUUID(),
        mutationId: mutation,
        choice,
        resourceId: binding.resourceId,
        worktree: ref,
        phase: "waiting",
        error: null,
        requestedAt: this.now(),
      });
    }
    for (const binding of this.deps.store.bindings()) {
      const current = binding.worktreeCleanup;
      const next = planned.get(binding.id);
      if (next) {
        // A retried delete asks again: one already carrying out, or failed, stays as it is.
        const same =
          current !== null &&
          (current.phase === "due" || current.phase === "failed") &&
          current.choice === next.choice &&
          current.resourceId === next.resourceId;
        if (!same) {
          this.deps.store.updateBinding(binding.id, (b) => ({ ...b, worktreeCleanup: next }));
        }
      } else if (
        current !== null &&
        (current.phase === "waiting" || current.phase === "unconfirmed") &&
        sameWorktree(current.worktree, ref)
      ) {
        this.deps.store.updateBinding(binding.id, (b) => ({ ...b, worktreeCleanup: null }));
      }
    }
  }

  /**
   * An attempt at the worktree's delete ended, as its view heard it: `deleted`
   * true when the host that owns the worktree said it went, false when it
   * refused, null when the answer was lost. The machines' stops and deletes
   * run once the worktree is known to be gone, and this resolves when they're
   * done, with how each ended. A worktree on this device is looked at, never
   * taken on report. One still there after a refusal leaves its machines as
   * they are, and a later delete asks again; anything short of a refusal
   * leaves the choice waiting for the worktree to go.
   */
  async settleWorktreeCleanup(
    worktree: unknown,
    deleted: unknown,
    mutationId?: unknown
  ): Promise<CloudWorktreeCleanupOutcome[]> {
    const ref = checkedWorktreeRef(worktree);
    const mutation = checkedMutationId(mutationId);
    const reported = deleted === true ? true : deleted === false ? false : null;
    // Only the choices that delete came with: a late answer never settles a later delete's.
    const targets = new Map(
      [...this.cleanupsFor(ref)].filter(([, cleanup]) => cleanup.mutationId === mutation)
    );
    if (targets.size === 0) return [];
    const waiting = new Map([...targets].filter(([, cleanup]) => cleanup.phase === "waiting"));
    if (waiting.size > 0) {
      const gone = await this.worktreeIsGone(ref, reported);
      if (gone === true) {
        for (const [bindingId, cleanup] of waiting) {
          void this.carryOutCleanup(bindingId, ["waiting"], cleanup.attemptId);
        }
      } else if (gone === false && reported === false) {
        // Only a refusal drops it: a delete whose answer was lost may still be removing it.
        for (const [bindingId, cleanup] of waiting) {
          this.disarmCleanup(bindingId, cleanup.attemptId);
        }
      }
    }
    const outcomes = await Promise.all(
      [...targets].map(([bindingId, cleanup]) => this.outcomeOf(bindingId, cleanup.attemptId))
    );
    return outcomes.filter((outcome): outcome is CloudWorktreeCleanupOutcome => outcome !== null);
  }

  /**
   * A person's Retry of a stop or delete that failed, or of the look at a
   * worktree on this device that couldn't tell whether it's gone. A choice
   * Daintree never heard back about for a worktree on another host isn't
   * retried: nothing here can tell whether that worktree still exists.
   */
  async retryWorktreeCleanup(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    const cleanup = binding.worktreeCleanup;
    if (!cleanup) throw invalid("There's nothing left to do for this machine.");
    if (cleanup.choice === "stop") this.requireStopAndStart(binding.providerId);
    if (cleanup.phase === "unconfirmed") {
      throw invalid(
        "Daintree can't tell whether its worktree was deleted, so it leaves the machine as it is. Stop or remove it here if the worktree is gone."
      );
    }
    let from: ReadonlyArray<StoredWorktreeCleanup["phase"]> = ["due", "failed"];
    if (cleanup.phase === "waiting") {
      if (cleanup.worktree.hostId !== null) {
        throw invalid("Its worktree's host hasn't said yet whether the worktree was deleted.");
      }
      // A look, never a verdict on the delete: one still running may yet remove it.
      const gone = await this.worktreeIsGone(cleanup.worktree, null);
      if (gone === false) {
        throw invalid(
          "Its worktree is still there, so the machine is left as it is until the worktree is deleted."
        );
      }
      if (gone === null) {
        throw invalid("Daintree couldn't tell whether the worktree is still there. Try again.");
      }
      from = ["waiting"];
    }
    const outcome = await this.carryOutCleanup(binding.id, from, cleanup.attemptId);
    // Moved on while it looked (the removal was heard and its stop or delete failed): say so.
    const after = this.deps.store.binding(binding.id)?.worktreeCleanup;
    if (outcome === null && after?.attemptId === cleanup.attemptId && after.phase === "failed") {
      const message = after.error?.message ?? "It didn't finish.";
      throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
    }
    if (outcome?.error) {
      throw new AppError({
        code: "OUTCOME_UNKNOWN",
        message: outcome.error,
        userMessage: outcome.error,
      });
    }
  }

  /** A person's Keep: the machine stays as it is, and its stop or delete is dropped. */
  dismissWorktreeCleanup(hostId: unknown): void {
    const binding = this.requireBindingForHost(hostId);
    if (this.cleanupRuns.has(binding.id)) {
      throw invalid("The machine's stop or delete is under way. Wait for it to finish.");
    }
    const mutation = binding.worktreeCleanup?.mutationId;
    if (mutation) this.keptForDelete.add(`${binding.id}\u0000${mutation}`);
    this.deps.store.updateBinding(binding.id, (current) => ({ ...current, worktreeCleanup: null }));
  }

  /** Each machine's choice for this worktree, by binding, as it stands now. */
  private cleanupsFor(ref: CloudWorktreeRef): Map<string, StoredWorktreeCleanup> {
    const found = new Map<string, StoredWorktreeCleanup>();
    for (const binding of this.deps.store.bindings()) {
      const cleanup = binding.worktreeCleanup;
      if (cleanup && binding.hostId && sameWorktree(cleanup.worktree, ref)) {
        found.set(binding.id, cleanup);
      }
    }
    return found;
  }

  /** How this attempt's choice ended: joined while it runs, its failure once failed; null otherwise. */
  private async outcomeOf(
    bindingId: string,
    attemptId: string
  ): Promise<CloudWorktreeCleanupOutcome | null> {
    const running = this.cleanupRuns.get(bindingId);
    if (running) return running;
    const binding = this.deps.store.binding(bindingId);
    const cleanup = binding?.worktreeCleanup;
    if (!binding?.hostId || cleanup?.attemptId !== attemptId) return null;
    if (cleanup.phase === "due") return this.carryOutCleanup(bindingId, ["due"], attemptId);
    if (cleanup.phase !== "failed") return null;
    return {
      hostId: binding.hostId,
      machineName: binding.observation?.name ?? cleanup.resourceId,
      choice: cleanup.choice,
      error: cleanup.error?.message ?? "It didn't finish.",
    };
  }

  /**
   * Whether the worktree is gone: one on this device is looked at, and only a
   * missing root counts; one on another host is taken from that host's answer
   * to the delete. Null when nothing can tell.
   */
  private async worktreeIsGone(
    ref: CloudWorktreeRef,
    reported: boolean | null
  ): Promise<boolean | null> {
    if (ref.hostId !== null) return reported;
    if (!this.deps.worktreeGone) return null;
    return this.deps.worktreeGone(ref.worktreeId).catch(() => null);
  }

  /** Drops a choice still waiting from this attempt: the delete it came with didn't happen. */
  private disarmCleanup(bindingId: string, attemptId: string): void {
    this.deps.store.updateBinding(bindingId, (current) =>
      current.worktreeCleanup?.attemptId === attemptId &&
      current.worktreeCleanup.phase === "waiting"
        ? { ...current, worktreeCleanup: null }
        : current
    );
  }

  /** A worktree on this device may have gone: its machines' choices run once its root is missing. */
  private async worktreeRemoved(worktreeId: string): Promise<void> {
    const found = new Map<string, StoredWorktreeCleanup>();
    for (const binding of this.deps.store.bindings()) {
      const cleanup = binding.worktreeCleanup;
      if (
        cleanup?.phase === "waiting" &&
        cleanup.worktree.hostId === null &&
        cleanup.worktree.worktreeId === worktreeId
      ) {
        found.set(binding.id, cleanup);
      }
    }
    if (found.size === 0) return;
    const ref = [...found.values()][0]!.worktree;
    if ((await this.worktreeIsGone(ref, null)) !== true || this.disposed) return;
    for (const [bindingId, cleanup] of found) {
      void this.carryOutCleanup(bindingId, ["waiting"], cleanup.attemptId);
    }
  }

  /** Stops and deletes that were under way when Daintree last quit, and any a provider held up. */
  private resumeDueCleanups(): void {
    if (this.disposed) return;
    for (const binding of this.deps.store.bindings()) {
      const cleanup = binding.worktreeCleanup;
      if (cleanup?.phase !== "due" || this.cleanupRuns.has(binding.id)) continue;
      if (!binding.hostId || !this.deps.hosts.get(binding.hostId)) continue;
      if (this.deps.accounts.providerUnavailable(binding.providerId)) continue;
      void this.carryOutCleanup(binding.id, ["due"], cleanup.attemptId);
    }
  }

  /**
   * Choices still waiting when Daintree last quit: whatever delete they came
   * with ended with that run. A worktree on this device that's gone has its
   * machines' choices carried out, and one still there drops them. One on
   * another host can't be looked at from here, so the choice is left as
   * unconfirmed, saying why, for the person to settle.
   */
  private async reconcileWaitingCleanups(): Promise<void> {
    const byWorktree = new Map<
      string,
      { ref: CloudWorktreeRef; cleanups: Array<[string, StoredWorktreeCleanup]> }
    >();
    for (const binding of this.deps.store.bindings()) {
      const cleanup = binding.worktreeCleanup;
      if (cleanup?.phase !== "waiting" || !binding.hostId) continue;
      if (!this.deps.hosts.get(binding.hostId)) continue;
      const key = JSON.stringify([
        cleanup.worktree.hostId,
        cleanup.worktree.projectId,
        cleanup.worktree.worktreeId,
      ]);
      const entry = byWorktree.get(key) ?? { ref: cleanup.worktree, cleanups: [] };
      entry.cleanups.push([binding.id, cleanup]);
      byWorktree.set(key, entry);
    }
    for (const { ref, cleanups } of byWorktree.values()) {
      if (ref.hostId !== null) {
        for (const [bindingId, cleanup] of cleanups) {
          this.deps.store.updateBinding(bindingId, (current) =>
            current.worktreeCleanup?.attemptId === cleanup.attemptId &&
            current.worktreeCleanup.phase === "waiting"
              ? {
                  ...current,
                  worktreeCleanup: {
                    ...current.worktreeCleanup,
                    phase: "unconfirmed",
                    error: {
                      code: "outcome-unknown",
                      message:
                        "Daintree quit before it heard whether the worktree was deleted, so the machine was left as it was.",
                      at: this.now(),
                    },
                  },
                }
              : current
          );
        }
        continue;
      }
      const gone = await this.worktreeIsGone(ref, null);
      if (this.disposed) return;
      for (const [bindingId, cleanup] of cleanups) {
        if (gone === false) this.disarmCleanup(bindingId, cleanup.attemptId);
        else if (gone === true)
          void this.carryOutCleanup(bindingId, ["waiting"], cleanup.attemptId);
      }
    }
  }

  /**
   * Runs a machine's stop or delete once, joined by every caller while it
   * runs. Only a choice still in one of `from`, from the same attempt, is
   * started: an answer about an earlier attempt, or a second look that lands
   * after a failure, never runs it again.
   */
  private carryOutCleanup(
    bindingId: string,
    from: ReadonlyArray<StoredWorktreeCleanup["phase"]>,
    attemptId: string
  ): Promise<CloudWorktreeCleanupOutcome | null> {
    const running = this.cleanupRuns.get(bindingId);
    if (running) return running;
    const cleanup = this.deps.store.binding(bindingId)?.worktreeCleanup;
    if (!cleanup || cleanup.attemptId !== attemptId || !from.includes(cleanup.phase)) {
      return Promise.resolve(null);
    }
    const run = this.runCleanup(bindingId).finally(() => {
      if (this.cleanupRuns.get(bindingId) === run) this.cleanupRuns.delete(bindingId);
    });
    this.cleanupRuns.set(bindingId, run);
    return run;
  }

  /**
   * Carries out the stop or delete, written down as due before anything is
   * sent, so a restart partway runs it again: a delete of a machine already
   * gone counts as done, and a stop finds the machine stopped or stopping. A
   * failure is kept with the choice for Retry, never retried by itself. A
   * shutdown partway leaves it due, and so does a provider that isn't there.
   */
  private async runCleanup(bindingId: string): Promise<CloudWorktreeCleanupOutcome | null> {
    const saved = this.deps.store.binding(bindingId);
    const savedCleanup = saved?.worktreeCleanup;
    // A stop chosen for a machine that has none (one replayed after a restart) ends nothing: it
    // fails as it stands, never retried by itself, and the machine runs on until it's deleted.
    if (saved?.hostId && savedCleanup?.choice === "stop") {
      const refusal = this.stopAndStartRefusal(saved.providerId);
      if (refusal) {
        this.setCleanupError(bindingId, savedCleanup.attemptId, "failed", {
          code: "unsupported",
          message: refusal.message,
          at: this.now(),
        });
        return {
          hostId: saved.hostId,
          machineName: saved.observation?.name ?? savedCleanup.resourceId,
          choice: savedCleanup.choice,
          error: refusal.message,
        };
      }
    }
    const binding = this.deps.store.updateBinding(bindingId, (current) =>
      current.worktreeCleanup
        ? {
            ...current,
            worktreeCleanup: { ...current.worktreeCleanup, phase: "due", error: null },
          }
        : current
    );
    const cleanup = binding?.worktreeCleanup;
    if (!binding || !cleanup || !binding.hostId) return null;
    const hostId = binding.hostId;
    const outcome = (error: string | null): CloudWorktreeCleanupOutcome => ({
      hostId,
      machineName: binding.observation?.name ?? cleanup.resourceId,
      choice: cleanup.choice,
      error,
    });
    const unavailable = this.deps.accounts.providerUnavailable(binding.providerId);
    if (unavailable) {
      // Left due, saying why: it runs once its provider is back.
      this.setCleanupError(bindingId, cleanup.attemptId, "due", {
        code: "unsupported",
        message: unavailable,
        at: this.now(),
      });
      return outcome(unavailable);
    }
    const startedAt = this.now();
    try {
      if (cleanup.choice === "delete") {
        await this.supersedeRunning(bindingId, ["creating", "starting", "stopping"]);
        await this.sendDelete(binding, hostId, cleanup.resourceId);
        await this.deps.hosts.forget(hostId);
      } else {
        await this.stopForCleanup(binding, hostId);
      }
      this.deps.store.updateBinding(bindingId, (current) =>
        current.worktreeCleanup?.attemptId === cleanup.attemptId
          ? { ...current, worktreeCleanup: null }
          : current
      );
      return outcome(null);
    } catch (error) {
      if (this.disposed) return outcome("Daintree quit before it finished.");
      // Its provider left partway: nothing was settled, so it waits for the provider like a start would.
      const left = this.deps.accounts.providerUnavailable(binding.providerId);
      if (left) {
        this.setCleanupError(bindingId, cleanup.attemptId, "due", {
          code: "unsupported",
          message: left,
          at: this.now(),
        });
        return outcome(left);
      }
      const recorded = this.deps.store.binding(bindingId)?.lastError;
      const thrown =
        error instanceof AppError && error.userMessage
          ? error.userMessage
          : formatErrorMessage(error, "The provider didn't answer.");
      const failure: CloudHostError = {
        code: recorded && recorded.at >= startedAt ? recorded.code : "failed",
        message: thrown,
        at: this.now(),
      };
      this.setCleanupError(bindingId, cleanup.attemptId, "failed", failure);
      return outcome(failure.message);
    }
  }

  private setCleanupError(
    bindingId: string,
    attemptId: string,
    phase: "due" | "failed",
    error: CloudHostError
  ): void {
    this.deps.store.updateBinding(bindingId, (current) =>
      current.worktreeCleanup?.attemptId === attemptId
        ? { ...current, worktreeCleanup: { ...current.worktreeCleanup, phase, error } }
        : current
    );
  }

  /**
   * A stop that finds the machine as a restart may have left it. A start or
   * create under way is ended first, as a person's Stop ends it, and the look
   * and the stop are one operation, so nothing starts it again in between. A
   * machine its provider reports stopped or deleted needs nothing more.
   */
  private async stopForCleanup(binding: StoredCloudBinding, hostId: HostId): Promise<void> {
    await this.supersedeRunning(binding.id, ["creating", "starting"]);
    this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "stop" }));
    await this.settleRenewal(binding.id);
    await this.deps.hosts.disconnect(hostId).catch(() => {});
    await this.operate(binding.id, "stopping", async (signal) => {
      const { provider, credentials } = await this.context(binding, signal);
      this.stage(binding.id, "Checking the machine");
      let resource: ProviderResource | null;
      try {
        // A read overtaken by a newer one is asked again: the stop acts on the newest word.
        while (!(resource = await this.inspectInto(binding.id, provider, credentials))) {
          if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
        }
      } catch (error) {
        throw this.deps.accounts.asAppError(provider, error);
      }
      if (resource.machine === "stopped" || resource.machine === "deleted") return;
      if (resource.machine === "stopping") {
        await this.waitFor(
          binding.id,
          "stopped",
          STOP_DEADLINE_MS,
          signal,
          "Saving the disk and stopping"
        );
        return;
      }
      await this.runStop(binding.id, signal);
    });
  }

  /**
   * Runs `work` as the machine's operation once every other one on it is
   * aborted and finished, including any that claimed it while the last wound
   * down. It claims the machine in the same turn as its last look, so a caller
   * queued behind the aborted operation can't get in first.
   */
  private async operateOver(
    bindingId: string,
    kind: CloudOperationKind,
    work: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    let running = this.operations.get(bindingId);
    while (running && running.kind !== kind) {
      running.controller.abort();
      await running.promise.catch(() => {});
      running = this.operations.get(bindingId);
    }
    return this.operate(bindingId, kind, work);
  }

  /**
   * Refuses a delete through a registered provider that declares it can't.
   * An unregistered one is refused later, with the reason it's unavailable.
   */
  private requireDeletion(providerId: CloudProviderId): void {
    if (this.deps.accounts.providerUnavailable(providerId) !== null) return;
    const info = this.deps.accounts.provider(providerId).info(process.platform);
    if (info.capabilities.deletion) return;
    const message = `Daintree can't delete machines on ${info.name}. Delete it in ${info.name}'s console.`;
    throw new AppError({ code: "UNSUPPORTED", message, userMessage: message });
  }

  /**
   * Refuses a stop or start through a registered provider whose machines can
   * only be deleted, before any intent is written, link let go or request
   * sent. An unregistered one is refused later, with the reason it's unavailable.
   */
  private requireStopAndStart(providerId: CloudProviderId): void {
    const refusal = this.stopAndStartRefusal(providerId);
    if (refusal) throw refusal;
  }

  private stopAndStartRefusal(providerId: CloudProviderId): AppError | null {
    if (this.deps.accounts.providerUnavailable(providerId) !== null) return null;
    const provider = this.deps.accounts.provider(providerId);
    return deleteOnly(provider) ? noStopOrStart(provider) : null;
  }

  /** Reads the machine's state now, for a person's refresh. Never starts anything. */
  async refresh(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    if (!binding.resourceId) return;
    const { provider, credentials } = await this.context(binding);
    try {
      await this.inspectInto(binding.id, provider, credentials);
    } catch (error) {
      throw this.deps.accounts.asAppError(provider, error);
    }
  }

  /**
   * Sets how long the machine runs before it stops by itself. On a renewable
   * provider a running machine's own deadline moves too (to that long from
   * now, or none), so what Settings shows is what will happen to this run. A
   * limit fixed at create changes only while the machine is stopped, where the
   * provider allows it, and holds from its next start; a provider with no
   * lifetime, or one that sleeps machines when idle, has nothing to set.
   */
  async setLifetime(hostId: unknown, lifetimeHours: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    // Refused while its provider isn't registered, before anything here changes.
    const owner = this.deps.accounts.provider(binding.providerId);
    if (!CLOUD_LIFETIME_CHOICES.includes(lifetimeHours as number | null)) {
      throw invalid("Choose how long the machine may run before it stops by itself.");
    }
    const lifetimeSeconds = lifetimeHours === null ? null : (lifetimeHours as number) * 3600;
    const model = lifetimeModelOf(owner);
    if (model.kind === "fixed-at-create") {
      if (!model.canChangeWhileStopped) {
        throw invalid(`${nameOf(owner)} fixes a machine's runtime limit when it's created.`);
      }
      if (
        !binding.resourceId ||
        machineOf(binding) !== "stopped" ||
        this.operations.has(binding.id)
      ) {
        throw invalid(
          `${nameOf(owner)} changes a machine's runtime limit only while it's stopped.`
        );
      }
      this.deps.store.updateBinding(binding.id, (current) => ({ ...current, lifetimeSeconds }));
      return;
    }
    if (!canRenewLifetime(owner)) {
      throw invalid(`${nameOf(owner)} doesn't take a lifetime for its machines.`);
    }
    await this.settleRenewal(binding.id);
    // A provider that left or was replaced while the renewal settled may not take this at all.
    if (!this.stillRegistered(binding.providerId, owner)) {
      throw invalid(`${nameOf(owner)} changed while this was being saved. Try again.`);
    }
    this.renewals.delete(binding.id);
    const keep = () =>
      this.deps.store.updateBinding(binding.id, (current) => ({ ...current, lifetimeSeconds }));
    if (
      !binding.resourceId ||
      machineOf(binding) !== "running" ||
      this.operations.has(binding.id)
    ) {
      keep();
      return;
    }
    // A running machine's own deadline moves first: a refusal leaves both the
    // machine and the lifetime Settings shows as they were.
    const { provider, credentials } = await this.context(binding);
    // Sent only through the provider still registered, and its answer kept only while it still is.
    if (!this.stillRegistered(binding.providerId, provider) || provider !== owner) {
      throw invalid(`${nameOf(owner)} changed while this was being saved. Try again.`);
    }
    if (!canRenewLifetime(provider)) {
      throw invalid(`${nameOf(provider)} doesn't take a lifetime for its machines.`);
    }
    let resource: ProviderResource;
    const ticket = this.ticket();
    try {
      resource = await provider.renewLifetime(credentials, binding.resourceId, lifetimeSeconds);
    } catch (error) {
      // A replaced provider's failure says nothing about the account as it is now.
      if (!this.stillRegistered(binding.providerId, provider)) {
        throw invalid(`${nameOf(owner)} changed while this was being saved. Try again.`);
      }
      throw this.deps.accounts.asAppError(provider, error);
    }
    if (!this.stillRegistered(binding.providerId, provider)) {
      throw invalid(`${nameOf(owner)} changed while this was being saved. Try again.`);
    }
    keep();
    this.observe(binding.id, resource, ticket);
  }

  // --- SSH access ----------------------------------------------------------

  /**
   * How to reach the machine's sshd for a dial, setup or install. Only ever
   * reads the machine's state: a stopped machine is refused with a reason (the
   * link stops retrying until someone starts it), one still starting is a
   * transient failure the link retries.
   */
  async ensureAccess(
    bindingId: string,
    signal?: AbortSignal,
    options: { fresh?: boolean } = {}
  ): Promise<CloudSshRoute> {
    // A person's Retry asks again from scratch: the last observation and access may be stale.
    // Without its provider nothing can ask again, and when it was last seen is all there is to go on.
    const asked = options.fresh ? this.deps.store.binding(bindingId) : null;
    if (asked && this.deps.accounts.providerUnavailable(asked.providerId) === null) {
      this.deps.store.updateBinding(bindingId, (current) => ({
        ...current,
        access: null,
        observation: current.observation ? { ...current.observation, observedAt: 0 } : null,
      }));
    }
    // One resolution per machine, shared, and not tied to any one caller's
    // signal: a dial that gives up must not fail the others waiting on it.
    let attempt = this.accessInFlight.get(bindingId);
    if (!attempt) {
      const started = this.resolveAccess(bindingId);
      attempt = started;
      this.accessInFlight.set(bindingId, started);
      void started
        .finally(() => {
          if (this.accessInFlight.get(bindingId) === started) this.accessInFlight.delete(bindingId);
        })
        .catch(() => {});
    }
    if (!signal) return attempt;
    return new Promise<CloudSshRoute>((resolve, reject) => {
      const onAbort = () => reject(new TransportError("Cancelled", null));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      attempt.then(
        (route) => {
          signal.removeEventListener("abort", onAbort);
          resolve(route);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  private async resolveAccess(bindingId: string): Promise<CloudSshRoute> {
    // Read again past each await: a removal there must not have its access resolved after all.
    const current = (): StoredCloudBinding => {
      const found = this.deps.store.binding(bindingId);
      if (!found) {
        throw new UnusableConnectionError("This cloud host isn't set up on this device", null);
      }
      return found;
    };
    // It is being put to sleep by its host's idle time: a dial now would wake it, or race it.
    if (this.idleSleeping.has(bindingId)) {
      throw new TransportError(
        "The cloud machine is going to sleep",
        "Daintree is putting the machine to sleep."
      );
    }
    let binding = current();
    if (!binding.resourceId) {
      // Retry is offered as Settings offers it; until then, the details say where setup is.
      const retryable =
        binding.lastError !== null &&
        !this.operations.has(bindingId) &&
        this.deps.accounts.providerUnavailable(binding.providerId) === null;
      throw new UnusableConnectionError(
        "The cloud machine hasn't been created yet",
        retryable
          ? "Setup didn't finish. Open the host's details to retry."
          : "Setup hasn't finished. Open the host's details to see where it is."
      );
    }
    let context: { provider: CloudProvider; credentials: ProviderCredentials };
    try {
      context = await this.context(binding);
    } catch (error) {
      const said =
        error instanceof AppError
          ? (error.userMessage ?? error.message)
          : "The cloud account can't be used";
      throw new UnusableConnectionError(said, said);
    }
    // A start may have seen the machine running meanwhile: a dial left to finish
    // across it must not be refused on the stop it read first (#17546).
    binding = current();
    const { provider, credentials } = context;
    // A machine that sleeps by itself may have since a recent look, and a dial would wake it.
    // One a device can put to sleep is looked at every time: a look answered just before
    // its sleep began can arrive after, and read as fresh (#17916).
    const freshFor = canSleepIdle(provider)
      ? 0
      : lifetimeModelOf(provider).kind === "idle-sleep"
        ? SLEEPER_DIAL_OBSERVATION_MS
        : DIAL_OBSERVATION_MS;
    const age = binding.observation ? this.now() - binding.observation.observedAt : Number.NaN;
    // A clock set back makes an old look read as younger than nothing: it is looked at again.
    const fresh = freshFor > 0 && age >= 0 && age < freshFor;
    if (!fresh) {
      try {
        await this.inspectInto(bindingId, provider, credentials);
      } catch (error) {
        const described = provider.describeError(error);
        if (described.code === "provider-unreachable") {
          throw new TransportError(
            `Couldn't ask ${nameOf(provider)} about the machine`,
            described.message
          );
        }
        throw new UnusableConnectionError(described.message, described.message);
      }
      binding = current();
    }
    const machine = machineOf(binding);
    if (machine === "starting") {
      throw new TransportError("The cloud machine is starting", "The machine is starting.");
    }
    if (machine !== "running") {
      const said =
        machine === "stopped" && binding.observation?.asleep
          ? "The cloud machine is asleep. Start it to wake it and connect."
          : machine === "stopped" || machine === "stopping"
            ? "The cloud machine is stopped. Start it to connect."
            : machine === "deleted"
              ? "The cloud machine was deleted."
              : "The cloud machine isn't running.";
      throw new UnusableConnectionError(said, said);
    }
    const confirmed = confirmsHostKeys(provider);
    if (confirmed && provider.info(process.platform).capabilities.transport !== "direct") {
      const said = `Daintree can't reach ${nameOf(provider)} machines through the provider's own connection yet.`;
      throw new UnusableConnectionError(said, said);
    }
    // Before any reuse: a tunnel's command can be uninstalled or moved at any time.
    const policy = await this.sshPolicy(bindingId, provider);
    // Also before any reuse: a route names the key's path, and the key there may be gone or another.
    const rekey = await this.keyToPutOn(bindingId, provider, binding);
    const access = binding.access;
    if (
      access &&
      rekey === null &&
      this.now() - access.obtainedAt < ACCESS_TTL_MS &&
      // A key confirmed by the person is pinned only while it is still the trusted one.
      (!confirmed || access.hostKey === binding.trustedHostKey?.key) &&
      // Access resolved under another trust (a provider that changed what it vouches with) is asked for again.
      (access.hostKey === null) === (policy.trust === "provider-tunnel") &&
      (await this.deps.files.exists(bindingId))
    ) {
      const record: CloudSshAccessRecord = {
        user: access.user,
        endpoint: { host: access.host, port: access.port },
        hostKey: access.hostKey,
        tunnel: policy.tunnel,
      };
      const generation = routeGeneration(record);
      const written = this.writtenRoutes.get(bindingId);
      // Files an earlier run wrote are reused only when they are what this access writes now.
      if (
        written === generation ||
        (written === undefined &&
          (await this.deps.files.isCurrent(bindingId, binding.accountId, record)))
      ) {
        this.writtenRoutes.set(bindingId, generation);
        this.clearAccessErrors(bindingId);
        return this.deps.files.route(bindingId);
      }
    }
    let resolved: ProviderSshAccess;
    try {
      resolved = await this.sshAccessFor(provider, credentials, binding, rekey);
    } catch (error) {
      const described = provider.describeError(error);
      if (described.code === "provider-unreachable") {
        throw new TransportError(
          `Couldn't get SSH access from ${nameOf(provider)}`,
          described.message
        );
      }
      const said = `SSH access couldn't be set up: ${described.message}`;
      this.recordError(bindingId, { ...described, code: "ssh-authorization", message: said });
      throw new UnusableConnectionError(said, said);
    }
    const checked = checkedAccess(resolved, policy.trust, nameOf(provider));
    if ("problem" in checked) {
      const said = `SSH access couldn't be set up: ${checked.problem}`;
      this.recordError(bindingId, { code: "ssh-authorization", message: said, at: this.now() });
      throw new UnusableConnectionError(said, said);
    }
    const record: CloudSshAccessRecord = {
      user: resolved.user,
      endpoint: resolved.endpoint,
      // Whatever the API said about the key, it never replaces a key already trusted.
      hostKey: confirmed
        ? await this.confirmedHostKey(bindingId, resolved.endpoint, checked.hostKey)
        : checked.hostKey,
      tunnel: policy.tunnel,
    };
    // A master opened to the old address, key or tunnel must not carry a dial to
    // the new one; the same route written again leaves a live link's master alone.
    const generation = routeGeneration(record);
    const written = this.writtenRoutes.get(bindingId);
    if (written === undefined || written !== generation) {
      await this.deps.files.closeMaster(this.deps.clientDir, bindingId);
    }
    // A write cut short leaves nothing here vouching for whatever reached the disk.
    this.writtenRoutes.delete(bindingId);
    const route = await this.deps.files.write(bindingId, binding.accountId, record);
    this.writtenRoutes.set(bindingId, generation);
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: {
        user: record.user,
        host: record.endpoint.host,
        port: record.endpoint.port,
        hostKey: record.hostKey,
        obtainedAt: this.now(),
      },
    }));
    // Only once its route is written: a dial cut short before that bypasses the cached route again.
    if (rekey !== null) this.heldKeys.set(bindingId, keyIdentity(rekey));
    this.clearAccessErrors(bindingId);
    return route;
  }

  /**
   * The key to pin for a provider that can't always vouch for one: the
   * trusted key, as long as the machine still presents it. With no key trusted
   * yet, a key the provider's authenticated API vouched for (`vouched`, only
   * under `api-or-confirm`) is trusted when the machine presents exactly it.
   * Otherwise a first key, or one unlike the trusted key, is kept for the
   * person to review and the dial is refused.
   */
  private async confirmedHostKey(
    bindingId: string,
    endpoint: SshEndpoint,
    vouched: string | null
  ): Promise<string> {
    const scan = async (types?: string): Promise<string[]> => {
      try {
        return await this.deps.files.scanHostKeys(endpoint, { types });
      } catch (error) {
        const said = `Daintree couldn't read the machine's host key: ${formatErrorMessage(error, "ssh-keyscan failed")}`;
        throw new UnusableConnectionError(said, said);
      }
    };
    // A first key on offer that the API now contradicts is withdrawn before anything is scanned.
    const before = this.deps.store.binding(bindingId);
    if (
      vouched &&
      !before?.trustedHostKey &&
      before?.offeredHostKey &&
      before.offeredHostKey.key !== vouched
    ) {
      this.deps.store.updateBinding(bindingId, (current) =>
        current.offeredHostKey && current.offeredHostKey.key !== vouched
          ? { ...current, offeredHostKey: null }
          : current
      );
    }
    let scanned = await scan();
    const trustedBefore = this.deps.store.binding(bindingId)?.trustedHostKey?.key ?? null;
    if (trustedBefore && !scanned.includes(trustedBefore)) {
      // Each algorithm is its own connection, and one can drop while the others
      // answer: the trusted key's absence is checked on its own before it counts.
      const again = await scan(keyscanTypeOf(trustedBefore));
      if (again.includes(trustedBefore)) scanned = [...scanned, trustedBefore];
    } else if (!trustedBefore && vouched && scanned.length > 0 && !scanned.includes(vouched)) {
      // The same for the vouched key: its algorithm's connection may be the one that dropped.
      const again = await scan(keyscanTypeOf(vouched));
      if (again.includes(vouched)) scanned = [...scanned, vouched];
    }
    // Read after the scan: the person may have trusted a key while it ran.
    const binding = this.deps.store.binding(bindingId);
    if (!binding) {
      throw new UnusableConnectionError("This cloud host isn't set up on this device", null);
    }
    const trusted = binding.trustedHostKey?.key ?? null;
    if (trusted && scanned.includes(trusted)) {
      if (binding.offeredHostKey) {
        this.deps.store.updateBinding(bindingId, (current) => ({
          ...current,
          offeredHostKey: null,
        }));
      }
      return trusted;
    }
    if (!trusted && vouched && scanned.includes(vouched)) {
      this.deps.store.updateBinding(bindingId, (current) =>
        current.trustedHostKey
          ? current
          : {
              ...current,
              trustedHostKey: { key: vouched, at: this.now() },
              offeredHostKey: null,
            }
      );
      // The person may have trusted another key in the moment since it was read.
      const settled = this.deps.store.binding(bindingId)?.trustedHostKey?.key ?? null;
      if (settled === vouched) return vouched;
      throw new TransportError("The trusted host key changed while it was pinned", null);
    }
    if (!trusted && vouched && scanned.length > 0) {
      // Two authenticated answers disagree about the machine: neither is offered to trust,
      // and nor is a key it presented before.
      if (this.deps.store.binding(bindingId)?.offeredHostKey) {
        this.deps.store.updateBinding(bindingId, (current) => ({
          ...current,
          offeredHostKey: null,
        }));
      }
      const said =
        "The machine presented a host key that isn't the one its provider reports for it, so Daintree won't connect to it. Delete the machine if you can't explain the difference.";
      this.recordError(bindingId, { code: "ssh-authorization", message: said, at: this.now() });
      throw new UnusableConnectionError(said, said);
    }
    const candidate = scanned[0];
    if (!candidate) {
      // Most often an sshd still coming up: the link tries again.
      throw new TransportError(
        "The cloud machine didn't present a host key",
        "The machine's SSH server didn't answer with a host key."
      );
    }
    const type = candidate.split(" ")[0];
    if (scanned.some((key) => key !== candidate && key.split(" ")[0] === type)) {
      const said =
        "The machine presented two different host keys of the same kind, so Daintree can't tell which is its own.";
      throw new UnusableConnectionError(said, said);
    }
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: null,
      offeredHostKey:
        current.offeredHostKey?.key === candidate
          ? current.offeredHostKey
          : { key: candidate, at: this.now() },
    }));
    const said = trusted
      ? "This machine's identity changed: its host key isn't the one you trusted. Review the new key in the host's details before connecting."
      : "Confirm this machine's host key in the host's details to connect.";
    throw new UnusableConnectionError(said, said);
  }

  /**
   * After ssh refused the machine's key on a dial: the key changed since it
   * was last looked at. It is looked at again, so the refusal names the
   * change and offers the new key for review; when the machine still presents
   * the trusted key, ssh's own refusal stands.
   */
  async recheckHostKey(bindingId: string, signal?: AbortSignal): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding) return;
    if (this.deps.accounts.providerUnavailable(binding.providerId) !== null) return;
    if (!confirmsHostKeys(this.deps.accounts.provider(binding.providerId))) return;
    // A resolution already under way may have chosen the old access before the
    // refusal; joining it would skip the look. It settles first.
    const cancelled = () => new TransportError("Cancelled", null);
    let pending: Promise<CloudSshRoute> | undefined;
    while ((pending = this.accessInFlight.get(bindingId))) {
      const settling = pending;
      // This dial may give up while it waits; the shared resolution carries on.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(cancelled());
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        void settling
          .catch(() => {})
          .then(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          });
      });
    }
    if (signal?.aborted) throw cancelled();
    // No await from here into ensureAccess: the resolution it starts reads the cleared access.
    this.deps.store.updateBinding(bindingId, (current) => ({ ...current, access: null }));
    await this.ensureAccess(bindingId, signal);
  }

  /**
   * The person trusts the key a machine presented, by the fingerprint they
   * were shown: a key that changed again since then is refused, never pinned
   * unseen. The next dial pins it, on a fresh ssh master.
   */
  async trustHostKey(hostId: unknown, fingerprint: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    const provider = this.deps.accounts.provider(binding.providerId);
    if (!confirmsHostKeys(provider)) {
      throw invalid(
        `${nameOf(provider)} vouches for its machines' host keys; there's none to confirm.`
      );
    }
    const offered = binding.offeredHostKey;
    if (!offered) throw invalid("There's no new host key to trust. Connect again to look at it.");
    if (typeof fingerprint !== "string" || hostKeyFingerprint(offered.key) !== fingerprint) {
      throw invalid(
        "The machine's host key changed again since it was shown. Review the key it presents now."
      );
    }
    this.deps.store.updateBinding(binding.id, (current) =>
      current.offeredHostKey?.key === offered.key
        ? {
            ...current,
            trustedHostKey: { key: offered.key, at: this.now() },
            offeredHostKey: null,
            access: null,
          }
        : current
    );
  }

  /** Reaching the machine worked: what last stood in its way no longer does. */
  private clearAccessErrors(bindingId: string): void {
    const code = this.deps.store.binding(bindingId)?.lastError?.code;
    if (code !== "ssh-authorization" && code !== "ssh-tunnel-command-missing") return;
    this.deps.store.updateBinding(bindingId, (current) =>
      current.lastError?.code === code ? { ...current, lastError: null } : current
    );
  }

  /**
   * Whether the provider's tunnel command is on this device's PATH, for the
   * create dialog to wait on; null when its machines need no tunnel.
   */
  async findTunnel(providerId: unknown): Promise<CloudTunnelLookup | null> {
    if (!isCloudProviderId(providerId)) throw invalid("Choose a cloud provider.");
    const provider = this.deps.accounts.requireSupported(providerId);
    const { tunnel } = provider.info(process.platform).capabilities;
    if (!tunnel) return null;
    const problem = await this.tunnelProblem(provider, "check again");
    if (problem && !problem.missing) {
      throw new AppError({ code: "INTERNAL", message: problem.said, userMessage: problem.said });
    }
    return { command: tunnel.command, found: problem === null };
  }

  /**
   * What stands between this device and the provider's machines before one is
   * made: null when they need no tunnel or its command is on PATH. `missing`
   * is a lookup that finished without finding it; one that ran out of time
   * proves nothing, so it says so instead of asking for an install.
   */
  private async tunnelProblem(
    provider: CloudProvider,
    then: string
  ): Promise<{ missing: boolean; said: string } | null> {
    const info = provider.info(process.platform);
    const { tunnel } = info.capabilities;
    if (!tunnel) return null;
    let found: string | null;
    try {
      found = await (this.deps.findCommand ?? findTunnelCommand)(tunnel.command);
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      return { missing: false, said: error.detail ?? error.message };
    }
    return found ? null : { missing: true, said: tunnelMissingMessage(info.name, tunnel, then) };
  }

  /**
   * How the provider says its machines are reached and trusted, with its
   * tunnel's command found on this device. A missing command is the person's
   * to install, so the host names it and where to get it instead of letting
   * ssh fail without saying why.
   */
  private async sshPolicy(
    bindingId: string,
    provider: CloudProvider
  ): Promise<{ trust: CloudSshTrust; tunnel: CloudSshResolvedTunnel | null }> {
    const info = provider.info(process.platform);
    const { capabilities } = info;
    const problem = sshDeclarationProblem(capabilities);
    if (problem) {
      // Registration refuses these, so only a provider whose description changed since gets here.
      const said = `${info.name} machines can't be reached: ${problem}`;
      throw new UnusableConnectionError(said, said);
    }
    if (!capabilities.tunnel) return { trust: capabilities.sshTrust, tunnel: null };
    const { command, args } = capabilities.tunnel;
    const missingCode: CloudHostErrorCode = "ssh-tunnel-command-missing";
    const lastError = this.deps.store.binding(bindingId)?.lastError ?? null;
    const commandPath = await (this.deps.findCommand ?? findTunnelCommand)(command);
    if (!commandPath) {
      const said = tunnelMissingMessage(info.name, capabilities.tunnel, "connect again");
      if (lastError?.code !== missingCode || lastError.message !== said) {
        this.recordError(bindingId, { code: missingCode, message: said, at: this.now() });
      }
      throw new UnusableConnectionError(said, said);
    }
    return { trust: capabilities.sshTrust, tunnel: { commandPath, args: [...args] } };
  }

  /**
   * For a machine Daintree created on a provider that takes the key at create:
   * the account key to put on it before it is reached, or null when it holds
   * the key on disk. A key lost since its create is made again when the
   * provider can put one on a machine that exists; for any other provider the
   * dial is refused, saying the key is missing, and no key is made (#17929).
   */
  private async keyToPutOn(
    bindingId: string,
    provider: CloudProvider,
    binding: StoredCloudBinding
  ): Promise<string | null> {
    if (binding.ownership === "imported" || sshKeyTiming(provider) !== "at-create") return null;
    // A host removed while the dial waited takes its account's key with it: none is made for it.
    const stillHere = () => {
      if (!this.deps.store.binding(bindingId)) {
        throw new UnusableConnectionError("This cloud host isn't set up on this device", null);
      }
    };
    stillHere();
    const refuse = (said: string): never => {
      const last = this.deps.store.binding(bindingId)?.lastError;
      if (last?.code !== "ssh-authorization" || last.message !== said) {
        this.recordError(bindingId, { code: "ssh-authorization", message: said, at: this.now() });
      }
      throw new UnusableConnectionError(said, said);
    };
    if (typeof provider.authorizeSsh !== "function") {
      let present: boolean;
      try {
        present = await this.deps.files.hasKey(binding.accountId);
      } catch (error) {
        return refuse(
          `SSH access couldn't be set up: ${formatErrorMessage(error, "the SSH key couldn't be read")}`
        );
      }
      stillHere();
      if (present) return null;
      return refuse(
        `This host's SSH key is missing from this device. ${nameOf(provider)} only gives a machine its key when it's created, so Daintree can't give this one a new key. Restore the key from a backup and connect again, or create a new machine.`
      );
    }
    let publicKey: string;
    try {
      publicKey = await this.deps.files.publicKey(binding.accountId);
    } catch (error) {
      return refuse(
        `SSH access couldn't be set up: this account's SSH key couldn't be made (${formatErrorMessage(error, "ssh-keygen failed")})`
      );
    }
    stillHere();
    return this.heldKeys.get(bindingId) === keyIdentity(publicKey) ? null : publicKey;
  }

  /**
   * A machine that took the account's key at create, and still holds it, is
   * only asked how to reach it; any other has the key (`rekey` when it was
   * already read) authorized on it first.
   */
  private async sshAccessFor(
    provider: CloudProvider,
    credentials: ProviderCredentials,
    binding: StoredCloudBinding,
    rekey: string | null
  ): Promise<ProviderSshAccess> {
    const timing = sshKeyTiming(provider);
    const problem = sshKeyContractProblem(provider, timing);
    if (problem) throw new Error(`${nameOf(provider)} ${problem}`);
    // A machine Daintree didn't create never took the key; a provider that can put it there does.
    const keyedAtCreate =
      timing === "at-create" &&
      (binding.ownership !== "imported" || typeof provider.authorizeSsh !== "function");
    if (keyedAtCreate && rekey === null)
      return provider.sshAccess!(credentials, binding.resourceId!);
    const publicKey = rekey ?? (await this.deps.files.publicKey(binding.accountId));
    return provider.authorizeSsh!(credentials, binding.resourceId!, publicKey);
  }

  /** A stable key for one resolution of access: a new one means a new transport. */
  accessGeneration(bindingId: string): string | null {
    const access = this.deps.store.binding(bindingId)?.access;
    if (!access) return null;
    return (
      this.writtenRoutes.get(bindingId) ??
      routeGeneration({
        user: access.user,
        endpoint: { host: access.host, port: access.port },
        hostKey: access.hostKey,
        tunnel: null,
      })
    );
  }

  // --- Operations and observation ----------------------------------------

  /**
   * Runs `work` as the machine's one operation, or joins the same kind under
   * way. `accepted` runs only when a new operation is admitted, before any of
   * its work: a refused or joining caller changes nothing it records.
   */
  private operate(
    bindingId: string,
    kind: CloudOperationKind,
    work: (signal: AbortSignal) => Promise<void>,
    accepted?: () => void
  ): Promise<void> {
    const running = this.operations.get(bindingId);
    if (running) {
      if (running.kind === kind) return running.promise;
      throw new AppError({
        code: "VALIDATION",
        message: `A ${running.kind} operation is under way`,
        userMessage: `The machine is ${running.kind === "creating" ? "being created" : running.kind} already. Wait for it to finish.`,
      });
    }
    if (this.disposed)
      return Promise.reject(new AppError({ code: "CANCELLED", message: "Stopping" }));
    this.admitted.set(bindingId, (this.admitted.get(bindingId) ?? 0) + 1);
    accepted?.();
    const controller = new AbortController();
    const operation = {
      id: crypto.randomUUID(),
      kind,
      startedAt: this.now(),
      stage: "",
      controller,
    } as RunningOperation;
    operation.promise = (async () => {
      try {
        await work(controller.signal);
        // It worked: anything it recorded on the way (a save the provider retried) is history now.
        this.deps.store.updateBinding(bindingId, (current) =>
          current.lastError && current.lastError.at >= operation.startedAt
            ? { ...current, lastError: null }
            : current
        );
      } finally {
        if (this.operations.get(bindingId) === operation) this.operations.delete(bindingId);
        this.nextPollAt.delete(bindingId);
        this.deps.changed();
      }
    })();
    this.operations.set(bindingId, operation);
    this.deps.changed();
    return operation.promise;
  }

  private stage(bindingId: string, stage: string): void {
    const operation = this.operations.get(bindingId);
    if (!operation || operation.stage === stage) return;
    operation.stage = stage;
    this.deps.changed();
  }

  private recordError(bindingId: string, error: CloudHostError): void {
    this.deps.store.updateBinding(bindingId, (current) => ({ ...current, lastError: error }));
  }

  private ticket(): number {
    return ++this.lastTicket;
  }

  /** Whether a newer request's answer was written while the one with this ticket was out. */
  private overtaken(bindingId: string, ticket: number): boolean {
    return ticket <= (this.observedTicket.get(bindingId) ?? 0);
  }

  /** Writes the answer to the request sent with this ticket, unless a newer one was written; false then. */
  private observe(
    bindingId: string,
    resource: ProviderResource,
    ticket: number,
    extra?: (binding: StoredCloudBinding) => StoredCloudBinding
  ): boolean {
    if (this.overtaken(bindingId, ticket)) return false;
    let started = false;
    const written = this.deps.store.updateBinding(bindingId, (current) => {
      const before = current.observation;
      // Any stop, or a start seen from outside, may bring a new address or
      // host key: access is resolved again for the next dial.
      const restarted =
        resource.machine !== "running" ||
        (before !== null && before.machine !== "running") ||
        (before?.stoppedAt ?? null) !== resource.stoppedAt;
      if (restarted) this.renewals.delete(bindingId);
      started = before !== null && restarted && resource.machine === "running";
      const next: StoredCloudBinding = {
        ...current,
        access: restarted ? null : current.access,
        observation: observationOf(resource, this.now()),
      };
      return extra ? extra(next) : next;
    });
    // A binding forgotten while the request was out keeps no mark behind.
    if (!written) return false;
    this.observedTicket.set(bindingId, ticket);
    // Whoever's read shows the deadline moved, or the run ending, settles an earlier failure to move it.
    if (this.renewalSettled(bindingId)) this.clearRenewalError(bindingId);
    if (started && written.hostId) this.deps.onMachineStarted?.(written.hostId);
    return true;
  }

  /** Writes a not-found answer to the request sent with this ticket, unless a newer one was written. */
  private observeMissing(bindingId: string, described: CloudHostError, ticket: number): void {
    if (this.overtaken(bindingId, ticket)) return;
    // Not proof of deletion (a scope or key change looks the same): say what was seen.
    const written = this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      observation: current.observation
        ? { ...current.observation, machine: "unknown", observedAt: this.now() }
        : null,
      lastError: described,
    }));
    if (written) this.observedTicket.set(bindingId, ticket);
  }

  /**
   * Reads the machine into its binding. Null when a request sent after this
   * one was answered first: the binding already holds the newer word, and this
   * answer, or failure to get one, is left out.
   */
  private async inspectInto(
    bindingId: string,
    provider: CloudProvider,
    credentials: ProviderCredentials
  ): Promise<ProviderResource | null> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) throw new Error("No machine");
    const ticket = this.ticket();
    let resource: ProviderResource;
    try {
      resource = await provider.inspect(credentials, binding.resourceId);
    } catch (error) {
      if (this.overtaken(bindingId, ticket)) return null;
      const described = provider.describeError(error);
      if (described.code === "not-found") this.observeMissing(bindingId, described, ticket);
      throw error;
    }
    // An answer supersedes an earlier failure to get one; a refused start or stop stays.
    const written = this.observe(bindingId, resource, ticket, (current) =>
      current.lastError && INSPECTION_ERRORS.has(current.lastError.code)
        ? { ...current, lastError: null }
        : current
    );
    return written ? resource : null;
  }

  private async waitFor(
    bindingId: string,
    target: "running" | "stopped",
    deadlineMs: number,
    signal: AbortSignal,
    stage: string
  ): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) throw new Error("No machine");
    const { provider, credentials } = await this.context(binding, signal);
    const deadline = this.now() + deadlineMs;
    this.stage(bindingId, stage);
    for (;;) {
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
      let resource: ProviderResource | null = null;
      const ticket = this.ticket();
      try {
        const answer = await provider.inspect({ ...credentials, signal }, binding.resourceId);
        if (this.observe(bindingId, answer, ticket)) resource = answer;
      } catch (error) {
        if (signal.aborted) throw error;
        const described = provider.describeError(error);
        if (described.code !== "provider-unreachable" && !this.overtaken(bindingId, ticket)) {
          if (described.code === "not-found") this.observeMissing(bindingId, described, ticket);
          else this.recordError(bindingId, described);
          throw this.deps.accounts.asAppError(provider, error);
        }
      }
      // Overtaken by a newer read: its word stands for this round.
      if (!resource && this.overtaken(bindingId, ticket)) {
        const current = this.deps.store.binding(bindingId);
        if (current && machineOf(current) === target) return;
      }
      if (resource) {
        if (resource.machine === target) return;
        if (resource.machine === "error" || resource.machine === "deleted") {
          const message =
            resource.error ??
            (resource.machine === "deleted" ? "The machine was removed." : "The machine failed.");
          this.recordError(bindingId, { code: "failed", message, at: this.now() });
          throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
        }
        if (target === "stopped" && resource.stop?.status === "failing") {
          this.stage(
            bindingId,
            `${nameOf(provider)} is retrying the save: ${resource.stop.error ?? "the disk couldn't be saved yet"}`
          );
          this.recordError(bindingId, {
            code: "stop-failing",
            message: `${nameOf(provider)} couldn't save the disk yet and keeps the machine running while it retries${resource.stop.error ? ` (${resource.stop.error})` : ""}. ${provider.info(process.platform).capabilities.persistence.saveRetryBilled ? "That time is billed." : "It isn't billed for that time."}`,
            at: this.now(),
          });
        }
      }
      if (this.now() > deadline) {
        const message =
          target === "running"
            ? "The machine didn't come up in time. It may still be starting; check again shortly."
            : `The machine hasn't finished stopping yet. ${nameOf(provider)} keeps working on it.`;
        this.recordError(bindingId, { code: "outcome-unknown", message, at: this.now() });
        throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
      }
      await this.sleep(TRANSITION_POLL_MS, signal);
    }
  }

  /**
   * The lifetime keeper. A machine's provider-side lifetime is the guard
   * against one left running; while this device is using it (its link is up
   * and its agents are working or waiting there, or a window shows it), the
   * guard mustn't cut that work off, so the deadline is moved forward before
   * it comes. Nothing is renewed for a machine nobody here uses: with the
   * desktop gone, it stops by itself at the end of its lifetime, saving its
   * disk. Runs on a timer; exposed for tests.
   */
  async renewDue(): Promise<void> {
    if (this.disposed || !this.deps.activity || this.renewingAll) return;
    this.renewingAll = true;
    try {
      for (const binding of this.deps.store.bindings()) {
        if (this.disposed) return;
        if (!this.renewalDue(binding.id)) continue;
        const attempt = this.renew(binding.id);
        this.renewInFlight.set(binding.id, attempt);
        try {
          await attempt;
        } finally {
          if (this.renewInFlight.get(binding.id) === attempt) this.renewInFlight.delete(binding.id);
        }
      }
    } finally {
      this.renewingAll = false;
    }
  }

  /** Whether the machine is in use here, running, idle of operations, and near its deadline. */
  private renewalDue(bindingId: string): boolean {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId || !binding.hostId || binding.lifetimeSeconds === null) return false;
    if (binding.intent === "stop" || this.operations.has(binding.id)) return false;
    // A stop under way, the machine's own or anyone's, isn't undone by renewing.
    if (stopUnderWay(binding.observation?.stop)) return false;
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return false;
    // Only a deadline the provider can move: a fixed limit, an idle sleep or none has nothing to renew.
    if (!canRenewLifetime(this.deps.accounts.provider(binding.providerId))) return false;
    if (machineOf(binding) !== "running") return false;
    const activity = this.deps.activity?.(binding.hostId);
    if (!activity?.connected || !(activity.busy || activity.shown)) return false;
    const deadline = Date.parse(binding.observation?.autoStopAt ?? "");
    if (!Number.isFinite(deadline)) return false;
    const now = this.now();
    if (!lifetimeRenewalDue(now, deadline, binding.lifetimeSeconds)) return false;
    const last = this.renewals.get(binding.id);
    return !(last && !last.ok && now - last.at < RENEW_RETRY_MS);
  }

  private async renew(bindingId: string): Promise<void> {
    const binding = this.deps.store.binding(bindingId)!;
    const lifetimeSeconds = binding.lifetimeSeconds;
    // renewalDue just found it registered; one that left since has nothing to renew and failed nothing.
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return;
    const provider = this.deps.accounts.provider(binding.providerId);
    if (!canRenewLifetime(provider)) return;
    let credentials: ProviderCredentials;
    try {
      ({ credentials } = await this.context(binding));
      // What the provider says now, not what was last seen: the machine's own
      // keeper may have moved the deadline, or begun stopping it (#17361).
      // A read that fails isn't a failed renewal: nothing was sent, and its
      // own error (a machine not found) stays as the read recorded it.
      if (!this.renewalDue(bindingId) || !this.stillRegistered(binding.providerId, provider)) {
        return;
      }
      await this.inspectInto(bindingId, provider, credentials);
    } catch {
      if (!this.disposed) this.renewals.set(bindingId, { at: this.now(), ok: false });
      return;
    }
    // A stop, a start or a new lifetime meanwhile wins. So does the provider
    // leaving, another registering in its place, or this run ending.
    if (this.disposed || !this.stillRegistered(binding.providerId, provider)) return;
    if (!this.renewalDue(bindingId)) {
      // Moved, or stopped, by someone else: an earlier failure to move it is no longer news.
      if (this.renewalSettled(bindingId)) this.clearRenewalError(bindingId);
      return;
    }
    try {
      const ticket = this.ticket();
      const renewed = await provider.renewLifetime(
        credentials,
        binding.resourceId!,
        lifetimeSeconds
      );
      // The answer of a provider that left or was replaced meanwhile is about a machine it no longer speaks for.
      if (!this.stillRegistered(binding.providerId, provider)) return;
      const current = this.deps.store.binding(bindingId);
      if (!current || current.intent === "stop" || this.operations.has(bindingId)) return;
      this.observe(bindingId, renewed, ticket);
      this.renewals.set(bindingId, { at: this.now(), ok: true });
      // A renewal that failed earlier and now went through is no longer news.
      this.clearRenewalError(bindingId);
      this.deps.changed();
    } catch (error) {
      if (this.disposed || this.deps.store.binding(bindingId)?.intent === "stop") return;
      if (!this.stillRegistered(binding.providerId, provider)) return;
      this.renewals.set(bindingId, { at: this.now(), ok: false });
      // Refused because the machine had begun stopping by itself, or someone
      // else moved the deadline meanwhile: that is no failure to report.
      if (await this.settledMeanwhile(bindingId, provider, credentials)) return;
      const described = provider.describeError(error);
      this.recordError(bindingId, {
        code: "lifetime-renewal",
        message: `Couldn't keep the machine running past its lifetime: ${described.message} It stops by itself at the deadline unless this succeeds.`,
        at: described.at,
      });
    }
  }

  /**
   * The provider last said the run is ending or over, or its deadline is well
   * off: positive evidence only, never a state it couldn't read.
   */
  private renewalSettled(bindingId: string): boolean {
    const binding = this.deps.store.binding(bindingId);
    const observation = binding?.observation;
    if (!binding || !observation) return false;
    const machine = machineOf(binding);
    if (
      machine === "stopping" ||
      machine === "stopped" ||
      machine === "deleted" ||
      stopUnderWay(observation.stop)
    ) {
      return true;
    }
    if (machine !== "running") return false;
    const deadline = Date.parse(observation.autoStopAt ?? "");
    return (
      binding.lifetimeSeconds !== null &&
      Number.isFinite(deadline) &&
      !lifetimeRenewalDue(this.now(), deadline, binding.lifetimeSeconds)
    );
  }

  private clearRenewalError(bindingId: string): void {
    const binding = this.deps.store.binding(bindingId);
    if (binding?.lastError?.code !== "lifetime-renewal") return;
    this.deps.store.updateBinding(bindingId, (latest) =>
      latest.lastError?.code === "lifetime-renewal" ? { ...latest, lastError: null } : latest
    );
    this.deps.changed();
  }

  /** After a failed renewal: whether the provider now says the run is ending, or its deadline moved well off. */
  private async settledMeanwhile(
    bindingId: string,
    provider: CloudProvider,
    credentials: ProviderCredentials
  ): Promise<boolean> {
    try {
      await this.inspectInto(bindingId, provider, credentials);
      return this.renewalSettled(bindingId);
    } catch {
      return false;
    }
  }

  /** The provider is still the one registered under its id: not gone, and not replaced. */
  private stillRegistered(providerId: string, provider: CloudProvider): boolean {
    return (
      !this.deps.accounts.providerUnavailable(providerId) &&
      this.deps.accounts.provider(providerId) === provider
    );
  }

  /** Lets a renewal under way for the machine finish first, so it can't land after this. */
  private async settleRenewal(bindingId: string): Promise<void> {
    await this.renewInFlight.get(bindingId)?.catch(() => {});
  }

  // --- Stopping a machine once idle where it can't stop itself (#17923, #17924)

  /**
   * Whether, and why, this device may stop the machine once its host's idle
   * time ends: only when its provider declares a stop that ends compute
   * billing and keeps the disk, and either none of the provider's machines
   * can stop themselves (a plugin's), or this one's self-stop was refused in
   * a way that leaves that stop, as its keeper found on the current link.
   */
  private idleStopRole(binding: StoredCloudBinding, provider: CloudProvider): IdleStopRole | null {
    if (deleteOnly(provider)) return null;
    const { persistence } = provider.info(process.platform).capabilities;
    if (persistence.stoppedComputeBilled || persistence.retentionDays === 0) return null;
    const keys = provider.machineKeys !== undefined;
    const guest = typeof provider.checkGuestPowerOff === "function";
    if (cloudProviderNamespace(provider.id)?.kind === "plugin")
      return keys || guest ? null : "plugin";
    if (keys) return this.deps.machineKeys?.standsInFor(binding.id) ? "stand-in" : null;
    if (guest) return this.deps.guestPowerOff?.standsInFor(binding.id) ? "stand-in" : null;
    return null;
  }

  /**
   * What this device does once the host's idle time ends, for the host's
   * details: only for a machine it may stop then (`idleStopRole`).
   */
  private linkedIdleStopOf(binding: StoredCloudBinding): CloudLinkedIdleStop | null {
    if (!binding.resourceId || !binding.hostId) return null;
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return null;
    const provider = this.deps.accounts.provider(binding.providerId);
    if (canSleepIdle(provider)) {
      if (!this.deps.idleClaims) return null;
      const unsupportedOn = this.idleUnsupported.get(binding.id);
      return unsupportedOn && unsupportedOn === this.deps.idleClaims.sessionFor(binding.hostId)
        ? { kind: "blocked", problem: IDLE_SLEEP_HOST_TOO_OLD }
        : { kind: "sleeps" };
    }
    if (!this.idleStopRole(binding, provider)) return null;
    const observation = binding.observation;
    // Its own idle sleep is described as its lifetime; this device leaves it to that.
    if (sleepsOnItsOwn(lifetimeModelOf(provider), observation?.idleSleep)) return null;
    if (!observation || observation.snapshotsDisabled === null) return { kind: "unknown" };
    if (observation.snapshotsDisabled) return { kind: "blocked", problem: IDLE_STOP_SNAPSHOTS_OFF };
    const unsupportedOn = this.idleUnsupported.get(binding.id);
    if (unsupportedOn && unsupportedOn === this.deps.idleClaims?.sessionFor(binding.hostId)) {
      return { kind: "blocked", problem: IDLE_STOP_HOST_TOO_OLD };
    }
    return { kind: "stops" };
  }

  /**
   * The desktop's idle stop. A plugin provider's machine can't stop itself,
   * and one whose self-stop was refused in a way that leaves an API stop
   * doesn't (#17924), so while this device is linked to its host and the host
   * says its idle time ended, this device reads the machine, asks the host
   * for that idle time (#17922), and on the grant stops it with the
   * provider's normal stop, sent once. With every device away nothing stops
   * it. A machine whose provider's own idle timer the link keeps from running
   * is put to sleep the same way instead, and has its own idle timeout kept
   * at the host's (#17916). Runs on the keeper's timer, which runs only while
   * some machine is bound to a host; exposed for tests.
   */
  async stopIdleDue(): Promise<void> {
    if (this.disposed || !this.deps.idleClaims) return;
    const attempts: Promise<void>[] = [];
    for (const binding of this.deps.store.bindings()) {
      if (this.idleAttempts.has(binding.id)) continue;
      let run: (() => Promise<void>) | null = null;
      try {
        this.keepIdleTime(binding);
        const sleep = this.idleSleepDue(binding);
        const stop = sleep ? null : this.idleStopDue(binding);
        if (sleep) run = () => this.sleepOnIdleClaim(binding.id, sleep);
        else if (stop) run = () => this.stopOnIdleClaim(binding.id, stop);
      } catch {
        // A summary or link that couldn't be read is looked at again on the next pass.
        continue;
      }
      if (!run) continue;
      const attempt: Promise<void> = run()
        .catch(() => {
          // What went wrong is recorded where it matters; the next idle time is asked about afresh.
        })
        .finally(() => {
          if (this.idleAttempts.get(binding.id) === attempt) this.idleAttempts.delete(binding.id);
        });
      this.idleAttempts.set(binding.id, attempt);
      attempts.push(attempt);
    }
    await Promise.all(attempts);
  }

  /**
   * Whether nothing here stands in the way of the machine being stopped once
   * idle: no operation, removal, renewal or cleanup, and running with no stop
   * under way. What the person last asked of it doesn't count: a Stop they
   * chose long ago says nothing about a machine started again since.
   */
  private idleStopFree(binding: StoredCloudBinding): boolean {
    if (this.operations.has(binding.id) || this.removing.has(binding.id)) return false;
    if (this.renewInFlight.has(binding.id) || this.cleanupRuns.has(binding.id)) return false;
    if (binding.worktreeCleanup?.phase === "due") return false;
    return machineOf(binding) === "running" && !stopUnderWay(binding.observation?.stop);
  }

  /** Nothing the provider last said of the machine rules a stop out: its disk survives, and it doesn't sleep by itself. */
  private idleStopSafe(binding: StoredCloudBinding, provider: CloudProvider): boolean {
    const observation = binding.observation;
    if (observation?.snapshotsDisabled === true || observation?.dataExpired) return false;
    return !sleepsOnItsOwn(lifetimeModelOf(provider), observation?.idleSleep);
  }

  /** The host's link to ask on, when its idle time ended by its last summary there and wasn't asked about yet. */
  private idleStopDue(binding: StoredCloudBinding): IdleStopDue | null {
    const hostId = binding.hostId;
    if (!binding.resourceId || !hostId || !this.idleStopFree(binding)) return null;
    // Cheap checks first: a device with no such machine reads no link or summary for it.
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return null;
    const provider = this.deps.accounts.provider(binding.providerId);
    const role = this.idleStopRole(binding, provider);
    if (!role || !this.idleStopSafe(binding, provider)) return null;
    const session = this.deps.idleClaims?.sessionFor(hostId) ?? null;
    if (!session?.isOpen || !this.boundTo(hostId, binding.id)) return null;
    if (this.idleUnsupported.get(binding.id) === session) return null;
    const heard = this.deps.idleClaims?.idleOn(hostId, session) ?? null;
    if (!heard) return null;
    const { idle, sampledAt } = heard;
    // The host's own word on its own clock; one that stops its machine itself needs nothing from here.
    if (idle.busy || idle.stopsWhenIdle || idle.idleEndsAt === null) return null;
    if (idle.idleEndsAt > sampledAt) return null;
    // New work moves when it was last seen; a changed setting is another idle time to ask about.
    const interval = `${idle.lastWorkAt}:${idle.idleAfterMinutes}`;
    const asked = this.idleAsked.get(binding.id);
    if (asked?.session === session && asked.interval === interval) return null;
    return { hostId, session, interval, provider, role };
  }

  /** Whether the machine's keepers last found a reason it can't stop itself. */
  private hasSelfStopProblem(bindingId: string): boolean {
    return (
      (this.deps.machineKeys?.problemFor(bindingId) ??
        this.deps.guestPowerOff?.problemFor(bindingId)) != null
    );
  }

  /** The host is still this binding's: its connection names it, and it names the host. */
  private boundTo(hostId: HostId, bindingId: string): boolean {
    const connection = this.deps.hosts.get(hostId)?.connection;
    return connection?.kind === "cloud" && connection.bindingId === bindingId;
  }

  /**
   * One idle time, once: reads the machine, then asks the host for the idle
   * time, and stops the machine in the same turn the grant arrives. The idle
   * time is spent here once the machine reads as one to ask about, whatever
   * the provider or the host says next.
   */
  private async stopOnIdleClaim(bindingId: string, due: IdleStopDue): Promise<void> {
    const { hostId, session, interval, provider, role } = due;
    const resourceId = this.deps.store.binding(bindingId)?.resourceId;
    if (!resourceId) return;
    const admitted = this.admitted.get(bindingId) ?? 0;
    // Whatever changed while this read or asked wins: an operation, a removal, another link or provider.
    const holds = () => {
      if (this.disposed) return false;
      const binding = this.deps.store.binding(bindingId);
      if (!binding || binding.hostId !== hostId || binding.resourceId !== resourceId) return false;
      if ((this.admitted.get(bindingId) ?? 0) !== admitted || !this.idleStopFree(binding)) {
        return false;
      }
      // A newer read while the host decided may have turned snapshots off or sleeping on.
      if (!this.idleStopSafe(binding, provider)) return false;
      if (!this.stillRegistered(binding.providerId, provider) || !this.boundTo(hostId, bindingId)) {
        return false;
      }
      return session.isOpen && this.deps.idleClaims?.sessionFor(hostId) === session;
    };
    // Until the claim goes out, the machine's keeper still finds it one to stop from here.
    const admits = () => {
      const binding = this.deps.store.binding(bindingId);
      return Boolean(binding && this.idleStopRole(binding, provider) === role);
    };
    // Once granted, a self-stop accepted meanwhile can't take that idle time back, so the stop
    // goes; a refusal that no longer leaves a stop from here (the machine turned unsuitable) wins.
    const withdrawn = () => role === "stand-in" && !admits() && this.hasSelfStopProblem(bindingId);
    await this.settleRenewal(bindingId);
    const binding = this.deps.store.binding(bindingId);
    if (!binding || !holds() || !admits()) return;
    const { credentials } = await this.context(binding);
    if (!holds() || !admits()) return;
    // Snapshots aren't kept with what was last seen from before it: the provider's word now decides.
    const resource = await this.inspectInto(bindingId, provider, credentials);
    if (!resource || !holds() || !admits()) return;
    if (
      resource.machine !== "running" ||
      stopUnderWay(resource.stop) ||
      resource.snapshotsDisabled ||
      resource.restricted ||
      resource.dataExpired ||
      resource.asleep === true ||
      sleepsOnItsOwn(lifetimeModelOf(provider), resource.idleSleep)
    ) {
      return;
    }
    if (role === "stand-in" && typeof provider.checkGuestPowerOff === "function") {
      // Found fit up to half an hour ago; a machine that joined a group since isn't stopped from here.
      const check = await provider.checkGuestPowerOff(credentials, resourceId);
      if (!check.eligible) {
        // Its keeper looks again now, behind any look under way, whatever changed meanwhile (an
        // older answer may have armed its host): it says why, and takes the permission back.
        void this.deps.guestPowerOff?.arm(hostId, session, { again: true });
        return;
      }
      if (!holds() || !admits()) return;
    }
    // Asked once from here, whatever the host answers or however its answer is lost.
    const asked = { session, interval };
    this.idleAsked.set(bindingId, asked);
    let outcome: HostIdleClaimOutcome<{ stopping: Promise<void> } | null>;
    try {
      outcome = await withHostIdleClaim(
        hostId,
        session,
        (id) => this.deps.idleClaims?.sessionFor(id) ?? null,
        () => {
          // Granted: nothing may come between this and the stop going out.
          if (!holds() || withdrawn()) return null;
          const stopping = this.operate(bindingId, "stopping", (signal) =>
            this.runIdleStop(bindingId, provider, credentials, resourceId, signal)
          );
          this.idleStops.set(bindingId, stopping);
          // Awaited below; its failure is recorded on the machine, never left unheard meanwhile.
          stopping
            .catch(() => {})
            .finally(() => {
              if (this.idleStops.get(bindingId) === stopping) this.idleStops.delete(bindingId);
            });
          this.stage(bindingId, "Saving the disk and stopping");
          return { stopping };
        },
        // Standing in, the host keeps the idle time for a keeper that now stops the machine itself.
        { standIn: role === "stand-in" }
      );
    } catch (error) {
      // Refused before it left this device: the host never heard it, so it may be asked again.
      const code =
        typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
      if (code === "RATE_LIMITED" && this.idleAsked.get(bindingId) === asked) {
        this.idleAsked.delete(bindingId);
      }
      throw error;
    }
    if (outcome.kind === "unsupported") {
      this.idleUnsupported.set(bindingId, session);
      this.deps.changed();
      return;
    }
    if (outcome.kind === "claimed" && outcome.result) await outcome.result.stopping;
  }

  /** The provider's normal stop, sent once, then followed until the machine stops. */
  private async runIdleStop(
    bindingId: string,
    provider: CloudProvider,
    credentials: ProviderCredentials,
    resourceId: string,
    signal: AbortSignal
  ): Promise<void> {
    if (typeof provider.stop !== "function") throw noStopOrStart(provider);
    const ticket = this.ticket();
    let answer: ProviderResource | null;
    try {
      // Once: by a resend, new work may have ended the idle time it was granted on.
      answer = await provider.stop({ ...credentials, signal }, resourceId, { once: true });
    } catch (error) {
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
      this.requireStillRegistered(provider);
      await this.settleIdleStop(
        bindingId,
        provider,
        credentials,
        provider.describeError(error),
        signal
      );
      return;
    }
    this.requireStillRegistered(provider);
    if (answer) this.observe(bindingId, answer, ticket);
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: null,
      lastError: null,
    }));
    await this.waitFor(
      bindingId,
      "stopped",
      STOP_DEADLINE_MS,
      signal,
      "Saving the disk and stopping"
    );
  }

  /**
   * A provider that left or was replaced while the stop was out no longer
   * speaks for the machine: never a success, which a Stop joined to it would
   * take. Nothing is kept on the machine: the host already says its provider
   * is unavailable, and the first read once it's back says how it is.
   */
  private requireStillRegistered(provider: CloudProvider): void {
    if (this.stillRegistered(provider.id, provider)) return;
    const message = `${nameOf(provider)} changed while the machine was stopping, so whether it stopped isn't known yet.`;
    throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
  }

  /**
   * An idle stop the provider refused, or whose answer was lost: settled by
   * what the provider says of the machine, never by sending it again. A
   * refusal it named did nothing, so one read settles it. A lost answer is
   * followed while the machine reads as stopping, and for a minute while it
   * still reads as anything else; the background poll goes on reading after that.
   */
  private async settleIdleStop(
    bindingId: string,
    provider: CloudProvider,
    credentials: ProviderCredentials,
    described: CloudHostError,
    signal: AbortSignal
  ): Promise<void> {
    const refused = DEFINITE_REFUSALS.has(described.code);
    const givesUpAt = this.now() + (refused ? 0 : LOST_STOP_SETTLE_MS);
    let answered = false;
    for (;;) {
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
      // Overtaken by a newer read counts as read: the binding holds that newer word.
      let read = true;
      try {
        await this.inspectInto(bindingId, provider, { ...credentials, signal });
      } catch {
        if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
        read = false;
      }
      answered ||= read;
      // A read from a provider that left meanwhile settles nothing for whoever joined this stop.
      this.requireStillRegistered(provider);
      const binding = this.deps.store.binding(bindingId);
      if (!binding) return;
      const machine = machineOf(binding);
      if (read && machine === "stopped") {
        this.deps.store.updateBinding(bindingId, (current) => ({ ...current, access: null }));
        return;
      }
      // Stopping, saving, failed or gone after a lost answer: followed, and reported, as any stop
      // is. A refusal the provider named did nothing, whatever else is under way.
      if (
        !refused &&
        read &&
        (machine === "stopping" ||
          machine === "error" ||
          machine === "deleted" ||
          stopUnderWay(binding.observation?.stop))
      ) {
        await this.waitFor(
          bindingId,
          "stopped",
          STOP_DEADLINE_MS,
          signal,
          "Saving the disk and stopping"
        );
        return;
      }
      if (refused || this.now() >= givesUpAt) {
        const error: CloudHostError = refused
          ? {
              code: described.code,
              message: `${nameOf(provider)} didn't stop the machine once the host's idle time ended: ${asSentence(described.message)}`,
              at: this.now(),
            }
          : {
              code: "outcome-unknown",
              message: `${nameOf(provider)} didn't confirm the stop once the host's idle time ended, and ${answered ? "the machine hadn't read as stopping a minute later" : "the machine couldn't be read for a minute after"}. No second stop was sent.`,
              at: this.now(),
            };
        this.recordError(bindingId, error);
        throw new AppError({
          code: "OUTCOME_UNKNOWN",
          message: error.message,
          userMessage: error.message,
        });
      }
      await this.sleep(TRANSITION_POLL_MS, signal);
    }
  }

  // --- Sleeping a linked machine once idle (#17916) -------------------------

  /** The provider's machines are put to sleep from here once their host is idle. */
  private sleepsOnIdleClaim(providerId: CloudProviderId): boolean {
    return (
      this.deps.accounts.providerUnavailable(providerId) === null &&
      canSleepIdle(this.deps.accounts.provider(providerId))
    );
  }

  /**
   * The host's link to ask on, for a machine whose provider this device puts
   * to sleep, when its idle time ended by its last summary there and wasn't
   * asked about yet. Only one whose own idle sleep is on: one turned off at
   * the provider stays awake until a person picks an idle time here.
   */
  private idleSleepDue(binding: StoredCloudBinding): {
    hostId: HostId;
    session: LinkSession;
    interval: string;
    provider: IdleSleepingCloudProvider;
  } | null {
    const hostId = binding.hostId;
    if (!binding.resourceId || !hostId || !this.idleStopFree(binding)) return null;
    if (this.idleSleeping.has(binding.id)) return null;
    if (binding.observation?.idleSleep?.enabled !== true) return null;
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return null;
    const provider = this.deps.accounts.provider(binding.providerId);
    if (!canSleepIdle(provider)) return null;
    const session = this.deps.idleClaims?.sessionFor(hostId) ?? null;
    if (!session?.isOpen || !this.boundTo(hostId, binding.id)) return null;
    if (this.idleUnsupported.get(binding.id) === session) return null;
    const heard = this.deps.idleClaims?.idleOn(hostId, session) ?? null;
    if (!heard) return null;
    const { idle, sampledAt } = heard;
    if (idle.busy || idle.stopsWhenIdle || idle.idleEndsAt === null) return null;
    if (idle.idleEndsAt > sampledAt) return null;
    const interval = `${idle.lastWorkAt}:${idle.idleAfterMinutes}`;
    const asked = this.idleAsked.get(binding.id);
    if (asked?.session === session && asked.interval === interval) return null;
    return { hostId, session, interval, provider };
  }

  /**
   * One idle time, once: reads the machine, asks the host for the idle time,
   * and sends the provider's sleep in the same turn the grant arrives, then
   * lets go of the link, whose own traffic would otherwise count as activity.
   * No dial resolves access to the machine meanwhile: one would wake it, or
   * reach it just as it goes. What the provider says afterwards settles it,
   * so a busy or lost answer that still meant asleep is asleep, and the sleep
   * is never sent again on the same claim.
   */
  private async sleepOnIdleClaim(
    bindingId: string,
    due: {
      hostId: HostId;
      session: LinkSession;
      interval: string;
      provider: IdleSleepingCloudProvider;
    }
  ): Promise<void> {
    const { hostId, session, interval, provider } = due;
    const resourceId = this.deps.store.binding(bindingId)?.resourceId;
    if (!resourceId) return;
    const admitted = this.admitted.get(bindingId) ?? 0;
    // Whatever changed while this read or asked wins: an operation, a removal, another link or provider.
    const holds = () => {
      if (this.disposed) return false;
      const binding = this.deps.store.binding(bindingId);
      if (!binding || binding.hostId !== hostId || binding.resourceId !== resourceId) return false;
      if ((this.admitted.get(bindingId) ?? 0) !== admitted || !this.idleStopFree(binding)) {
        return false;
      }
      if (!this.stillRegistered(binding.providerId, provider) || !this.boundTo(hostId, bindingId)) {
        return false;
      }
      // A newer read while the host decided may have found its idle sleep turned off there.
      if (binding.observation?.idleSleep?.enabled !== true) return false;
      return session.isOpen && this.deps.idleClaims?.sessionFor(hostId) === session;
    };
    const binding = this.deps.store.binding(bindingId);
    if (!binding || !holds()) return;
    const { credentials } = await this.context(binding);
    if (!holds()) return;
    const resource = await this.inspectInto(bindingId, provider, credentials);
    if (!resource || !holds()) return;
    if (resource.machine !== "running" || resource.idleSleep?.enabled !== true) return;
    const refused = `${nameOf(provider)} didn't put the machine to sleep once the host's idle time ended:`;
    this.idleSleeping.add(bindingId);
    try {
      // A dial already resolving access may hand out a route to the machine as it goes:
      // this idle time is asked about on the next pass instead.
      if (this.accessInFlight.has(bindingId)) return;
      const asked = { session, interval };
      this.idleAsked.set(bindingId, asked);
      let sent = false;
      let failure: unknown = null;
      let outcome: HostIdleClaimOutcome<void>;
      try {
        outcome = await withHostIdleClaim(
          hostId,
          session,
          (id) => this.deps.idleClaims?.sessionFor(id) ?? null,
          () => {
            // Granted: nothing may come between this and the sleep going out.
            if (!holds()) return;
            sent = true;
            const sleeping = provider.sleepIdle(credentials, resourceId);
            this.deps.idleClaims?.release?.(hostId, session);
            return sleeping;
          }
        );
      } catch (error) {
        if (!sent) {
          // Refused before it left this device: the host never heard it, so it may be asked again.
          const code =
            typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
          if (code === "RATE_LIMITED" && this.idleAsked.get(bindingId) === asked) {
            this.idleAsked.delete(bindingId);
          }
          throw error;
        }
        failure = error;
        outcome = { kind: "claimed", result: undefined };
      }
      if (outcome.kind === "unsupported") {
        this.idleUnsupported.set(bindingId, session);
        this.deps.changed();
        return;
      }
      if (outcome.kind !== "claimed" || !sent) return;
      let read = true;
      try {
        await this.inspectInto(bindingId, provider, credentials);
      } catch {
        read = false;
      }
      const observed = this.deps.store.binding(bindingId)?.observation ?? null;
      // Unread, it is asleep only on the provider's own answer to the sleep.
      const asleep = read ? observed?.machine === "stopped" && observed.asleep : failure === null;
      if (asleep) {
        this.deps.store.updateBinding(bindingId, (current) => ({
          ...current,
          access: null,
          // What was read before the sleep no longer stands: the next dial or poll reads it again.
          observation:
            !read && current.observation
              ? { ...current.observation, observedAt: 0 }
              : current.observation,
          lastError: current.lastError?.message.startsWith(refused) ? null : current.lastError,
        }));
        return;
      }
      // The link was let go for a sleep that didn't happen: it comes back, unless a person's
      // Start, Stop or removal came since and decides about the link itself.
      const now = this.deps.store.binding(bindingId);
      if (now?.hostId === hostId && (this.admitted.get(bindingId) ?? 0) === admitted) {
        this.deps.idleClaims?.reconnect?.(hostId);
      }
      if (failure !== null) {
        this.recordError(bindingId, {
          code: provider.describeError(failure).code,
          message: `${refused} ${asSentence(provider.describeError(failure).message)}`,
          at: this.now(),
        });
      }
    } finally {
      this.idleSleeping.delete(bindingId);
    }
  }

  /**
   * A change to a host's settings landed there (#17916). A new idle time
   * becomes its machine's own idle timeout too, and turns the provider's idle
   * sleep on: the person picked it. An imported machine follows the host's
   * from then on.
   */
  idleTimePicked(hostId: HostId, settings: readonly HostSettingLeaf[]): void {
    if (this.disposed) return;
    const minutes = settings.find((leaf) => leaf.key === "hostIdle.idleAfterMinutes")?.value;
    if (!isHostIdleMinutes(minutes)) return;
    const binding = this.deps.store.bindingForHost(hostId);
    if (!binding?.resourceId || !this.sleepsOnIdleClaim(binding.providerId)) return;
    if (!followsHostIdleTime(binding)) {
      this.deps.store.updateBinding(binding.id, (current) => ({
        ...current,
        idleTimeChosen: true,
      }));
    }
    const bindingId = binding.id;
    const seconds = minutes * 60;
    // Turned on by a pick only where it was off; one on then and turned off at the provider
    // since is the newer choice, which a resend never undoes.
    const turnsOn = binding.observation?.idleSleep?.enabled !== true;
    // Until the pick lands, a summary taken before it says nothing about what the host holds.
    this.idleTimeHolds.set(bindingId, {
      until: this.now() + RENEW_RETRY_MS,
      enable: true,
      stuckOn: null,
    });
    // Sends are serialised, so the last pick's hold is the one left standing.
    void this.setIdleTime(bindingId, seconds, true, (sent) => {
      this.idleTimeHolds.set(bindingId, {
        until: this.now() + RENEW_RETRY_MS,
        // Kept until it lands, whatever the provider last said of its idle sleep.
        enable: sent !== "landed" && turnsOn,
        stuckOn: sent === "refused" || sent === "kept-another" ? seconds : null,
      });
    });
  }

  /**
   * Sends the host's idle time, by its summary on the current link, to a
   * machine that follows it and whose own idle sleep is on, or whose pick
   * hasn't landed yet. One turned off at the provider otherwise stays off
   * until a person picks an idle time here.
   */
  private keepIdleTime(binding: StoredCloudBinding): void {
    const hostId = binding.hostId;
    if (!binding.resourceId || !hostId || !followsHostIdleTime(binding)) return;
    if (this.idleTimeWrites.has(binding.id)) return;
    const hold = this.idleTimeHolds.get(binding.id) ?? null;
    if (hold && hold.until > this.now()) return;
    const enable = hold?.enable === true;
    const own = binding.observation?.idleSleep;
    if (!enable && own?.enabled !== true) return;
    if (!this.sleepsOnIdleClaim(binding.providerId)) return;
    const session = this.deps.idleClaims?.sessionFor(hostId) ?? null;
    if (!session?.isOpen || !this.boundTo(hostId, binding.id)) return;
    const minutes = this.deps.idleClaims?.idleOn(hostId, session)?.idle.idleAfterMinutes;
    if (!isHostIdleMinutes(minutes)) return;
    const seconds = minutes * 60;
    // A value the provider wouldn't keep is tried again once the host has moved off it.
    if (hold && hold.stuckOn !== null && hold.stuckOn !== seconds) {
      this.idleTimeHolds.set(binding.id, { ...hold, stuckOn: null });
    }
    if (!enable && own?.idleSeconds === seconds) return;
    if (hold?.stuckOn === seconds) return;
    const bindingId = binding.id;
    this.idleTimeHolds.set(bindingId, {
      until: this.now() + RENEW_RETRY_MS,
      enable,
      stuckOn: null,
    });
    void this.setIdleTime(bindingId, seconds, enable, (sent) => {
      if (sent === "landed") {
        this.idleTimeHolds.delete(bindingId);
        return;
      }
      // Paused from when it settled, and never sent again for a value the provider won't keep.
      this.idleTimeHolds.set(bindingId, {
        until: this.now() + RENEW_RETRY_MS,
        enable,
        stuckOn: sent === "refused" || sent === "kept-another" ? seconds : null,
      });
    });
  }

  /**
   * Sends the machine's own idle timeout to its provider, turning its idle
   * sleep on when `enable` (a person's pick), and keeps what the provider
   * answered. One machine's sends never cross: a later one waits for the one
   * before. `settled` hears how it went before another send can start:
   * `kept-another`, the provider answered with another value; `refused`, it
   * refused it outright; `failed`, it may pass.
   */
  private async setIdleTime(
    bindingId: string,
    idleSeconds: number,
    enable: boolean,
    settled: (sent: "landed" | "kept-another" | "refused" | "failed") => void
  ): Promise<void> {
    const before = this.idleTimeWrites.get(bindingId) ?? Promise.resolve();
    const write = before.then(async () => {
      let sent: "landed" | "kept-another" | "refused" | "failed";
      try {
        sent = await this.writeIdleTime(bindingId, idleSeconds, enable);
      } catch {
        sent = "failed";
      }
      if (!this.disposed) settled(sent);
    });
    this.idleTimeWrites.set(bindingId, write);
    await write;
    if (this.idleTimeWrites.get(bindingId) === write) this.idleTimeWrites.delete(bindingId);
  }

  private async writeIdleTime(
    bindingId: string,
    idleSeconds: number,
    enable: boolean
  ): Promise<"landed" | "kept-another" | "refused" | "failed"> {
    const binding = this.deps.store.binding(bindingId);
    if (this.disposed || !binding?.resourceId) return "failed";
    const resourceId = binding.resourceId;
    const { provider, credentials } = await this.context(binding);
    if (!canSleepIdle(provider)) return "failed";
    const ticket = this.ticket();
    const refused = `${nameOf(provider)} didn't take the host's idle time as the machine's own:`;
    let resource: ProviderResource;
    try {
      resource = await provider.setIdleSleep(credentials, resourceId, idleSeconds, enable);
    } catch (error) {
      const described = provider.describeError(error);
      if (this.deps.store.binding(bindingId)?.resourceId === resourceId) {
        this.recordError(bindingId, {
          code: described.code,
          message: `${refused} ${asSentence(described.message)}`,
          at: this.now(),
        });
      }
      return IDLE_TIME_REFUSALS.has(described.code) ? "refused" : "failed";
    }
    if (
      this.deps.store.binding(bindingId)?.resourceId !== resourceId ||
      !this.stillRegistered(binding.providerId, provider)
    ) {
      return "failed";
    }
    const landed =
      resource.idleSleep?.idleSeconds === idleSeconds && (!enable || resource.idleSleep.enabled);
    // An earlier refusal of an idle time is settled by this one landing; any other error stays.
    this.observe(bindingId, resource, ticket, (current) =>
      landed && current.lastError?.message.startsWith(refused)
        ? { ...current, lastError: null }
        : current
    );
    return landed ? "landed" : "kept-another";
  }

  /** Background observation: reads only, at a pace set by what was last seen. */
  private async pollDue(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    for (const binding of this.deps.store.bindings()) {
      if (!binding.resourceId || !binding.hostId || this.operations.has(binding.id)) continue;
      // Its provider isn't registered: the last observation stays, with its time.
      if (this.deps.accounts.providerUnavailable(binding.providerId)) continue;
      const due = this.nextPollAt.get(binding.id) ?? 0;
      if (now < due) continue;
      const machine = machineOf(binding);
      const interval =
        machine === "running"
          ? RUNNING_POLL_MS
          : machine === "starting" || machine === "stopping"
            ? TRANSITION_POLL_MS * 2
            : machine === "stopped"
              ? STOPPED_POLL_MS
              : UNKNOWN_POLL_MS;
      this.nextPollAt.set(binding.id, now + interval);
      // Not yet due by its own observation (written by a dial or an operation).
      if (binding.observation && now - binding.observation.observedAt < interval) continue;
      try {
        const { provider, credentials } = await this.context(binding);
        await this.inspectInto(binding.id, provider, credentials);
      } catch {
        // Kept as the last observation, with its time: stale says so itself.
      }
    }
  }

  /** A host removed from the list takes its binding and ssh files with it; its machine is untouched. */
  private async dropOrphanBindings(): Promise<void> {
    const listed = new Set(this.deps.hosts.list().map((host) => host.id));
    for (const binding of this.deps.store.bindings()) {
      // One whose host was never added (a crash between the two writes) and that never reached the provider.
      const stranded =
        binding.hostId === null &&
        !binding.resourceId &&
        !binding.creation?.sentAt &&
        this.now() - binding.createdAt > 60_000;
      if (!stranded && (binding.hostId === null || listed.has(binding.hostId))) continue;
      await this.dropBinding(binding.id);
    }
  }

  private async dropBinding(bindingId: string): Promise<void> {
    this.operations.get(bindingId)?.controller.abort();
    // Its machine's own key goes with it, at the provider (#17361), and its orders are
    // marked for closing in the same removal, then closed from their own records.
    this.deps.store.removeBinding(bindingId);
    this.settleOrdersDue(true, bindingId);
    this.renewals.delete(bindingId);
    this.observedTicket.delete(bindingId);
    this.heldKeys.delete(bindingId);
    this.admitted.delete(bindingId);
    this.idleAsked.delete(bindingId);
    this.idleUnsupported.delete(bindingId);
    this.idleTimeHolds.delete(bindingId);
    void this.deps.machineKeys?.revokePending();
    await this.deps.files.forget(this.deps.clientDir, bindingId).catch(() => {});
  }

  /** The host's name in the list, or null when it isn't listed. */
  hostName(hostId: HostId): string | null {
    return this.deps.hosts.get(hostId)?.name ?? null;
  }

  /**
   * The login that may install the Host's system packages on this machine:
   * only one Daintree created, on a provider that declares such a login. An
   * imported machine is the person's own to change.
   */
  hostPackagesLogin(bindingId: string): string | null {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId || binding.ownership !== "created-by-daintree") return null;
    if (this.deps.accounts.providerUnavailable(binding.providerId) !== null) return null;
    return this.deps.accounts.provider(binding.providerId).hostPackagesLogin ?? null;
  }

  /**
   * Removes every host bound to the account from this device, as Settings →
   * Remove host does, and the bindings with them, including one whose host was
   * never added (#17353). Their machines are untouched: whatever runs keeps
   * running in the provider's account. Resolves once nothing here is bound to
   * the account, so it can be removed.
   */
  async forgetAccountHosts(accountId: string): Promise<void> {
    for (const binding of this.deps.store.bindings()) {
      if (binding.accountId !== accountId) continue;
      if (binding.hostId !== null && this.deps.hosts.get(binding.hostId)) {
        await this.deps.hosts.forget(binding.hostId);
      }
      await this.dropBinding(binding.id);
    }
  }
}
