import { RequestError } from "@octokit/request-error";
import { GraphqlResponseError } from "@octokit/graphql";
import { gitHubRateLimitService, GitHubRateLimitError } from "./GitHubRateLimitService.js";
import { getLastAuthMetadata, parseSsoKind } from "./GitHubAuth.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

export function rateLimitMessage(kind: "primary" | "secondary", resumeAt: number): string {
  const seconds = Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000));
  const human = formatCountdown(seconds);
  if (kind === "secondary") {
    return `GitHub secondary rate limit triggered. Resuming in ${human}.`;
  }
  return `GitHub rate limit exceeded. Resets in ${human}.`;
}

function formatCountdown(totalSeconds: number): string {
  if (totalSeconds <= 0) return "a moment";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

const TRANSIENT_API_MESSAGE = "GitHub is temporarily unavailable. Please retry.";
const PARTIAL_RESULTS_MESSAGE =
  "GitHub returned partial results — some organizations require SSO authorization.";

function getResponseHeader(error: RequestError, name: string): string | null {
  const value = error.response?.headers?.[name];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function ssoMessage(): string {
  const ssoUrl = getLastAuthMetadata()?.ssoUrl;
  return ssoUrl
    ? `SSO authorization required. Re-authorize at: ${ssoUrl}`
    : "SSO authorization required. Re-authorize at github.com.";
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  // `@octokit/request-error` re-wraps an aborted/timed-out fetch as a
  // RequestError with `.cause` pointing at the original AbortError. Inspect
  // the cause chain so timeouts surfaced through Octokit are still routed
  // to the network-error copy. (Lesson #3747.)
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return true;
  }
  return false;
}

function isNetworkLikeMessage(message: string): boolean {
  return (
    message.includes("ENOTFOUND") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EAI_AGAIN") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("timed out")
  );
}

export function parseGitHubError(error: unknown): string {
  if (error instanceof GitHubRateLimitError) {
    return rateLimitMessage(error.kind, error.resumeAt);
  }

  // The rate-limit service's Phase 1 header observation runs in the custom
  // fetch wrapper before Octokit wraps the error, so a triggered primary or
  // secondary limit is already reflected here even when the throw site sees
  // only a 403/429. Consulting the service first avoids substring-matching
  // a rate-limit body into the wrong bucket.
  const blockState = gitHubRateLimitService.shouldBlockRequest();
  if (blockState.blocked && blockState.reason && blockState.resumeAt) {
    return rateLimitMessage(blockState.reason, blockState.resumeAt);
  }

  if (error instanceof RequestError) {
    // Pre-HTTP-response failures (DNS, connection refused, abort/timeout,
    // network unreachable) are re-wrapped by Octokit with `status = 500`
    // and no `response`. Distinguish on `response === undefined` so real
    // server-side 5xx responses aren't conflated with a missing network.
    if (!error.response) {
      return "Cannot reach GitHub. Check your internet connection.";
    }

    const status = error.status;
    const message = error.message;

    if (status === 401) {
      // GitHub's API contract returns "Bad credentials" for genuinely
      // revoked or malformed tokens. Anything else at 401 is treated as a
      // transient auth-service blip — `GitHubTokenHealthService`'s 30-min
      // probe will independently confirm an unhealthy token if the failure
      // persists, so we err on the side of not flipping the dropdown into
      // reconnect-mode on a single ambiguous 401.
      if (message.includes("Bad credentials")) {
        return "Invalid GitHub token. Please update in Settings.";
      }
      return TRANSIENT_API_MESSAGE;
    }

    if (status === 403) {
      // 403 with a `required` SSO challenge — the token is valid but the
      // org demands re-authorization. Surface the captured URL when one is
      // available (and still inside its 1-hour TTL).
      const ssoKind = parseSsoKind(getResponseHeader(error, "x-github-sso"));
      if (ssoKind === "required") return ssoMessage();
      if (ssoKind === "partial") return PARTIAL_RESULTS_MESSAGE;
      // Any remaining 403 is treated as a scope/permission failure. Rate
      // limits and SSO challenges have already been peeled off above.
      return "Token lacks required permissions. Required scopes: repo, read:org";
    }

    if (status === 404) {
      return "Repository not found or token lacks access.";
    }

    if (status >= 500 && status <= 599) {
      return TRANSIENT_API_MESSAGE;
    }

    return `GitHub API error: ${message}`;
  }

  if (error instanceof GraphqlResponseError) {
    // Headers are captured even on 200-OK responses where the body's
    // `errors` array forces Octokit to throw — partial-results SSO
    // surfaces here.
    const ssoHeader = error.headers?.["x-github-sso"];
    const ssoKind = parseSsoKind(typeof ssoHeader === "string" ? ssoHeader : null);
    if (ssoKind === "required") return ssoMessage();
    if (ssoKind === "partial") return PARTIAL_RESULTS_MESSAGE;
    const first = error.errors?.[0]?.message ?? error.message;
    return `GitHub API error: ${first}`;
  }

  const message = formatErrorMessage(error, "GitHub request failed");

  // Pre-classified strings — pass through verbatim so re-thrown errors
  // (e.g. `throw new Error(parseGitHubError(error))` re-caught by an outer
  // handler) don't get re-wrapped into `GitHub API error: ...`.
  if (
    message === "GitHub token not configured. Set it in Settings." ||
    message === "Invalid GitHub token. Please update in Settings." ||
    message === "Token lacks required permissions. Required scopes: repo, read:org" ||
    message === "Issue not found or you don't have access to this repository" ||
    message === "Repository not found or token lacks access." ||
    message.startsWith("Cannot assign user ") ||
    message.startsWith("Assignment succeeded but user ") ||
    message.startsWith("Invalid GitHub API response:") ||
    message === "Cannot reach GitHub. Check your internet connection." ||
    message === TRANSIENT_API_MESSAGE ||
    message === PARTIAL_RESULTS_MESSAGE ||
    message.startsWith("SSO authorization required.") ||
    message.startsWith("GitHub rate limit exceeded.") ||
    message.startsWith("GitHub secondary rate limit triggered.")
  ) {
    return message;
  }

  if (isAbortLike(error) || isNetworkLikeMessage(message)) {
    return "Cannot reach GitHub. Check your internet connection.";
  }

  // Legacy substring fallback — only fires for non-Octokit error sources
  // (plain `new Error("...")` thrown by callers that pre-flatten a failure,
  // or service-layer code that surfaces a synthetic string error). Typed
  // Octokit errors are caught by the dispatch above, so the original
  // misclassification bug — flattening a status-bearing RequestError and
  // matching on a `"401"` / `"403"` substring — no longer fires here. The
  // bare `"401"` match is intentionally omitted; only a definitive
  // "Bad credentials" string maps to invalid-token in the fallback.
  if (message.includes("rate limit") || message.includes("API rate limit")) {
    return "GitHub rate limit exceeded. Try again in a few minutes.";
  }
  if (message.includes("Bad credentials")) {
    return "Invalid GitHub token. Please update in Settings.";
  }
  if (message.includes("SAML") || message.includes("SSO")) {
    return ssoMessage();
  }
  if (message.includes("403")) {
    return "Token lacks required permissions. Required scopes: repo, read:org";
  }
  if (message.includes("404") || message.includes("Could not resolve")) {
    return "Repository not found or token lacks access.";
  }

  return `GitHub API error: ${message}`;
}

export function rateLimitMeta(): {
  rateLimit?: { kind: "primary" | "secondary"; resumeAt: number };
} {
  const block = gitHubRateLimitService.shouldBlockRequest();
  if (block.blocked && block.reason && block.resumeAt) {
    return { rateLimit: { kind: block.reason, resumeAt: block.resumeAt } };
  }
  return {};
}
