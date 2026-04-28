import type { ErrorRecord, ErrorType, GitOperationReason } from "../types/ipc/errors.js";
import { getGitRecoveryHint } from "./gitOperationErrors.js";

/**
 * Extract a human-readable message from an unknown caught error, falling back
 * to a caller-supplied domain string for opaque or non-Error values.
 *
 * The fallback is required (no default) so every call site supplies its own
 * operation context — replacing the ad-hoc `err instanceof Error ? err.message
 * : "Unknown error"` ternary that produced uninformative UI copy.
 *
 * Duck-types `{ message: string }` because Electron's structured clone strips
 * the Error prototype across IPC, leaving plain objects that fail
 * `instanceof Error` but still carry the original message.
 */
export function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    try {
      if ("message" in error) {
        const message = (error as { message: unknown }).message;
        if (typeof message === "string") return message;
      }
    } catch {
      // Proxies with throwing `has` traps or accessor errors fall back.
    }
  }
  return fallback;
}

/**
 * Friendly user-facing copy keyed by `ErrorType`. Used as the fallback when
 * no more-specific mapping (e.g. by `gitReason`) applies. The `satisfies`
 * clause forces compile-time exhaustiveness across the `ErrorType` union.
 */
const ERROR_TYPE_FALLBACKS = {
  git: {
    title: "Git operation failed",
    body: "A git operation didn't complete. Open the panel for details, or try again.",
  },
  process: {
    title: "Background process failed",
    body: "A background process couldn't complete the requested operation.",
  },
  filesystem: {
    title: "File operation failed",
    body: "Daintree couldn't read or update the requested files.",
  },
  network: {
    title: "Network problem",
    body: "Daintree couldn't reach the remote service. Check your connection and try again.",
  },
  config: {
    title: "Configuration problem",
    body: "Daintree found a problem with the current configuration.",
  },
  validation: {
    title: "Invalid input",
    body: "Daintree received invalid input for this operation.",
  },
  unknown: {
    title: "Something went wrong",
    body: "Daintree hit an unexpected problem. Open the panel for details.",
  },
} as const satisfies Record<ErrorType, { title: string; body: string }>;

/**
 * Short user-facing titles keyed by `GitOperationReason`. Bodies for known
 * reasons come from `getGitRecoveryHint()` which already returns
 * instruction-grade copy. The `satisfies` clause enforces full coverage.
 */
const GIT_REASON_TITLES = {
  "auth-failed": "Git authentication failed",
  "network-unavailable": "Couldn't reach the remote",
  "repository-not-found": "Repository not found",
  "not-a-repository": "Not a git repository",
  "dubious-ownership": "Repository ownership not trusted",
  "config-missing": "Git configuration incomplete",
  "worktree-dirty": "Local changes would be overwritten",
  "conflict-unresolved": "Merge conflicts unresolved",
  "push-rejected-outdated": "Push rejected — branch out of date",
  "push-rejected-policy": "Push blocked by repository policy",
  "pathspec-invalid": "Branch or path not found",
  "lfs-missing": "Git LFS object missing",
  "lfs-quota-exceeded": "Git LFS quota exceeded",
  "hook-rejected": "Push rejected by server hook",
  "system-io-error": "Git filesystem error",
  unknown: ERROR_TYPE_FALLBACKS.git.title,
} as const satisfies Record<GitOperationReason, string>;

/**
 * Translate an `ErrorRecord` into user-facing toast copy.
 *
 * The renderer should never pipe `error.source` (an internal service
 * identifier such as `"WorktreeMonitor"` or `"main-process"`) or raw library
 * messages (`"EBUSY: resource busy or locked /Users/.../foo"`) into a toast.
 * This function is the single translation point that maps the structured
 * `ErrorRecord` into a friendly `{ title, body }` pair.
 *
 * Resolution order:
 *   1. `gitReason` (when present and not `"unknown"`) → `GIT_REASON_TITLES`
 *      title + `getGitRecoveryHint()` body, falling back to the `git`
 *      fallback body when the hint is undefined.
 *   2. `recoveryHint` (when present) → `ErrorType` fallback title + the
 *      hint as the body.
 *   3. `ErrorType` fallback table.
 *
 * Raw `error.message` is never used as the toast body — it's reserved for
 * the structured Copy details payload assembled at the call site.
 */
export function humanizeAppError(
  error: Pick<ErrorRecord, "type" | "source" | "message" | "gitReason" | "recoveryHint">
): { title: string; body: string } {
  if (error.gitReason && error.gitReason !== "unknown") {
    // The `satisfies` constraint is compile-time only; an out-of-union string
    // can still arrive via IPC during version skew (newer main, older
    // renderer). Fall back to the generic git title so the toast never
    // renders with `title: undefined`.
    const reasonTitle = GIT_REASON_TITLES[error.gitReason];
    const hint = getGitRecoveryHint(error.gitReason);
    return {
      title: reasonTitle ?? ERROR_TYPE_FALLBACKS.git.title,
      body: hint ?? ERROR_TYPE_FALLBACKS.git.body,
    };
  }

  const fallback = ERROR_TYPE_FALLBACKS[error.type] ?? ERROR_TYPE_FALLBACKS.unknown;

  if (error.recoveryHint && error.recoveryHint.length > 0) {
    return { title: fallback.title, body: error.recoveryHint };
  }

  return fallback;
}
