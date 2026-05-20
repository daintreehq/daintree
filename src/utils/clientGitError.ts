import type { GitOperationReason } from "../../shared/types/ipc/errors";

/**
 * Renderer-side mirror of the main-process `GitOperationError`. Reconstructed
 * by the preload's `_unwrappingInvoke` when an IPC handler throws a
 * `GitOperationError`, so callers can branch on the discriminated `gitReason`
 * (and the divergence-recovery `leaseSha`/`branchName`) instead of substring-
 * matching `e.message`.
 *
 * `instanceof ClientGitError` is unreliable across the contextBridge realm
 * boundary — use the {@link isClientGitError} guard, which decodes the
 * `[GitError|<reason>|<urlencoded leaseSha>|<urlencoded branchName>] message`
 * prefix that the preload sets on `e.message`. Electron's contextBridge strips
 * ALL custom properties on Error instances (including own `name`) when an
 * error crosses the preload→renderer realm, so the prefix is the only reliable
 * carrier for the discriminant fields.
 */
export class ClientGitError extends Error {
  readonly gitReason: GitOperationReason;
  readonly leaseSha?: string;
  readonly branchName?: string;

  constructor(
    gitReason: GitOperationReason,
    message: string,
    leaseSha?: string,
    branchName?: string
  ) {
    super(message);
    this.name = "GitOperationError";
    this.gitReason = gitReason;
    if (leaseSha !== undefined) this.leaseSha = leaseSha;
    if (branchName !== undefined) this.branchName = branchName;
    Object.setPrototypeOf(this, ClientGitError.prototype);
  }
}

// Matches the prefix injected by the preload's `_reconstructGitError`.
// Group 1: gitReason (lowercase kebab — `GitOperationReason` union).
// Group 2: urlencoded leaseSha (may be empty when absent).
// Group 3: urlencoded branchName (may be empty when absent).
// Group 4: the original human-readable message after the closing `]`.
// Encoded fields contain no literal `|` or `]` (encodeURIComponent escapes
// them as `%7C`/`%5D`), so the positional character classes are safe.
const ENCODED_GIT_ERROR_PATTERN = /^\[GitError\|([a-z-]+)\|([^|]*)\|([^\]]*)\] (.*)$/s;

function decodeOptional(encoded: string): string | undefined {
  if (encoded === "") return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * Realm-safe guard. Decodes the `[GitError|<reason>|<leaseSha>|<branchName>]`
 * prefix that the preload sets when an IPC handler throws a
 * `GitOperationError`, and as a side effect attaches `name`, `gitReason`,
 * `leaseSha`, `branchName`, and the cleaned `message` back onto the error so
 * callers can read them directly.
 *
 * Idempotent — after the first call the prefix is stripped from `e.message`,
 * so a second call goes through the same-realm fallback and returns the same
 * result.
 *
 * Falls back to duck-typing on `name === "GitOperationError" && typeof gitReason === "string"`
 * for errors that originate inside the renderer realm (where contextBridge is
 * not in the path and own properties survive).
 */
export function isClientGitError(
  e: unknown
): e is Error & { gitReason: GitOperationReason; leaseSha?: string; branchName?: string } {
  if (!(e instanceof Error)) return false;

  const match = ENCODED_GIT_ERROR_PATTERN.exec(e.message);
  if (match) {
    const [, reason, encodedLeaseSha, encodedBranchName, originalMessage] = match;
    const target = e as Error & {
      gitReason?: string;
      leaseSha?: string;
      branchName?: string;
    };
    target.name = "GitOperationError";
    // GitOperationReason is a closed union; the cast narrows the runtime
    // string (validated by the regex character class) for downstream consumers.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    target.gitReason = reason as GitOperationReason;
    const leaseSha = decodeOptional(encodedLeaseSha ?? "");
    const branchName = decodeOptional(encodedBranchName ?? "");
    if (leaseSha !== undefined) target.leaseSha = leaseSha;
    if (branchName !== undefined) target.branchName = branchName;
    e.message = originalMessage ?? e.message;
    return true;
  }

  // Same-realm fallback (no contextBridge crossing).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type narrowed by guard checks below
  const candidate = e as { gitReason?: unknown };
  return e.name === "GitOperationError" && typeof candidate.gitReason === "string";
}
