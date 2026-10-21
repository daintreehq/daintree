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
import { CodexAppServerError, runCodexAppServerSession } from "./CodexAppServerClient.js";
import { defaultCodexHome, resolveCodexQuotaProfiles } from "./CodexQuotaProfiles.js";
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

interface HomeCacheEntry {
  cached: CodexQuotaResult | null;
  inFlight: Promise<CodexQuotaResult> | null;
}

/** Keyed by canonical home, never by preset: presets sharing a home share a reading. */
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

/** `codexHome` undefined means main's own env, exactly as before presets were read. */
async function fetchCodexQuota(codexHome: string | undefined): Promise<CodexQuotaResult> {
  try {
    const raw = await runCodexAppServerSession(
      (call) => call<unknown>("account/rateLimits/read"),
      codexHome === undefined ? {} : { codexHome }
    );
    return normalizeCodexRateLimits(raw, Date.now());
  } catch (error) {
    return { status: "unavailable", reason: toUnavailableReason(error), fetchedAt: Date.now() };
  }
}

function readHome(
  home: string,
  codexHome: string | undefined,
  force: boolean
): Promise<CodexQuotaResult> {
  let entry = cacheByHome.get(home);
  if (!entry) {
    entry = { cached: null, inFlight: null };
    cacheByHome.set(home, entry);
  }
  const { cached } = entry;
  if (!force && cached) {
    const ttl = cached.status === "ok" ? CACHE_TTL_MS : UNAVAILABLE_CACHE_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return Promise.resolve(cached);
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

/** Never rejects: every failure is an `unavailable` result. Main's default profile only. */
export function readCodexQuota(): Promise<CodexQuotaResult> {
  return readHome(defaultCodexHome(), undefined, false);
}

/** Ask Codex now, past the cache — what a user's Retry means. */
export function refreshCodexQuota(): Promise<CodexQuotaResult> {
  return readHome(defaultCodexHome(), undefined, true);
}

async function isDirectory(home: string): Promise<boolean> {
  try {
    return (await stat(home)).isDirectory();
  } catch {
    return false;
  }
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
  const targets = resolveCodexQuotaProfiles(codexSettings);
  const profiles: CodexQuotaProfile[] = [];
  // One after another: each read already waits its turn in the queue, and
  // awaiting here keeps a long preset list from parking N reads on it at once.
  for (const target of targets) {
    let result: CodexQuotaProfileResult;
    if (target.invalid) {
      result = { status: "unavailable", reason: target.invalid, fetchedAt: Date.now() };
    } else if (!target.isDefault && !(await isDirectory(target.home))) {
      // Never spawned against, never created: a home Codex hasn't made is not ours to make.
      result = { status: "unavailable", reason: "home-missing", fetchedAt: Date.now() };
    } else {
      result = await readHome(
        target.home,
        // The default keeps inheriting main's env rather than being pinned to
        // the path computed from it, so its reads are unchanged by this.
        target.isDefault ? undefined : target.home,
        force
      );
    }
    profiles.push({
      key: profileKey(target.home, target.invalid !== undefined),
      isDefault: target.isDefault,
      presetNames: target.presetNames,
      result,
    });
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
