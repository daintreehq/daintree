import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
// eager-import-allow: sync-fs calls (appendFileSync, existsSync, mkdirSync)
// are gated behind DAINTREE_DEBUG_GITHUB_GRAPHQL=1 — never executed at import
// time. The imports resolve three symbols that are only dereferenced inside
// _logGraphQLCost(), which returns immediately when the env var is absent.
import type { GitHubRateLimitKind, GitHubRateLimitPayload } from "../shared/types.js";
import { getLogDirectory, logDebug, logInfo, logWarn } from "../../../../electron/utils/logger.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

// Buffer applied to GitHub's `x-ratelimit-reset` to absorb clock skew between
// the local host and api.github.com, and to avoid a poll slipping in a tick
// before the server clears the quota. Aligns with lesson #4629 guidance.
export const PRIMARY_RESET_BUFFER_MS = 7_000;

// Fallback pause when a 403/429 response carries no `retry-after` header and
// no primary-quota signal, matching GitHub's documented minimum.
const SECONDARY_FALLBACK_PAUSE_MS = 60_000;

// Ceiling on the jittered exponential backoff applied after repeated
// secondary-limit hits. Keeps the wait bounded even if the limit persists.
const SECONDARY_BACKOFF_MAX_MS = 5 * 60 * 1000;

// Sentinel key used for blocks that aren't tied to a specific
// `x-ratelimit-resource` bucket — secondary (abuse-detection) blocks and
// primary blocks where the response header is absent.
const GLOBAL_RESOURCE_KEY = "__global__";

// Points held back from background-poll budgeting so interactive, on-demand
// GitHub requests always keep headroom even while background pollers throttle.
export const INTERACTIVE_RESERVE = 100;

// At or below this remaining-points figure the GraphQL budget is treated as
// exhausted and background GraphQL calls are hard-blocked until the window
// resets. A small non-zero band (vs. a strict `=== 0`) absorbs the cost of a
// poll that races the reset boundary.
export const HARD_BLOCK_THRESHOLD = 50;

// Graduated throttling engages once remaining drops below this fraction of the
// window limit and releases once it climbs back above THROTTLE_RELEASE_RATIO.
// The gap between the two is deliberate hysteresis (lesson #4629) so a budget
// hovering near 50% doesn't flap the multiplier on every poll.
const THROTTLE_ENGAGE_RATIO = 0.5;
const THROTTLE_RELEASE_RATIO = 0.6;

// A single anomalously-low reading must not stretch intervals — require this
// many consecutive depleted readings before engaging the throttle.
const DEPLETED_READINGS_TO_ENGAGE = 2;

// Upper bound on the cadence multiplier so a near-empty budget can't stretch a
// background interval into effectively never polling.
export const MAX_THROTTLE_MULTIPLIER = 10;

// Denominator for the dimensionless multiplier — the focused-tier base cadence.
// `computeThrottleMultiplier` returns "safe per-poll interval ÷ this", which
// callers then apply uniformly to both focused and background intervals.
const THROTTLE_BASE_INTERVAL_MS = 30_000;

// Suppress listener churn: only re-notify on a budget reading when the
// multiplier moves by more than this fraction of its last-notified value.
const MEANINGFUL_MULTIPLIER_DELTA = 0.05;

// Extra delay past the budget window's reset before the one-shot recovery
// sweep runs. Covers the PRIMARY_RESET_BUFFER_MS applied to a hard block
// raised in the same window, so a single timer clears both the throttle and
// the block.
const BUDGET_SWEEP_BUFFER_MS = PRIMARY_RESET_BUFFER_MS + 1_000;

interface BlockState {
  kind: GitHubRateLimitKind;
  resumeAt: number;
  resource: string;
  requestId?: string;
}

/**
 * Observed GraphQL budget state. Distinct from {@link BlockState}: a depleted
 * budget stretches the background poll cadence (graduated throttle) without
 * gating requests, whereas a block hard-stops them.
 */
export interface BudgetState {
  /** Points left in the window at the last observed reading. */
  remaining: number;
  /** Window limit (5000 for authenticated users), or null if not reported. */
  limit: number | null;
  /** Epoch milliseconds when the budget window resets. */
  resetAt: number;
  /** Background-poll cadence multiplier derived from the reading (≥ 1). */
  multiplier: number;
  /** Whether graduated throttling is currently engaged (hysteresis-gated). */
  engaged: boolean;
  /** Consecutive depleted readings — drives the engage hysteresis. */
  consecutiveDepletedReadings: number;
}

/**
 * Compute a background-poll cadence multiplier from an observed GraphQL budget.
 *
 * Spreads the spendable budget (`remaining` minus {@link INTERACTIVE_RESERVE})
 * evenly across the time left until the window resets, yielding a safe
 * per-poll interval, then expresses that as a multiple of the focused-tier
 * base cadence. Returns `1` (no throttling) for healthy budgets, invalid
 * inputs, or an already-past reset; returns {@link MAX_THROTTLE_MULTIPLIER}
 * when the spendable budget is exhausted.
 */
export function computeThrottleMultiplier(
  remaining: number,
  limit: number,
  resetAtMs: number,
  nowMs: number = Date.now()
): number {
  if (
    !Number.isFinite(remaining) ||
    !Number.isFinite(limit) ||
    !Number.isFinite(resetAtMs) ||
    limit <= 0
  ) {
    return 1;
  }

  const spendable = remaining - INTERACTIVE_RESERVE;
  if (spendable <= 0) return MAX_THROTTLE_MULTIPLIER;

  const timeToResetMs = resetAtMs - nowMs;
  if (timeToResetMs <= 0) return 1;

  const safeIntervalMs = timeToResetMs / spendable;
  const multiplier = safeIntervalMs / THROTTLE_BASE_INTERVAL_MS;
  if (!Number.isFinite(multiplier) || multiplier <= 1) return 1;
  return Math.min(multiplier, MAX_THROTTLE_MULTIPLIER);
}

export interface ShouldBlockResult {
  blocked: boolean;
  reason: GitHubRateLimitKind | null;
  resumeAt?: number;
}

type StateChangeListener = (state: GitHubRateLimitPayload) => void;

class GitHubRateLimitServiceImpl {
  private readonly states = new Map<string, BlockState>();
  private readonly listeners = new Set<StateChangeListener>();
  // Consecutive secondary-limit hits since the last `clear()` or 2xx response.
  // Drives jittered exponential backoff when GitHub returns a 403/429 without
  // an explicit `retry-after` header.
  private consecutiveSecondaryHits = 0;
  // Last observed GraphQL budget, or null until a budget-carrying response is
  // seen. Drives the graduated background-poll throttle.
  private _budgetState: BudgetState | null = null;
  // Multiplier carried by the last listener notification — used to suppress
  // re-notifying on sub-threshold budget drift.
  private _lastNotifiedMultiplier = 1;
  // Whether the first budget reading has been pushed to listeners yet.
  private _hasNotifiedBudget = false;
  // One-shot timer that sweeps stale budget state just after the window
  // resets, so a stretched cadence doesn't defer throttle recovery.
  private _budgetResetTimer: ReturnType<typeof setTimeout> | null = null;
  // One-shot timer that sweeps the soonest-expiring REST/secondary block.
  // Without it, a renderer that short-circuits while blocked never triggers
  // the lazy `autoClearExpired` poll, so the block lingers until app restart.
  private _blockResetTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Register a subscriber that fires on every state transition (entering a
   * block, changing resume time, or clearing). Transports (main-process
   * broadcast to renderer, utility-process relay to main) hook in here.
   */
  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Apply a state snapshot observed in another process (utility host →
   * main) without re-emitting transport-level events on this side beyond
   * the local subscriber notification. The main-process transport in turn
   * rebroadcasts to all renderers, so a utility-observed limit ends up on
   * the toolbar even though the utility process can't call BrowserWindow.
   */
  applyRemoteState(payload: GitHubRateLimitPayload): void {
    if (payload.blocked && payload.kind && payload.resetAt) {
      this.markBlocked(payload.kind, payload.resetAt, payload.resource ?? GLOBAL_RESOURCE_KEY);
      return;
    }
    this.clear();
  }

  /**
   * Inspect a GitHub HTTP response's headers/status and update internal
   * state. Called from the custom fetch wrapper installed in
   * {@link GitHubAuth.createClient} on every response.
   * @param requestId Optional x-github-request-id header value for
   *   correlating blocks with GitHub Support tickets.
   */
  update(headers: HeadersLike, status: number, bodyText?: string, requestId?: string): void {
    const retryAfter = parseRetryAfter(headers.get("retry-after"));
    if (retryAfter !== null) {
      this.consecutiveSecondaryHits++;
      this.markBlocked("secondary", Date.now() + retryAfter * 1000, GLOBAL_RESOURCE_KEY, requestId);
      return;
    }

    const remainingRaw = headers.get("x-ratelimit-remaining");
    const resetRaw = headers.get("x-ratelimit-reset");
    const remaining = parseIntOrNull(remainingRaw);
    const resetSeconds = parseIntOrNull(resetRaw);
    const resource = headers.get("x-ratelimit-resource") ?? GLOBAL_RESOURCE_KEY;

    if (remaining === 0 && resetSeconds !== null) {
      this.markBlocked(
        "primary",
        resetSeconds * 1000 + PRIMARY_RESET_BUFFER_MS,
        resource,
        requestId
      );
      return;
    }

    if ((status === 403 || status === 429) && looksLikeSecondaryLimit(bodyText)) {
      this.consecutiveSecondaryHits++;
      this.markBlocked(
        "secondary",
        Date.now() + this.computeSecondaryFallbackDelay(),
        GLOBAL_RESOURCE_KEY,
        requestId
      );
      return;
    }

    if (status >= 200 && status < 300 && remaining !== null && remaining > 0) {
      this.consecutiveSecondaryHits = 0;
      if (headers.get("x-ratelimit-resource") !== null) {
        this.clearResource(resource);
      }
    }
  }

  /**
   * Compute the wait duration for a fallback secondary-limit block (the
   * 403/429 + body-classified path where GitHub gave us no `retry-after`).
   * Applies full jitter on top of an exponential schedule that doubles per
   * consecutive hit and caps at {@link SECONDARY_BACKOFF_MAX_MS}.
   *
   * Schedule: hit 1 → 60–120s, hit 2 → 120–180s, hit 3 → 240–300s,
   * hit 4+ → capped at 5 min. The lower bound of 60s matches GitHub's
   * documented minimum wait for headerless secondary blocks.
   */
  private computeSecondaryFallbackDelay(): number {
    const k = Math.max(1, this.consecutiveSecondaryHits);
    const base = Math.min(
      SECONDARY_BACKOFF_MAX_MS,
      SECONDARY_FALLBACK_PAUSE_MS * Math.pow(2, k - 1)
    );
    const jitter = Math.random() * SECONDARY_FALLBACK_PAUSE_MS;
    return Math.min(SECONDARY_BACKOFF_MAX_MS, base + jitter);
  }

  /**
   * Check whether a request should be blocked.
   *
   * When `resource` is passed, only the matching bucket (plus any global
   * secondary block) is considered. GraphQL-only callers can pass `"graphql"`
   * to proceed past a `core` exhaustion, and vice versa.
   *
   * When `resource` is omitted, the check is conservative: any active block
   * gates the request. This is the safe default for callers whose next
   * outbound call type isn't known statically.
   *
   * Auto-clears expired state so the caller sees the service as unblocked as
   * soon as the reset has passed.
   */
  shouldBlockRequest(resource?: string): ShouldBlockResult {
    this.autoClearExpired();

    const global = this.states.get(GLOBAL_RESOURCE_KEY);
    if (global && global.kind === "secondary") {
      return { blocked: true, reason: "secondary", resumeAt: global.resumeAt };
    }

    if (resource) {
      const entry = this.states.get(resource);
      if (entry) {
        return { blocked: true, reason: entry.kind, resumeAt: entry.resumeAt };
      }
      if (global && global.kind === "primary") {
        return { blocked: true, reason: "primary", resumeAt: global.resumeAt };
      }
      return { blocked: false, reason: null };
    }

    if (global && global.kind === "primary") {
      return { blocked: true, reason: "primary", resumeAt: global.resumeAt };
    }
    for (const [key, state] of this.states) {
      if (key !== GLOBAL_RESOURCE_KEY) {
        return { blocked: true, reason: state.kind, resumeAt: state.resumeAt };
      }
    }

    return { blocked: false, reason: null };
  }

  /**
   * Feed GraphQL `rateLimit { cost remaining resetAt limit }` data into the
   * service.
   *
   * - At or below {@link HARD_BLOCK_THRESHOLD} remaining points, marks a
   *   `"primary"` block under the `"graphql"` resource key (the legacy
   *   `remaining === 0` behavior, widened by a small hard-stop band).
   * - Above that, when `limit` is reported, records the budget and computes a
   *   graduated background-poll throttle multiplier. The multiplier engages
   *   only after two consecutive depleted readings (single-blip immunity) and
   *   releases with hysteresis once the budget recovers.
   *
   * Ignores missing or malformed rateLimit objects silently.
   */
  updateFromGraphQL(data: Record<string, unknown>, queryLabel?: string): void {
    const rateLimit = data?.rateLimit as
      { cost?: number; remaining?: number; resetAt?: string; limit?: number } | undefined;
    if (!rateLimit) return;

    const remaining = rateLimit.remaining;
    const resetAt = rateLimit.resetAt;
    if (typeof remaining !== "number" || typeof resetAt !== "string") return;

    const resetMs = Date.parse(resetAt);
    if (!Number.isFinite(resetMs)) return;

    const cost = typeof rateLimit.cost === "number" ? rateLimit.cost : null;
    const limit = typeof rateLimit.limit === "number" ? rateLimit.limit : null;

    if (queryLabel && cost !== null) {
      this._logGraphQLCost(queryLabel, cost, remaining, limit);
    }

    // Budget exhausted (or within the hard-stop band): hard-block GraphQL
    // until the window resets, exactly as the legacy `remaining === 0` path.
    if (remaining <= HARD_BLOCK_THRESHOLD) {
      this._budgetState = {
        remaining,
        limit,
        resetAt: resetMs,
        multiplier: MAX_THROTTLE_MULTIPLIER,
        engaged: true,
        consecutiveDepletedReadings: DEPLETED_READINGS_TO_ENGAGE,
      };
      this._lastNotifiedMultiplier = MAX_THROTTLE_MULTIPLIER;
      this._hasNotifiedBudget = true;
      this.scheduleBudgetResetSweep(resetMs);
      this.markBlocked("primary", resetMs + PRIMARY_RESET_BUFFER_MS, "graphql");
      return;
    }

    // Graduated throttling needs a window limit to compute a depletion ratio.
    if (limit === null || limit <= 0) return;

    this.recordBudgetReading(remaining, limit, resetMs);
  }

  private _logGraphQLCost(
    queryLabel: string,
    cost: number,
    remaining: number,
    limit: number | null
  ): void {
    if (process.env.DAINTREE_DEBUG_GITHUB_GRAPHQL !== "1") return;
    try {
      const dir = join(getLogDirectory(), "..", "debug");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const escaped = queryLabel.replace(/["\n\r]/g, "");
      const line = `[${new Date().toISOString()}] label="${escaped}" cost=${cost} remaining=${remaining} limit=${limit ?? "null"}\n`;
      appendFileSync(join(dir, "github-graphql-costs.log"), line, "utf-8");
    } catch {
      // Must never throw — diagnostic logging is best-effort.
    }
  }

  /**
   * Fold a healthy (non-blocking) budget reading into {@link _budgetState},
   * applying engage/release hysteresis, and notify listeners when the derived
   * multiplier moves meaningfully.
   */
  private recordBudgetReading(remaining: number, limit: number, resetAt: number): void {
    const previous = this._budgetState;
    const depleted = remaining < limit * THROTTLE_ENGAGE_RATIO;
    const recovered = remaining > limit * THROTTLE_RELEASE_RATIO;

    const consecutiveDepletedReadings = depleted
      ? (previous?.consecutiveDepletedReadings ?? 0) + 1
      : 0;

    let engaged = previous?.engaged ?? false;
    if (engaged) {
      // Stay engaged through the 50–60% hysteresis band; release only above it.
      if (recovered) engaged = false;
    } else if (consecutiveDepletedReadings >= DEPLETED_READINGS_TO_ENGAGE) {
      engaged = true;
    }

    const multiplier = engaged ? computeThrottleMultiplier(remaining, limit, resetAt) : 1;

    this._budgetState = {
      remaining,
      limit,
      resetAt,
      multiplier,
      engaged,
      consecutiveDepletedReadings,
    };

    const lastMultiplier = this._lastNotifiedMultiplier;
    const meaningfulChange =
      Math.abs(multiplier - lastMultiplier) >
      Math.max(lastMultiplier, 1) * MEANINGFUL_MULTIPLIER_DELTA;

    if (!this._hasNotifiedBudget || meaningfulChange) {
      this._hasNotifiedBudget = true;
      this._lastNotifiedMultiplier = multiplier;
      this.notifyListeners();
    }

    // Arm the recovery sweep only while throttling — an un-throttled cadence
    // polls often enough to refresh budget state on its own.
    if (engaged) {
      this.scheduleBudgetResetSweep(resetAt);
    } else {
      this.clearBudgetResetTimer();
    }
  }

  /**
   * Arm a one-shot timer that runs {@link autoClearExpired} just after the
   * GraphQL budget window resets, so the throttle snaps back to baseline
   * promptly even when a stretched cadence means no GitHub call would
   * otherwise touch the service for a while.
   */
  private scheduleBudgetResetSweep(resetAtMs: number): void {
    this.clearBudgetResetTimer();
    const delay = Math.max(0, resetAtMs + BUDGET_SWEEP_BUFFER_MS - Date.now());
    const timer = setTimeout(() => {
      this._budgetResetTimer = null;
      this.autoClearExpired();
    }, delay);
    timer.unref?.();
    this._budgetResetTimer = timer;
  }

  private clearBudgetResetTimer(): void {
    if (this._budgetResetTimer) {
      clearTimeout(this._budgetResetTimer);
      this._budgetResetTimer = null;
    }
  }

  /**
   * Arm a one-shot timer that runs {@link autoClearExpired} just after the
   * soonest active block's `resumeAt`. Re-arms itself from the callback so
   * stacked blocks across multiple resources each clear on time even when
   * the renderer's blocked-state short-circuit suppresses lazy sweeps.
   */
  private scheduleBlockResetSweep(): void {
    this.clearBlockResetTimer();
    if (this.states.size === 0) return;
    let minResumeAt = Number.POSITIVE_INFINITY;
    for (const state of this.states.values()) {
      if (state.resumeAt < minResumeAt) minResumeAt = state.resumeAt;
    }
    // Cap at the Node setTimeout int32 ceiling — without this a malformed
    // far-future resumeAt wraps to a 1ms delay and the self-rearm spins.
    const delay = Math.min(Math.max(0, minResumeAt - Date.now()), 2_147_483_647);
    const timer = setTimeout(() => {
      this._blockResetTimer = null;
      this.autoClearExpired();
      this.scheduleBlockResetSweep();
    }, delay);
    timer.unref?.();
    this._blockResetTimer = timer;
  }

  private clearBlockResetTimer(): void {
    if (this._blockResetTimer) {
      clearTimeout(this._blockResetTimer);
      this._blockResetTimer = null;
    }
  }

  /** Snapshot for push/pull consumers. Collapses multi-resource state to a single payload. */
  getState(): GitHubRateLimitPayload {
    this.autoClearExpired();
    return this.withBudget(this.computeBlockPayload());
  }

  /** Block-only projection of current state, before budget fields are folded in. */
  private computeBlockPayload(): GitHubRateLimitPayload {
    if (this.states.size === 0) {
      return { blocked: false, kind: null };
    }

    const global = this.states.get(GLOBAL_RESOURCE_KEY);
    if (global && global.kind === "secondary") {
      return { blocked: true, kind: "secondary", resetAt: global.resumeAt };
    }

    let best: BlockState | null = global && global.kind === "primary" ? global : null;
    for (const [key, state] of this.states) {
      if (key === GLOBAL_RESOURCE_KEY) continue;
      if (!best || state.resumeAt < best.resumeAt) {
        best = state;
      }
    }
    if (best) {
      return { blocked: true, kind: best.kind, resetAt: best.resumeAt, resource: best.resource };
    }
    return { blocked: false, kind: null };
  }

  /**
   * Fold the observed GraphQL budget (remaining / limit / throttle multiplier)
   * into a payload. No-op when no budget has been observed, so the unblocked
   * cold-start payload stays `{ blocked: false, kind: null }`.
   */
  private withBudget(payload: GitHubRateLimitPayload): GitHubRateLimitPayload {
    const budget = this._budgetState;
    if (!budget) return payload;
    const decorated: GitHubRateLimitPayload = {
      ...payload,
      remaining: budget.remaining,
      throttleMultiplier: budget.multiplier,
    };
    if (budget.limit !== null) {
      decorated.limit = budget.limit;
    }
    return decorated;
  }

  /** Drop any active block and budget state (token change, fresh 2xx, manual reset). */
  clear(): void {
    this.consecutiveSecondaryHits = 0;
    const hadBudget = this._budgetState !== null;
    this._budgetState = null;
    this._lastNotifiedMultiplier = 1;
    this._hasNotifiedBudget = false;
    this.clearBudgetResetTimer();
    this.clearBlockResetTimer();
    if (this.states.size === 0) {
      // Still surface the cleared budget so consumers snap back to baseline.
      if (hadBudget) this.notifyListeners();
      return;
    }
    this.states.clear();
    logInfo("GitHub rate limit cleared");
    this.notifyListeners();
  }

  /** Test-only helper. */
  _resetForTests(): void {
    this.states.clear();
    this.consecutiveSecondaryHits = 0;
    this._budgetState = null;
    this._lastNotifiedMultiplier = 1;
    this._hasNotifiedBudget = false;
    this.clearBudgetResetTimer();
    this.clearBlockResetTimer();
  }

  /** Test-only inspector. */
  _getConsecutiveSecondaryHitsForTests(): number {
    return this.consecutiveSecondaryHits;
  }

  /** Test-only inspector for the observed GraphQL budget state. */
  _getBudgetStateForTests(): Readonly<BudgetState> | null {
    return this._budgetState;
  }

  private clearResource(resource: string): void {
    if (!this.states.has(resource)) return;
    this.states.delete(resource);
    logInfo("GitHub rate limit cleared for resource", { resource });
    this.notifyListeners();
    this.scheduleBlockResetSweep();
  }

  private markBlocked(
    kind: GitHubRateLimitKind,
    resumeAt: number,
    resource: string,
    requestId?: string
  ): void {
    const previous = this.states.get(resource);
    const changed =
      !previous || previous.kind !== kind || Math.abs(previous.resumeAt - resumeAt) > 1_000;
    this.states.set(resource, { kind, resumeAt, resource, requestId });
    if (changed) {
      const logPayload: Record<string, unknown> = {
        resource,
        resumeAt,
        waitMs: resumeAt - Date.now(),
      };
      if (requestId) {
        logPayload.requestId = requestId;
      }
      if (kind === "secondary") {
        logWarn("GitHub secondary rate limit — pausing until resume", logPayload);
      } else {
        logInfo("GitHub primary rate limit — pausing until reset", logPayload);
      }
      this.notifyListeners();
    } else {
      logDebug("GitHub rate limit refreshed", { kind, resumeAt, resource });
    }
    this.scheduleBlockResetSweep();
  }

  private autoClearExpired(): void {
    let blocksCleared = false;
    for (const [key, state] of this.states) {
      if (state.resumeAt <= Date.now()) {
        this.states.delete(key);
        blocksCleared = true;
      }
    }

    // The GraphQL budget window rolls over at its own `resetAt`; once past, the
    // observed remaining/limit and any throttle derived from them are stale.
    // Drop them so the cadence snaps back to baseline — recovery is
    // server-authoritative and needs no hysteresis (lesson #4629).
    let budgetCleared = false;
    if (this._budgetState && this._budgetState.resetAt <= Date.now()) {
      this._budgetState = null;
      this._lastNotifiedMultiplier = 1;
      this._hasNotifiedBudget = false;
      this.clearBudgetResetTimer();
      budgetCleared = true;
    }

    if (blocksCleared) {
      logInfo("GitHub rate limit block(s) expired");
    }
    if (blocksCleared || budgetCleared) {
      this.notifyListeners();
    }
  }

  private notifyListeners(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        // A misbehaving transport must not break rate-limit bookkeeping.
        logWarn("GitHub rate-limit listener threw", {
          error: formatErrorMessage(err, "Rate-limit listener failed"),
        });
      }
    }
  }
}

export interface HeadersLike {
  get(name: string): string | null;
}

function parseIntOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Numeric seconds form — the only shape GitHub uses in practice.
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  // HTTP-date form (rare) — best-effort parse.
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = Math.ceil((dateMs - Date.now()) / 1000);
    return delta > 0 ? delta : 0;
  }
  return null;
}

function looksLikeSecondaryLimit(bodyText: string | undefined): boolean {
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes("secondary rate limit") || lower.includes("abuse detection");
}

/**
 * `GitHubRateLimitError` lets callers distinguish a preflight rate-limit block
 * from ordinary network/API errors and lets the UI render a proper countdown.
 */
export class GitHubRateLimitError extends Error {
  readonly kind: GitHubRateLimitKind;
  readonly resumeAt: number;

  constructor(kind: GitHubRateLimitKind, resumeAt: number) {
    super(
      kind === "primary"
        ? "GitHub rate limit exceeded. Waiting for quota reset."
        : "GitHub secondary rate limit triggered. Pausing requests."
    );
    this.name = "GitHubRateLimitError";
    this.kind = kind;
    this.resumeAt = resumeAt;
  }
}

export const gitHubRateLimitService = new GitHubRateLimitServiceImpl();
