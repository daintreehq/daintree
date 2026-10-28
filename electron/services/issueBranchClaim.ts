/**
 * Branch names an issues provider claims as its own issues (#13744). While a
 * provider is bound as a project's issues provider, it reports the literal key
 * prefixes its issues carry (`ENG`, `DES`), and a branch containing
 * `<KEY>-<n>` as a whole token — `eng-42-fix-login`, `jo/ENG-42-fix` — is that
 * provider's issue rather than a code-forge number.
 *
 * Keys are matched literally: the host validates, escapes and anchors them
 * itself, so a provider never supplies a pattern to run here.
 */

/** The issues provider claiming branch names for this host's project. */
export interface IssueBranchClaim {
  /** Canonical id of the issues provider. */
  providerId: string;
  keys: string[];
}

/**
 * Who owns a monitor's branch-claimed issue number. `issueId` arrives once the
 * provider has looked the key up.
 */
export interface IssueClaimProvenance {
  issueProviderId: string;
  issueKey: string;
  issueId?: string;
}

/** A branch-claimed issue: the provider's key plus its number. */
export interface ClaimedIssue {
  number: number;
  issueProviderId: string;
  /** Normalized display key (`"ENG-42"`). */
  issueKey: string;
}

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/;
const MAX_KEYS = 64;

const SKIP_BRANCHES = ["main", "master", "develop", "staging", "production", "release", "hotfix"];

/** Long-lived branches never name an issue, whatever their name contains. */
export function isIssueSkipBranch(branchName: string): boolean {
  const lower = branchName.trim().toLowerCase();
  return SKIP_BRANCHES.some((skip) => lower === skip || lower.startsWith(`${skip}/`));
}

/**
 * Normalize a provider's reported keys: uppercase, drop anything that isn't a
 * literal key, dedupe, longest first so `ENGX` isn't shadowed by `ENG`.
 */
export function normalizeIssueBranchKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const valid = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const upper = key.trim().toUpperCase();
    if (KEY_PATTERN.test(upper)) valid.add(upper);
    if (valid.size >= MAX_KEYS) break;
  }
  return [...valid].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * A matcher for `<KEY>-<n>` as a whole token, case-insensitive. The boundaries
 * are lookarounds rather than `\b`, which treats `_` as a word character, so
 * `jo/eng-42_fix` still claims while `beng-42` and `eng-42x` don't.
 */
export function buildIssueBranchMatcher(keys: string[]): RegExp | null {
  const normalized = normalizeIssueBranchKeys(keys);
  if (normalized.length === 0) return null;
  const alternation = normalized.map((key) => key.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|");
  return new RegExp(`(?<![A-Za-z0-9])(${alternation})-(\\d+)(?![A-Za-z0-9])`, "i");
}

let current: { claim: IssueBranchClaim; matcher: RegExp } | null = null;

/**
 * Install the claim this host's project has now, or `null` for none. Returns
 * whether anything changed, so the caller re-reads its worktrees only then.
 */
export function setIssueBranchClaim(claim: IssueBranchClaim | null): boolean {
  const keys = claim ? normalizeIssueBranchKeys(claim.keys) : [];
  const matcher = claim && claim.providerId ? buildIssueBranchMatcher(keys) : null;
  const next = claim && matcher ? { claim: { providerId: claim.providerId, keys }, matcher } : null;
  const changed =
    (current?.claim.providerId ?? null) !== (next?.claim.providerId ?? null) ||
    (current?.claim.keys.join(",") ?? "") !== (next?.claim.keys.join(",") ?? "");
  current = next;
  return changed;
}

/** The claim currently installed, for tests and diagnostics. */
export function getIssueBranchClaim(): IssueBranchClaim | null {
  return current ? { ...current.claim, keys: [...current.claim.keys] } : null;
}

function claimFrom(text: string | undefined): ClaimedIssue | null {
  if (!current || !text) return null;
  const match = current.matcher.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const key = match[1].toUpperCase();
  return { number, issueProviderId: current.claim.providerId, issueKey: `${key}-${number}` };
}

/**
 * The issue a worktree's branch (or, failing that, its folder) names in the
 * claiming provider's key format. Claims run before the built-in `issue-N`
 * patterns, which match anywhere in a name: `eng-42-fix-gh-7` is `ENG-42`.
 */
export function claimIssueFromBranch(
  branchName: string | undefined,
  folderName?: string
): ClaimedIssue | null {
  if (!current || !branchName || typeof branchName !== "string") return null;
  if (isIssueSkipBranch(branchName)) return null;
  return claimFrom(branchName.trim()) ?? claimFrom(folderName?.trim());
}
