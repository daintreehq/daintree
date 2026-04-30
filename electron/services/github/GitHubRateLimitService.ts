import type {
  GitHubRateLimitKind,
  GitHubRateLimitPayload,
} from "../../../shared/types/ipc/github.js";
import { logDebug, logInfo, logWarn } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

// Buffer applied to GitHub's `x-ratelimit-reset` to absorb clock skew between
// the local host and api.github.com, and to avoid a poll slipping in a tick
// before the server clears the quota. Aligns with lesson #4629 guidance.
const PRIMARY_RESET_BUFFER_MS = 7_000;

// Fallback pause when a 403/429 response carries no `retry-after` header and
// no primary-quota signal, matching GitHub's documented minimum.
const SECONDARY_FALLBACK_PAUSE_MS = 60_000;

interface BlockState {
  kind: GitHubRateLimitKind;
  resumeAt: number;
}

export interface ShouldBlockResult {
  blocked: boolean;
  reason: GitHubRateLimitKind | null;
  resumeAt?: number;
}

type StateChangeListener = (state: GitHubRateLimitPayload) => void;

class GitHubRateLimitServiceImpl {
  private state: BlockState | null = null;
  private readonly listeners = new Set<StateChangeListener>();

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
      this.markBlocked(payload.kind, payload.resetAt);
      return;
    }
    this.clear();
  }

  /**
   * Inspect a GitHub HTTP response's headers/status and update internal
   * state. Called from the custom fetch wrapper installed in
   * {@link GitHubAuth.createClient} on every response.
   */
  update(headers: HeadersLike, status: number, bodyText?: string): void {
    const retryAfter = parseRetryAfter(headers.get("retry-after"));
    if (retryAfter !== null) {
      this.markBlocked("secondary", Date.now() + retryAfter * 1000);
      return;
    }

    const remainingRaw = headers.get("x-ratelimit-remaining");
    const resetRaw = headers.get("x-ratelimit-reset");
    const remaining = parseIntOrNull(remainingRaw);
    const resetSeconds = parseIntOrNull(resetRaw);

    if (remaining === 0 && resetSeconds !== null) {
      this.markBlocked("primary", resetSeconds * 1000 + PRIMARY_RESET_BUFFER_MS);
      return;
    }

    if ((status === 403 || status === 429) && looksLikeSecondaryLimit(bodyText)) {
      this.markBlocked("secondary", Date.now() + SECONDARY_FALLBACK_PAUSE_MS);
      return;
    }

    if (status >= 200 && status < 300 && remaining !== null && remaining > 0) {
      this.clear();
    }
  }

  /**
   * Main-process check consumed by callers before issuing a GitHub request.
   * Auto-clears expired state so the caller sees the service as unblocked as
   * soon as the reset has passed.
   */
  shouldBlockRequest(): ShouldBlockResult {
    if (!this.state) {
      return { blocked: false, reason: null };
    }
    if (this.state.resumeAt <= Date.now()) {
      this.clear();
      return { blocked: false, reason: null };
    }
    return { blocked: true, reason: this.state.kind, resumeAt: this.state.resumeAt };
  }

  /** Snapshot for push/pull consumers. */
  getState(): GitHubRateLimitPayload {
    if (!this.state || this.state.resumeAt <= Date.now()) {
      return { blocked: false, kind: null };
    }
    return { blocked: true, kind: this.state.kind, resetAt: this.state.resumeAt };
  }

  /** Drop any active block (token change, fresh 2xx, manual reset). */
  clear(): void {
    if (!this.state) return;
    this.state = null;
    logInfo("GitHub rate limit cleared");
    this.notifyListeners();
  }

  /** Test-only helper. */
  _resetForTests(): void {
    this.state = null;
  }

  private markBlocked(kind: GitHubRateLimitKind, resumeAt: number): void {
    const previous = this.state;
    const changed =
      !previous || previous.kind !== kind || Math.abs(previous.resumeAt - resumeAt) > 1_000;
    this.state = { kind, resumeAt };
    if (changed) {
      if (kind === "secondary") {
        logWarn("GitHub secondary rate limit — pausing until resume", {
          resumeAt,
          waitMs: resumeAt - Date.now(),
        });
      } else {
        logInfo("GitHub primary rate limit — pausing until reset", {
          resumeAt,
          waitMs: resumeAt - Date.now(),
        });
      }
      this.notifyListeners();
    } else {
      logDebug("GitHub rate limit refreshed", { kind, resumeAt });
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
