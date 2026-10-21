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
import { stat } from "node:fs/promises";
import {
  CodexAppServerError,
  runCodexAppServerSession,
  type CodexAppServerCall,
} from "./CodexAppServerClient.js";
import {
  canonicalCodexHomeKey,
  defaultCodexHome,
  resolveCodexQuotaProfiles,
  type CodexQuotaProfileTarget,
} from "./CodexQuotaProfiles.js";
import type { AgentSettingsEntry } from "../../../shared/types/agentSettings.js";
import type {
  CodexQuotaProfile,
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
  try {
    const { raw, accountId, email } = await runCodexAppServerSession(
      async (call) => {
        const raw = await call<unknown>("account/rateLimits/read");
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
    return {
      result,
      identity: result.status === "ok" && accountId && email ? { accountId, email } : null,
    };
  } catch (error) {
    return {
      result: { status: "unavailable", reason: toUnavailableReason(error), fetchedAt: Date.now() },
      identity: null,
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

async function readDefaultHome(force: boolean): Promise<CodexQuotaResult> {
  const reading = await readHome(await canonicalCodexHomeKey(defaultCodexHome()), undefined, force);
  return reading.result;
}

/** Never rejects: every failure is an `unavailable` result. Main's default profile only. */
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
      existing.presetNames.push(...target.presetNames);
      existing.isDefault ||= target.isDefault;
      continue;
    }
    const canonical: CanonicalTarget = { ...target, presetNames: [...target.presetNames], homeKey };
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
  let codexSettings: AgentSettingsEntry | undefined;
  try {
    // Lazy, like the handler's own import of this module: the store isn't needed until asked.
    const { store } = await import("../../store.js");
    codexSettings = store.get("agentSettings")?.agents?.codex;
  } catch {
    // Unreadable settings still leave main's own profile to report.
    codexSettings = undefined;
  }
  const targets = await foldBySameDirectory(resolveCodexQuotaProfiles(codexSettings));
  const profiles: CodexQuotaProfile[] = [];
  const byAccount = new Map<string, CodexQuotaProfile>();
  // One after another: each read already waits its turn in the queue, and
  // awaiting here keeps a long preset list from parking N reads on it at once.
  for (const target of targets) {
    let result: CodexQuotaProfileResult;
    let identity: CodexAccountIdentity | null = null;
    if (target.invalid) {
      result = { status: "unavailable", reason: target.invalid, fetchedAt: Date.now() };
    } else if (!target.isDefault && !(await isDirectory(target.home))) {
      // Never spawned against, never created: a home Codex hasn't made is not ours to make.
      result = { status: "unavailable", reason: "home-missing", fetchedAt: Date.now() };
    } else {
      const reading = await readHome(
        target.homeKey,
        // The default keeps inheriting main's env rather than being pinned to
        // the path computed from it, so its reads are unchanged by this.
        target.isDefault ? undefined : target.home,
        force
      );
      result = reading.result;
      identity = reading.identity;
    }
    const profile: CodexQuotaProfile = {
      key: profileKey(target.homeKey, target.invalid !== undefined),
      isDefault: target.isDefault,
      presetNames: target.presetNames,
      result,
    };
    // Two homes signed into one login are one row (#13702). It saves a row,
    // not a read: the identity only arrives with each home's reading.
    const accountKey = identity ? `${identity.accountId}\0${identity.email}` : null;
    const sameAccount = accountKey ? byAccount.get(accountKey) : undefined;
    if (sameAccount) {
      sameAccount.presetNames.push(...profile.presetNames);
      sameAccount.isDefault ||= profile.isDefault;
      continue;
    }
    if (accountKey) byAccount.set(accountKey, profile);
    profiles.push(profile);
  }
  return profiles;
}

/** Main's own profile plus every distinct home a Codex preset sets (#13686). Never rejects. */
export function readCodexQuotaProfiles(): Promise<CodexQuotaProfile[]> {
  return readProfiles(false);
}

/** Every profile past the cache, for an explicit Retry. */
export function refreshCodexQuotaProfiles(): Promise<CodexQuotaProfile[]> {
  return readProfiles(true);
}

/** The queue is kept: a read still running from before the reset must still finish first. */
export function resetCodexQuotaCacheForTests(): void {
  cacheByHome = new Map();
}
