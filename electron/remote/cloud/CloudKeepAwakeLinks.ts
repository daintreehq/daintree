import type { CloudKeepAwake } from "../../../shared/types/cloudHosts.js";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import type { CloudHostStore, StoredCloudBinding } from "./CloudHostStore.js";
import {
  KeepAwakeLinkMethod,
  KeepAwakeStatusSchema,
  type KeepAwakeArmRequest,
  type KeepAwakeStatus,
} from "./machineKeeperLink.js";
import type { CloudProvider, ProviderCredentials } from "./provider.js";

/**
 * How often a linked machine's host is asked what it holds: one it dropped,
 * or another device's. On every keeper pass (a minute apart), since the
 * details are what someone reads before walking away from a busy machine.
 */
const CHECK_EVERY_MS = 50_000;
/** A link this close to its expiry is replaced while its machine's own link stays up. */
const RENEW_BEFORE_MS = 24 * 60 * 60_000;
/** A failure that may pass (a dropped link, an unreachable provider) is tried again after this long. */
const RETRY_MS = 5 * 60_000;
/** A link the host refused is offered again after this long, or on the next link. */
const REFUSED_RETRY_MS = 60 * 60_000;
/**
 * A host found holding none on a link that stays up is handed a new one, no
 * sooner than this after the last: links can't be revoked, so none is minted
 * in a loop.
 */
const REMINT_AFTER_MS = 30 * 60_000;
const CALL_TIMEOUT_MS = 30_000;
/** An arm waits behind other devices' arms at the host, each with a request to check. */
const ARM_TIMEOUT_MS = 60_000;

const TOO_OLD =
  "The Daintree on this machine is too old to keep it awake with no device connected. Update it to let it.";

type KeepAwakeProvider = CloudProvider & Required<Pick<CloudProvider, "keepAwakeUrl">>;

function holdsKeepAwake(provider: CloudProvider): provider is KeepAwakeProvider {
  return typeof provider.keepAwakeUrl === "function";
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/** The sentence an error carries for the person: an AppError's, or a host's over the link. */
function said(error: unknown, fallback: string): string {
  return error instanceof Error &&
    "userMessage" in error &&
    typeof error.userMessage === "string" &&
    error.userMessage
    ? error.userMessage
    : fallback;
}

/** `text` with a signed URL, or any token one carried, taken out, as written or encoded: it is shown and kept. */
function withoutLink(text: string, url?: string): string {
  let out = text;
  if (url) {
    const token = new URL(url).searchParams.get("a37_token");
    for (const form of [url, encodeURIComponent(url)]) out = out.split(form).join("[link]");
    if (token) {
      for (const form of [token, encodeURIComponent(token)]) {
        out = out.split(form).join("[redacted]");
      }
    }
  }
  return out.replace(
    /(a37(?:_|%5f)token["']?\s*(?:[=:]|%3d)\s*["']?)(?!\[redacted\])[^&\s"',}]+/gi,
    "$1[redacted]"
  );
}

/** A view of what the host holds, apart from when it last said so: that alone isn't news. */
function viewKey(view: CloudKeepAwake | null): string {
  return JSON.stringify(view?.kind === "held" ? { ...view, confirmedAt: 0 } : view);
}

/** One attempt for a binding: the link it runs on, and whether it mints, which a pass may decide on the way. */
interface Attempt {
  session: LinkSession;
  mint: boolean;
  /** The host turned away the link it was handed. */
  refused?: boolean;
  promise: Promise<void>;
}

export interface CloudKeepAwakeLinksDeps {
  store: Pick<
    CloudHostStore,
    "bindings" | "binding" | "bindingForHost" | "account" | "updateBinding"
  >;
  accounts: Pick<CloudAccountService, "provider" | "providerUnavailable" | "credentials">;
  hosts: { get(hostId: HostId): HostDescriptor | null };
  /** The host's open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  /** What the person sees changed. */
  changed(): void;
  now?: () => number;
}

/**
 * Hands the host of each Agent 37 instance a URL it holds the instance awake
 * with while it sees work, with no device connected (#17918). Agent 37's own
 * idle timer counts only traffic on the instance's URLs, and its keys reach
 * the whole workspace, so the host gets a signed URL for one port of its own
 * instance instead: minted with the account's key here, on every link and
 * again before it expires, and delivered over that machine's own link only.
 * What the host says it holds (never the URL) is kept for the host's details.
 */
export class CloudKeepAwakeLinks {
  /** The attempt under way for each binding, with the link it runs on and whether it mints. */
  private readonly running = new Map<string, Attempt>();
  /** A link that came up while another's attempt ran: tried once that one settles. */
  private readonly queued = new Map<
    string,
    { hostId: HostId; session: LinkSession; mint: boolean }
  >();
  /** Why the host holds no link, by binding, as last found here. */
  private readonly problems = new Map<string, string>();
  private readonly checkedAt = new Map<string, number>();
  /** When the host last said it holds the link stored for its machine. */
  private readonly confirmedAt = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  /**
   * A question that failed is asked again by then, and a host it then finds
   * holding none is handed one without waiting out the re-mint gate.
   */
  private readonly recheckAt = new Map<string, number>();
  /** When a link was last minted for each binding. */
  private readonly mintedAt = new Map<string, number>();
  /** The link on which the host said it doesn't know these calls: not asked again on it. */
  private readonly unsupportedOn = new Map<string, LinkSession>();
  /** Stored expiries already seen passing, so the details change once when one runs out. */
  private readonly expiredSeen = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: CloudKeepAwakeLinksDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** What the host holds, as last heard here; null for a machine whose provider has no such hold. */
  statusFor(bindingId: string): CloudKeepAwake | null {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId || !this.providerOf(binding)) return null;
    const stored = binding.keepAwake;
    if (stored && stored.resourceId === binding.resourceId) {
      if (stored.expiresAt <= this.now()) return { kind: "expired", expiredAt: stored.expiresAt };
      return {
        kind: "held",
        expiresAt: stored.expiresAt,
        confirmedAt: Math.max(stored.confirmedAt, this.confirmedAt.get(bindingId) ?? 0),
        reached: stored.reached === true,
      };
    }
    return { kind: "none", problem: this.problems.get(bindingId) ?? null };
  }

  /** A link to a host came up: hand its machine a fresh link to hold. */
  sessionOpened(hostId: HostId, session: LinkSession): void {
    void this.run(hostId, session, true);
  }

  /**
   * Background pass: says when a stored link ran out, asks each linked host
   * what it holds now and then, renews a link near its expiry, and retries
   * what may pass.
   */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const bindings = this.deps.store.bindings();
    this.forgetRemoved(bindings);
    const now = this.now();
    // Each machine's attempt runs alongside the others': one host's slow answer holds up no other's.
    const attempts: Promise<void>[] = [];
    for (const binding of bindings) {
      if (!binding.hostId || !binding.resourceId || !this.providerOf(binding)) continue;
      const stored =
        binding.keepAwake?.resourceId === binding.resourceId ? binding.keepAwake : undefined;
      if (stored && stored.expiresAt <= now && !this.expiredSeen.has(binding.id)) {
        this.expiredSeen.add(binding.id);
        this.deps.changed();
      }
      const session = this.deps.sessionFor(binding.hostId);
      if (!session?.isOpen || this.unsupportedOn.get(binding.id) === session) continue;
      const retryAt = this.retryAt.get(binding.id);
      const recheckAt = this.recheckAt.get(binding.id);
      const checked = this.checkedAt.get(binding.id);
      const renew = stored !== undefined && stored.expiresAt - now < RENEW_BEFORE_MS;
      // A pause after a failure holds off minting however near the expiry, but not asking.
      if (retryAt !== undefined ? retryAt <= now : renew) {
        attempts.push(this.run(binding.hostId, session, true));
      } else if (
        (recheckAt !== undefined && recheckAt <= now) ||
        checked === undefined ||
        now - checked >= CHECK_EVERY_MS
      ) {
        attempts.push(this.run(binding.hostId, session, false));
      }
    }
    await Promise.all(attempts);
  }

  /** Forgets what was found for bindings no longer stored. */
  forgetRemoved(bindings = this.deps.store.bindings()): void {
    const live = new Set(bindings.map((binding) => binding.id));
    for (const map of [
      this.problems,
      this.checkedAt,
      this.confirmedAt,
      this.retryAt,
      this.recheckAt,
      this.mintedAt,
      this.unsupportedOn,
    ]) {
      for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    }
    for (const id of this.expiredSeen) if (!live.has(id)) this.expiredSeen.delete(id);
  }

  dispose(): void {
    this.disposed = true;
    this.queued.clear();
  }

  /**
   * Asks the host what it holds over `session` and, with `mint`, hands it a
   * new link. One attempt per binding at a time; a newer link waits its turn.
   */
  run(hostId: HostId, session: LinkSession, mint: boolean): Promise<void> {
    const binding = this.deps.store.bindingForHost(hostId);
    if (this.disposed || !binding?.resourceId) return Promise.resolve();
    const bindingId = binding.id;
    const running = this.running.get(bindingId);
    if (running) {
      // A link since replaced never takes the place of the current link's queued attempt, and
      // an attempt on the same link that already mints covers this one.
      const current = session.isOpen && this.deps.sessionFor(hostId) === session;
      const covered = running.session === session && (running.mint || !mint);
      if (current && !covered) {
        const queued = this.queued.get(bindingId);
        const sameLink = queued?.session === session;
        this.queued.set(bindingId, {
          hostId,
          session,
          mint: mint || (sameLink && queued.mint),
        });
      }
      return running.promise;
    }
    const attempt: Attempt = { session, mint, promise: Promise.resolve() };
    this.running.set(bindingId, attempt);
    attempt.promise = this.runOnce(bindingId, hostId, attempt)
      .catch(() => {
        const later = this.now() + RETRY_MS;
        // A mint that failed in a way that may pass is retried by tick(), never sooner than a pause
        // already set.
        if (attempt.mint) {
          this.retryAt.set(bindingId, Math.max(this.retryAt.get(bindingId) ?? later, later));
          return;
        }
        // A question that failed may have missed the host losing its link: asked again within the
        // same wait. A pause already set covers that, and a recheck still to come isn't put off.
        if (this.retryAt.has(bindingId)) return;
        const recheck = this.recheckAt.get(bindingId);
        if (recheck === undefined || recheck <= this.now()) this.recheckAt.set(bindingId, later);
      })
      .finally(() => {
        if (this.running.get(bindingId) === attempt) this.running.delete(bindingId);
        if (!this.deps.store.binding(bindingId)) this.forgetRemoved();
        const next = this.queued.get(bindingId);
        this.queued.delete(bindingId);
        // One that minted on this link covers a mint queued on it meanwhile, unless the host turned
        // its link away: the queued one was asked for before this one chose to mint.
        const covered = next?.session === attempt.session && attempt.mint && !attempt.refused;
        if (
          next &&
          !covered &&
          next.session.isOpen &&
          this.deps.sessionFor(next.hostId) === next.session
        ) {
          void this.run(next.hostId, next.session, next.mint);
        }
      });
    return attempt.promise;
  }

  private providerOf(binding: StoredCloudBinding): KeepAwakeProvider | null {
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return null;
    const provider = this.deps.accounts.provider(binding.providerId);
    return holdsKeepAwake(provider) ? provider : null;
  }

  /** The session still reaches this binding's machine: the one the host is bound to, and open. */
  private reaches(
    hostId: HostId,
    bindingId: string,
    resourceId: string,
    session: LinkSession
  ): boolean {
    if (this.disposed || !session.isOpen || this.deps.sessionFor(hostId) !== session) return false;
    const connection = this.deps.hosts.get(hostId)?.connection;
    if (connection?.kind !== "cloud" || connection.bindingId !== bindingId) return false;
    const binding = this.deps.store.binding(bindingId);
    return binding?.hostId === hostId && binding.resourceId === resourceId;
  }

  private async runOnce(bindingId: string, hostId: HostId, attempt: Attempt): Promise<void> {
    const session = attempt.session;
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) return;
    const resourceId = binding.resourceId;
    const provider = this.providerOf(binding);
    const account = this.deps.store.account(binding.accountId);
    if (!provider || !account) return;
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    if (this.unsupportedOn.get(bindingId) === session) return;
    // Only an attempt that mints ends a pause after a failure; asking what the host holds doesn't.
    if (attempt.mint) this.retryAt.delete(bindingId);

    let status: KeepAwakeStatus;
    try {
      status = await this.call(session, KeepAwakeLinkMethod.STATUS, null);
    } catch (error) {
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      if (errorCode(error) === "UNSUPPORTED") {
        this.unsupportedOn.set(bindingId, session);
        this.record(bindingId, resourceId, null, TOO_OLD);
        return;
      }
      throw error;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    this.record(bindingId, resourceId, status, status.problem);
    const recheck = this.recheckAt.get(bindingId);
    const rechecking = recheck !== undefined && recheck <= this.now();
    if (rechecking) this.recheckAt.delete(bindingId);
    // Found holding none on a link that stays up: handed a new one, now and then, outside a pause.
    const lastMint = this.mintedAt.get(bindingId);
    const lost =
      status.expiresAt === null &&
      !this.retryAt.has(bindingId) &&
      (rechecking || lastMint === undefined || this.now() - lastMint >= REMINT_AFTER_MS);
    if (!attempt.mint && !lost) return;
    attempt.mint = true;
    if (status.port === null) {
      // The host couldn't open its port, perhaps for a moment.
      this.retryAt.set(bindingId, this.now() + RETRY_MS);
      return;
    }

    let credentials: ProviderCredentials;
    let grant: { url: string; expiresAt: number };
    this.mintedAt.set(bindingId, this.now());
    try {
      credentials = await this.deps.accounts.credentials(account);
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      grant = await provider.keepAwakeUrl(credentials, resourceId, status.port);
    } catch (error) {
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      const reason =
        error instanceof AppError
          ? said(error, "Daintree couldn't read the account's key.")
          : provider.describeError(error).message;
      this.noteProblem(
        bindingId,
        `Daintree couldn't get a link from ${provider.info(process.platform).name} to keep this machine awake: ${reason}`
      );
      this.retryAt.set(bindingId, this.now() + RETRY_MS);
      return;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    const request: KeepAwakeArmRequest = { resourceId, url: grant.url, expiresAt: grant.expiresAt };
    try {
      status = await this.call(session, KeepAwakeLinkMethod.ARM, request);
    } catch (error) {
      if (!this.reaches(hostId, bindingId, resourceId, session)) return;
      if (errorCode(error) === "UNSUPPORTED") {
        this.unsupportedOn.set(bindingId, session);
        this.record(bindingId, resourceId, null, TOO_OLD);
        return;
      }
      if (errorCode(error) === "VALIDATION") {
        // Refused: whatever it held before stays, and says so. Not offered again for a while.
        attempt.refused = true;
        this.noteProblem(
          bindingId,
          withoutLink(said(error, "The host refused the link Daintree gave it."), grant.url)
        );
        this.retryAt.set(bindingId, this.now() + REFUSED_RETRY_MS);
        return;
      }
      throw error;
    }
    if (!this.reaches(hostId, bindingId, resourceId, session)) return;
    this.record(bindingId, resourceId, status, status.problem);
  }

  /** Why the host holds no link, said only while it holds none. */
  private noteProblem(bindingId: string, message: string): void {
    const before = viewKey(this.statusFor(bindingId));
    this.problems.set(bindingId, withoutLink(message));
    if (viewKey(this.statusFor(bindingId)) !== before) this.deps.changed();
  }

  /** What the host said it holds, kept for the details; the stored record is written only on a change. */
  private record(
    bindingId: string,
    resourceId: string,
    status: KeepAwakeStatus | null,
    problem: string | null
  ): void {
    const now = this.now();
    const before = viewKey(this.statusFor(bindingId));
    this.checkedAt.set(bindingId, now);
    const expiresAt = status?.expiresAt ?? null;
    if (expiresAt !== null && expiresAt > now) {
      this.confirmedAt.set(bindingId, now);
      this.problems.delete(bindingId);
      this.expiredSeen.delete(bindingId);
      const reached = status?.reachedAt != null;
      const stored = this.deps.store.binding(bindingId)?.keepAwake;
      if (stored?.expiresAt !== expiresAt || (stored.reached === true) !== reached) {
        this.deps.store.updateBinding(bindingId, (binding) =>
          binding.resourceId === resourceId
            ? {
                ...binding,
                keepAwake: {
                  resourceId,
                  expiresAt,
                  confirmedAt: now,
                  ...(reached ? { reached: true as const } : {}),
                },
              }
            : binding
        );
      }
    } else {
      this.confirmedAt.delete(bindingId);
      // A reason found here (a refusal, a failed mint) stays through its pause, though the host
      // itself says nothing of it.
      if (problem) this.problems.set(bindingId, withoutLink(problem));
      else if (!this.retryAt.has(bindingId)) this.problems.delete(bindingId);
      if (this.deps.store.binding(bindingId)?.keepAwake) {
        this.deps.store.updateBinding(bindingId, (binding) => {
          const { keepAwake: _dropped, ...rest } = binding;
          return rest;
        });
      }
    }
    if (viewKey(this.statusFor(bindingId)) !== before) this.deps.changed();
  }

  private async call(
    session: LinkSession,
    method: string,
    payload: KeepAwakeArmRequest | null
  ): Promise<KeepAwakeStatus> {
    const timeoutMs = method === KeepAwakeLinkMethod.ARM ? ARM_TIMEOUT_MS : CALL_TIMEOUT_MS;
    return KeepAwakeStatusSchema.parse(await session.call(method, payload, { timeoutMs }));
  }
}
