/**
 * Codex account quota, read through the app-server's `account/rateLimits/read`
 * (#12797). The method needs only the handshake — no thread, no tokens — so
 * each read is one short session on the shared transport.
 *
 * The protocol also pushes `account/rateLimits/updated`, but only inside a
 * session that runs a turn; a read-and-exit session never sees it, and holding
 * a server open to wait for it would pin one of the transport's two slots.
 * Freshness comes from the caller re-reading instead, behind a short cache so
 * several open views share one process.
 */

import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  CodexAppServerError,
  runCodexAppServerSession,
  type CodexAppServerCall,
} from "./CodexAppServerClient.js";
import {
  canonicalCodexHomeKey,
  resolveCodexQuotaProfiles,
  resolveDefaultCodexTarget,
  type CodexQuotaProfileTarget,
} from "./CodexQuotaProfiles.js";
import type { AgentSettingsEntry } from "../../../shared/types/agentSettings.js";
import type {
  CodexLimitBucketEvidence,
  CodexLimitEvidence,
  CodexLimitWindowEvidence,
} from "../../../shared/types/codexLimitReset.js";
import type {
  CodexQuotaProfile,
  CodexQuotaProfileHomeReason,
  CodexQuotaProfileResult,
  CodexQuotaResult,
  CodexQuotaUnavailableReason,
  CodexQuotaWindow,
} from "../../../shared/types/ipc/agentQuota.js";

const CACHE_TTL_MS = 30_000;
/**
 * Unavailable answers are cached briefly too, so a signed-out user isn't
 * re-probed per open view, but short enough that Retry actually re-reads.
 */
const UNAVAILABLE_CACHE_TTL_MS = 5_000;

/**
 * Who a reading belongs to (#13702). `accountId` is the ChatGPT workspace, which
 * a Team shares, so it only identifies a login together with the email. Kept in
 * memory beside the reading: never logged, never sent to the renderer.
 */
interface CodexAccountIdentity {
  accountId: string;
  email: string;
}

interface HomeReading {
  result: CodexQuotaResult;
  identity: CodexAccountIdentity | null;
  /** Every bucket as the server sent it, for a stopped pane's reset (#17906); null with no answer. */
  evidence: CodexLimitEvidence | null;
}

interface HomeCacheEntry {
  cached: HomeReading | null;
  inFlight: Promise<HomeReading> | null;
}

/** Keyed by realpath'd home, never by preset: presets sharing a home share a reading. */
let cacheByHome = new Map<string, HomeCacheEntry>();
/**
 * Every quota read, whichever home and caller, runs one at a time behind this.
 * The transport admits two sessions, and a fan-out across several presets
 * would hold both and starve the rest of the app's Codex queries.
 */
let queueTail: Promise<unknown> = Promise.resolve();

function toWindow(raw: unknown): CodexQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const { usedPercent, windowDurationMins, resetsAt } = raw as Record<string, unknown>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return null;
  }
  if (
    typeof windowDurationMins !== "number" ||
    !Number.isInteger(windowDurationMins) ||
    windowDurationMins <= 0
  ) {
    return null;
  }
  return {
    usedPercent: Math.min(usedPercent, 100),
    windowDurationMins,
    // The protocol reports Unix seconds.
    resetsAt:
      typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0
        ? Math.round(resetsAt * 1000)
        : null,
  };
}

/**
 * Normalise a `GetAccountRateLimitsResponse`. Only the top-level snapshot is
 * read: `rateLimitsByLimitId` breaks the same account down by model family,
 * and summing or picking from it would be a guess.
 */
export function normalizeCodexRateLimits(raw: unknown, fetchedAt: number): CodexQuotaResult {
  const unavailable = (reason: CodexQuotaUnavailableReason): CodexQuotaResult => ({
    status: "unavailable",
    reason,
    fetchedAt,
  });
  if (!raw || typeof raw !== "object") return unavailable("unsupported-response");
  const snapshot = (raw as Record<string, unknown>).rateLimits;
  if (!snapshot || typeof snapshot !== "object") return unavailable("unsupported-response");

  const { primary, secondary, planType } = snapshot as Record<string, unknown>;
  const sent = [primary, secondary].filter((value) => value !== null && value !== undefined);
  if (sent.length === 0) return unavailable("no-windows");

  const windows = sent.map(toWindow);
  // A window the server sent but we can't read is not the same as no window:
  // dropping it silently would show the other one as the whole picture.
  if (windows.some((window) => window === null)) return unavailable("unsupported-response");

  return {
    status: "ok",
    planType: typeof planType === "string" && planType.trim() ? planType : null,
    windows: (windows as CodexQuotaWindow[]).sort(
      (a, b) => a.windowDurationMins - b.windowDurationMins
    ),
    fetchedAt,
  };
}

/** Undefined for a window the server didn't send; null for one it sent that can't be read. */
function toEvidenceWindow(raw: unknown): CodexLimitWindowEvidence | null | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object") return null;
  const { usedPercent, resetsAt } = raw as Record<string, unknown>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return null;
  }
  if (resetsAt === null || resetsAt === undefined) return { usedPercent, resetsAt: null };
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  return { usedPercent, resetsAt: Math.round(resetsAt * 1000) };
}

function toEvidenceBucket(raw: unknown, key: string | null): CodexLimitBucketEvidence {
  const snapshot = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const windows: CodexLimitWindowEvidence[] = [];
  let unreadable = snapshot === null;
  for (const slot of [snapshot?.primary, snapshot?.secondary]) {
    const window = toEvidenceWindow(slot);
    if (window === null) unreadable = true;
    else if (window !== undefined) windows.push(window);
  }
  return {
    limitId: nonEmptyString(snapshot?.limitId) ?? key,
    limitName: nonEmptyString(snapshot?.limitName),
    windows,
    unreadable,
  };
}

/**
 * Every bucket of a `GetAccountRateLimitsResponse`, for judging a stopped
 * pane's banner by (#17906): the per-limit map, or the single snapshot an
 * older CLI sends. Unlike {@link normalizeCodexRateLimits} it keeps the model
 * buckets, since the banner names the one it means, and a window with no
 * duration. Null when the response isn't one.
 */
export function toCodexLimitEvidence(
  raw: unknown,
  requestedAt: number,
  receivedAt: number
): CodexLimitEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const { rateLimits, rateLimitsByLimitId } = raw as Record<string, unknown>;
  const buckets =
    rateLimitsByLimitId && typeof rateLimitsByLimitId === "object"
      ? Object.entries(rateLimitsByLimitId).map(([key, snapshot]) =>
          toEvidenceBucket(snapshot, key)
        )
      : rateLimits && typeof rateLimits === "object"
        ? [toEvidenceBucket(rateLimits, null)]
        : null;
  return buckets === null ? null : { requestedAt, receivedAt, buckets };
}

function toUnavailableReason(error: unknown): CodexQuotaUnavailableReason {
  if (error instanceof CodexAppServerError) {
    if (error.reason === "cli-missing") return "cli-missing";
    if (error.reason === "timeout") return "timeout";
  }
  return "read-failed";
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job, job);
  queueTail = run.catch(() => undefined);
  return run;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Best effort: a CLI without the method, or a login with no email (API key,
 * Bedrock), just leaves the reading unfolded. `refreshToken` stays off, so the
 * call never touches the network or rewrites the user's credentials.
 */
async function readAccountEmail(call: CodexAppServerCall): Promise<string | null> {
  try {
    const raw = await call<unknown>("account/read", { refreshToken: false });
    const account =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>).account : null;
    if (!account || typeof account !== "object") return null;
    return nonEmptyString((account as Record<string, unknown>).email);
  } catch {
    return null;
  }
}

/** `codexHome` undefined means main's own env, exactly as before presets were read. */
async function fetchCodexQuota(codexHome: string | undefined): Promise<HomeReading> {
  // Held outside the session: if the deadline lands during the optional account
  // read, the quota that already arrived is still the answer.
  let quota: { raw: unknown; fetchedAt: number } | null = null;
  let requestedAt = Date.now();
  try {
    const { raw, accountId, email } = await runCodexAppServerSession(
      async (call) => {
        requestedAt = Date.now();
        const raw = await call<unknown>("account/rateLimits/read");
        quota = { raw, fetchedAt: Date.now() };
        const accountId =
          raw && typeof raw === "object"
            ? nonEmptyString((raw as Record<string, unknown>).accountId)
            : null;
        // Without a workspace id the email can't fold anything, so don't ask.
        const email = accountId ? await readAccountEmail(call) : null;
        return { raw, accountId, email };
      },
      codexHome === undefined ? {} : { codexHome }
    );
    const result = normalizeCodexRateLimits(raw, Date.now());
    const answered = quota as { raw: unknown; fetchedAt: number } | null;
    return {
      result,
      identity: result.status === "ok" && accountId && email ? { accountId, email } : null,
      evidence: toCodexLimitEvidence(raw, requestedAt, answered?.fetchedAt ?? Date.now()),
    };
  } catch (error) {
    const answered = quota as { raw: unknown; fetchedAt: number } | null;
    if (answered) {
      return {
        result: normalizeCodexRateLimits(answered.raw, answered.fetchedAt),
        identity: null,
        evidence: toCodexLimitEvidence(answered.raw, requestedAt, answered.fetchedAt),
      };
    }
    return {
      result: { status: "unavailable", reason: toUnavailableReason(error), fetchedAt: Date.now() },
      identity: null,
      evidence: null,
    };
  }
}

function readHome(
  home: string,
  codexHome: string | undefined,
  force: boolean
): Promise<HomeReading> {
  let entry = cacheByHome.get(home);
  if (!entry) {
    entry = { cached: null, inFlight: null };
    cacheByHome.set(home, entry);
  }
  const { cached } = entry;
  if (!force && cached) {
    const ttl = cached.result.status === "ok" ? CACHE_TTL_MS : UNAVAILABLE_CACHE_TTL_MS;
    if (Date.now() - cached.result.fetchedAt < ttl) return Promise.resolve(cached);
  }
  // A refresh still joins a read already in flight rather than queueing a second.
  if (entry.inFlight) return entry.inFlight;
  const owner = entry;
  const request = enqueue(() => fetchCodexQuota(codexHome)).then((result) => {
    owner.cached = result;
    return result;
  });
  owner.inFlight = request;
  void request.finally(() => {
    if (owner.inFlight === request) owner.inFlight = null;
  });
  return request;
}

async function readCodexSettings(): Promise<AgentSettingsEntry | undefined> {
  try {
    // Lazy, like the handler's own import of this module: the store isn't needed until asked.
    const { store } = await import("../../store.js");
    return store.get("agentSettings")?.agents?.codex;
  } catch {
    // Unreadable settings still leave main's own profile to report.
    return undefined;
  }
}

/** Whether `target` can be read at all, and if not, why. Never spawns. */
async function unreadableReason(
  target: CodexQuotaProfileTarget
): Promise<CodexQuotaProfileHomeReason | null> {
  if (target.invalid) return target.invalid;
  // Never spawned against, never created: a home Codex hasn't made is not ours to make.
  if (!target.inheritsMainEnv && !(await isDirectory(target.home))) return "home-missing";
  return null;
}

/**
 * Main's own home keeps inheriting main's env rather than being pinned to the
 * path computed from it; every other home, the agent-wide one included, is
 * named the way a pane's env names it.
 */
function readTarget(target: CodexQuotaProfileTarget, homeKey: string, force: boolean) {
  return readHome(homeKey, target.inheritsMainEnv ? undefined : target.home, force);
}

async function readDefaultHome(force: boolean): Promise<CodexQuotaResult> {
  const target = resolveDefaultCodexTarget(await readCodexSettings());
  // The MCP schema carries no home reasons, so a home Codex can't be started
  // against reads as a failed read, never as the quota of main's home instead.
  if (await unreadableReason(target)) {
    return { status: "unavailable", reason: "read-failed", fetchedAt: Date.now() };
  }
  const reading = await readTarget(target, await canonicalCodexHomeKey(target.home), force);
  return reading.result;
}

/** Never rejects: every failure is an `unavailable` result. The default profile only. */
export function readCodexQuota(): Promise<CodexQuotaResult> {
  return readDefaultHome(false);
}

/** Ask Codex now, past the cache — what a user's Retry means. */
export function refreshCodexQuota(): Promise<CodexQuotaResult> {
  return readDefaultHome(true);
}

async function isDirectory(home: string): Promise<boolean> {
  try {
    return (await stat(home)).isDirectory();
  } catch {
    return false;
  }
}

interface CanonicalTarget extends CodexQuotaProfileTarget {
  /** Realpath'd identity for a readable home; the raw value for an invalid one. */
  homeKey: string;
}

type PresetLabels = Pick<CodexQuotaProfileTarget, "presetNames" | "presetOrder">;

/** Adds `from`'s presets to `into`, keeping the order they have in the preset list. */
function mergePresets(into: PresetLabels, from: PresetLabels): void {
  const merged = [
    ...into.presetNames.map((name, i) => ({ name, order: into.presetOrder[i]! })),
    ...from.presetNames.map((name, i) => ({ name, order: from.presetOrder[i]! })),
  ].sort((a, b) => a.order - b.order);
  into.presetNames = merged.map((entry) => entry.name);
  into.presetOrder = merged.map((entry) => entry.order);
}

/** Account names, or ids, joined in order without repeating one already held. */
function mergeUnique(into: string[] | undefined, from: string[] | undefined): string[] | undefined {
  if (!from?.length) return into;
  return [...(into ?? []), ...from.filter((value) => !into?.includes(value))];
}

/**
 * Folds the spellings of one directory — a symlink, `.Codex-2` beside
 * `.codex-2` on APFS — into the first target that names it. Folding into the
 * default makes the merged row the default.
 */
async function foldBySameDirectory(targets: CodexQuotaProfileTarget[]): Promise<CanonicalTarget[]> {
  const folded: CanonicalTarget[] = [];
  const byKey = new Map<string, CanonicalTarget>();
  for (const target of targets) {
    if (target.invalid) {
      folded.push({ ...target, homeKey: target.home });
      continue;
    }
    const homeKey = await canonicalCodexHomeKey(target.home);
    const existing = byKey.get(homeKey);
    if (existing) {
      mergePresets(existing, target);
      existing.accountNames = mergeUnique(existing.accountNames, target.accountNames);
      existing.accountIds = mergeUnique(existing.accountIds, target.accountIds);
      existing.isDefault ||= target.isDefault;
      continue;
    }
    const canonical: CanonicalTarget = { ...target, homeKey };
    byKey.set(homeKey, canonical);
    folded.push(canonical);
  }
  return folded;
}

function profileKey(home: string, invalid: boolean): string {
  return createHash("sha256")
    .update(`${invalid ? "invalid" : "home"}\0${home}`)
    .digest("hex")
    .slice(0, 16);
}

async function readProfiles(force: boolean): Promise<CodexQuotaProfile[]> {
  const targets = await foldBySameDirectory(resolveCodexQuotaProfiles(await readCodexSettings()));
  const profiles: CodexQuotaProfile[] = [];
  const byAccount = new Map<string, { profile: CodexQuotaProfile; labels: PresetLabels }>();
  // One after another: each read already waits its turn in the queue, and
  // awaiting here keeps a long preset list from parking N reads on it at once.
  for (const target of targets) {
    let result: CodexQuotaProfileResult;
    let identity: CodexAccountIdentity | null = null;
    const unreadable = await unreadableReason(target);
    if (unreadable) {
      result = { status: "unavailable", reason: unreadable, fetchedAt: Date.now() };
    } else {
      const reading = await readTarget(target, target.homeKey, force);
      result = reading.result;
      identity = reading.identity;
    }
    const profile: CodexQuotaProfile = {
      key: profileKey(target.homeKey, target.invalid !== undefined),
      isDefault: target.isDefault,
      presetNames: target.presetNames,
      ...(target.accountNames?.length && { accountNames: target.accountNames }),
      ...(target.accountIds?.length && { accountIds: target.accountIds }),
      result,
    };
    // Two homes signed into one login are one row (#13702). It saves a row,
    // not a read: the identity only arrives with each home's reading.
    // The row keeps the first home's place and key, but shows the freshest of
    // the readings: one may be from the cache, the other just read.
    const accountKey = identity ? `${identity.accountId}\0${identity.email}` : null;
    const sameAccount = accountKey ? byAccount.get(accountKey) : undefined;
    if (sameAccount) {
      mergePresets(sameAccount.labels, target);
      sameAccount.profile.presetNames = sameAccount.labels.presetNames;
      const accountNames = mergeUnique(sameAccount.profile.accountNames, target.accountNames);
      if (accountNames?.length) sameAccount.profile.accountNames = accountNames;
      const accountIds = mergeUnique(sameAccount.profile.accountIds, target.accountIds);
      if (accountIds?.length) sameAccount.profile.accountIds = accountIds;
      sameAccount.profile.isDefault ||= profile.isDefault;
      if (result.fetchedAt > sameAccount.profile.result.fetchedAt) {
        sameAccount.profile.result = result;
      }
      continue;
    }
    if (accountKey) {
      byAccount.set(accountKey, {
        profile,
        labels: { presetNames: target.presetNames, presetOrder: target.presetOrder },
      });
    }
    profiles.push(profile);
  }
  return profiles;
}

/** The default profile plus every distinct home a Codex preset sets (#13686). Never rejects. */
export function readCodexQuotaProfiles(): Promise<CodexQuotaProfile[]> {
  return readProfiles(false);
}

/** Every profile past the cache, for an explicit Retry. */
export function refreshCodexQuotaProfiles(): Promise<CodexQuotaProfile[]> {
  return readProfiles(true);
}

/** One readable home's reading, keyed by its realpath'd identity. Main's alone. */
export interface CodexHomeQuota {
  homeKey: string;
  isDefault: boolean;
  accountNames: string[];
  presetNames: string[];
  result: CodexQuotaResult;
}

/**
 * The quota of only the homes in `homes` (#17318), canonical key to the home
 * as a running pane's env named it, behind the same cache and queue as every
 * other read: a home with no agent in it is never asked about. A home a
 * profile names is read and labelled as Settings reads it; one none does (a
 * project's own `CODEX_HOME`) is read the way that pane runs, unlabelled.
 * Never rejects.
 */
export async function readCodexQuotaForHomes(
  homes: ReadonlyMap<string, string>
): Promise<CodexHomeQuota[]> {
  if (homes.size === 0) return [];
  const profiles = await foldBySameDirectory(resolveCodexQuotaProfiles(await readCodexSettings()));
  const named = new Set(profiles.map((target) => target.homeKey));
  const unnamed: CanonicalTarget[] = [...homes]
    .filter(([homeKey]) => !named.has(homeKey))
    .map(([homeKey, home]) => ({
      home,
      homeKey,
      isDefault: false,
      presetNames: [],
      presetOrder: [],
    }));
  const readings: CodexHomeQuota[] = [];
  for (const target of [...profiles, ...unnamed]) {
    if (!homes.has(target.homeKey) || (await unreadableReason(target))) continue;
    const { result } = await readTarget(target, target.homeKey, false);
    readings.push({
      homeKey: target.homeKey,
      isDefault: target.isDefault,
      accountNames: target.accountNames ?? [],
      presetNames: target.presetNames,
      result,
    });
  }
  return readings;
}

/**
 * A reading of the Codex home a stopped pane runs on, for judging its banner
 * by (#17906). Always a new request, through the same queue but past the
 * cache: one asked for now is after the banner showed whatever the clock
 * says, and a stopped pane's home is kept nowhere after. `home` is the
 * absolute home the pane's env named, resolved once to the folder it names
 * now; one Codex hasn't made is never read. Null when there is no reading.
 * Never rejects.
 */
export async function readCodexHomeLimitEvidence(home: string): Promise<CodexLimitEvidence | null> {
  if (!(await isDirectory(home))) return null;
  let physical: string;
  try {
    physical = await realpath(home);
  } catch {
    return null;
  }
  const reading = await enqueue(() => fetchCodexQuota(physical));
  return reading.evidence;
}

/** The queue is kept: a read still running from before the reset must still finish first. */
export function resetCodexQuotaCacheForTests(): void {
  cacheByHome = new Map();
}
