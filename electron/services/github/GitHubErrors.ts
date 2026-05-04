import { gitHubRateLimitService, GitHubRateLimitError } from "./GitHubRateLimitService.js";
import { getLastAuthMetadata } from "./GitHubAuth.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

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

export function parseGitHubError(error: unknown): string {
  if (error instanceof GitHubRateLimitError) {
    return rateLimitMessage(error.kind, error.resumeAt);
  }
  const message = formatErrorMessage(error, "GitHub request failed");
  const isTimeout = error instanceof Error && error.name === "TimeoutError";

  if (
    message === "GitHub token not configured. Set it in Settings." ||
    message === "Invalid GitHub token. Please update in Settings." ||
    message === "Token lacks required permissions. Required scopes: repo, read:org" ||
    message === "Issue not found or you don't have access to this repository" ||
    message.startsWith("Cannot assign user ") ||
    message.startsWith("Assignment succeeded but user ") ||
    message.startsWith("Invalid GitHub API response:") ||
    message === "Cannot reach GitHub. Check your internet connection."
  ) {
    return message;
  }

  const blockState = gitHubRateLimitService.shouldBlockRequest();
  if (blockState.blocked && blockState.reason && blockState.resumeAt) {
    return rateLimitMessage(blockState.reason, blockState.resumeAt);
  }

  if (message.includes("rate limit") || message.includes("API rate limit")) {
    return "GitHub rate limit exceeded. Try again in a few minutes.";
  }

  if (message.includes("401") || message.includes("Bad credentials")) {
    return "Invalid GitHub token. Please update in Settings.";
  }

  if (message.includes("SAML") || message.includes("SSO")) {
    const ssoUrl = getLastAuthMetadata()?.ssoUrl;
    if (ssoUrl) {
      return `SSO authorization required. Re-authorize at: ${ssoUrl}`;
    }
    return "SSO authorization required. Re-authorize at github.com.";
  }

  if (message.includes("403")) {
    return "Token lacks required permissions. Required scopes: repo, read:org";
  }

  if (message.includes("404") || message.includes("Could not resolve")) {
    return "Repository not found or token lacks access.";
  }

  if (
    isTimeout ||
    message.includes("ENOTFOUND") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EAI_AGAIN") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("timed out")
  ) {
    return "Cannot reach GitHub. Check your internet connection.";
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
