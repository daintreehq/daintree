import type { GitStatus, StagingFileEntry } from "@shared/types";
import type { GitOperationReason } from "@shared/types/ipc/errors";
import { getGitRecoveryHint } from "@shared/utils/gitOperationErrors";
import { isClientGitError } from "@/utils/clientGitError";
import { isGeneratedFile } from "../generatedFileClassifier";

export type DiffMode = "working-tree" | "base-branch";

export interface PushErrorState {
  reason: GitOperationReason;
  rawMessage: string;
  /** Captured `refs/remotes/origin/<branch>` SHA at push-rejection time. */
  leaseSha?: string;
  /** Local branch name resolved at push-rejection time. */
  branchName?: string;
}

export type PushBannerCta =
  /**
   * Routes to the active forge provider's settings subtab. `providerId` is the
   * resolved provider's canonical `{pluginId}.{contributionId}` id (the
   * Code-forge settings subtab key), supplied at render time by
   * {@link getPushBannerConfig} — the static config table can't know the
   * runtime-resolved provider.
   */
  | { kind: "settings-forge"; label: string; providerId: string }
  | { kind: "retry"; label: string }
  | { kind: "pull-rebase"; label: string }
  | { kind: "force-push"; label: string };

/**
 * "hide" — raw stderr is suppressed entirely (auth/network/transient — raw
 * output is jargon-y and not actionable to the user).
 * "collapse" — raw stderr lives behind a "Show details" toggle (policy/hook/
 * unknown — the server-side text often contains the only actionable signal).
 */
export type PushDetailPolicy = "hide" | "collapse";

export interface PushBannerConfig {
  message: string;
  detailPolicy: PushDetailPolicy;
  cta?: PushBannerCta;
  /** Optional secondary CTA rendered alongside the primary. */
  secondaryCta?: PushBannerCta;
}

/**
 * Map each `GitOperationReason` to a banner config. Hint copy comes from the
 * shared `getGitRecoveryHint` (so it stays consistent with notification-store
 * and other surfaces); only the `unknown` fallback inlines its own copy.
 *
 * CTAs are limited to actions the renderer can actually dispatch:
 *  - `app.settings.openTab` (real BuiltInActionId) for `auth-failed`
 *  - inline `handleRetryPush` for `network-unavailable` / `system-io-error`
 *  - inline `handlePullRebase` / force-push dialog for `push-rejected-outdated`
 * `RECOVERY_ACTIONS` in `shared/utils/gitOperationErrors.ts` references several
 * actionIds that aren't registered (`git.pull`, `github.auth`,
 * `git.resolveConflicts`, `git.trustRepository`) — wiring those would surface
 * broken buttons. A clear hint with no CTA is better than a broken CTA.
 */
export const PUSH_BANNER_CONFIGS: Record<GitOperationReason, PushBannerConfig> = {
  "auth-failed": {
    message: getGitRecoveryHint("auth-failed") ?? "Authentication failed.",
    detailPolicy: "hide",
    // The settings CTA is stamped at render time by getPushBannerConfig once
    // the active forge provider resolves — no CTA when it can't, since there's
    // no provider-agnostic settings route to send the user to.
  },
  "rate-limited": {
    message:
      getGitRecoveryHint("rate-limited") ??
      "The forge is rate-limiting requests. Try again shortly.",
    detailPolicy: "hide",
    cta: { kind: "retry", label: "Retry" },
  },
  "network-unavailable": {
    message: getGitRecoveryHint("network-unavailable") ?? "Could not reach the remote.",
    detailPolicy: "hide",
    cta: { kind: "retry", label: "Retry" },
  },
  "system-io-error": {
    message: getGitRecoveryHint("system-io-error") ?? "A filesystem error blocked the push.",
    detailPolicy: "hide",
    cta: { kind: "retry", label: "Retry" },
  },
  "git-not-installed": {
    message: getGitRecoveryHint("git-not-installed") ?? "Daintree couldn't run Git.",
    // No retry CTA: the push can't succeed until Git is installed, and the
    // raw detail is a Node stack trace with nothing for the user in it.
    detailPolicy: "hide",
  },
  "push-rejected-outdated": {
    message:
      getGitRecoveryHint("push-rejected-outdated") ??
      "The remote has new commits. Pull and rebase before pushing.",
    detailPolicy: "hide",
    cta: { kind: "pull-rebase", label: "Pull and rebase" },
  },
  "push-rejected-policy": {
    message:
      getGitRecoveryHint("push-rejected-policy") ??
      "The remote rejected this push (protected branch or repository rule).",
    detailPolicy: "collapse",
  },
  "hook-rejected": {
    message: getGitRecoveryHint("hook-rejected") ?? "A server-side hook rejected the push.",
    detailPolicy: "collapse",
  },
  "repository-not-found": {
    message: getGitRecoveryHint("repository-not-found") ?? "The remote repository is unreachable.",
    detailPolicy: "hide",
  },
  "not-a-repository": {
    message: getGitRecoveryHint("not-a-repository") ?? "This folder is not a git repository.",
    detailPolicy: "hide",
  },
  "dubious-ownership": {
    message:
      getGitRecoveryHint("dubious-ownership") ?? "Git refuses to operate on this repository.",
    detailPolicy: "collapse",
  },
  "config-missing": {
    message:
      getGitRecoveryHint("config-missing") ?? "The current branch is missing upstream config.",
    detailPolicy: "hide",
  },
  "worktree-dirty": {
    message:
      getGitRecoveryHint("worktree-dirty") ?? "You have local changes that would be overwritten.",
    detailPolicy: "collapse",
  },
  "conflict-unresolved": {
    message:
      getGitRecoveryHint("conflict-unresolved") ?? "Resolve merge conflicts before continuing.",
    detailPolicy: "collapse",
  },
  "pathspec-invalid": {
    message: getGitRecoveryHint("pathspec-invalid") ?? "The specified ref or path does not exist.",
    detailPolicy: "collapse",
  },
  "lfs-missing": {
    message: getGitRecoveryHint("lfs-missing") ?? "Git LFS objects are missing.",
    detailPolicy: "collapse",
  },
  "lfs-quota-exceeded": {
    message:
      getGitRecoveryHint("lfs-quota-exceeded") ?? "This repository exceeded its Git LFS quota.",
    detailPolicy: "hide",
  },
  unknown: {
    message: "See details for more.",
    detailPolicy: "collapse",
  },
};

/**
 * Pulls the divergence-recovery fields off a thrown value. `GitOperationError`
 * promotes `gitReason`/`leaseSha`/`branchName` to top-level fields on the
 * serialized error envelope (`SerializedError`), but Electron's contextBridge
 * strips own Error properties when the preload's reconstructed error crosses
 * the preload→renderer realm. The preload encodes the discriminant fields
 * into a `[GitError|<reason>|<leaseSha>|<branchName>]` message prefix;
 * {@link isClientGitError} decodes it and side-effects the fields back onto
 * the error. Same-realm throws (renderer tests, no contextBridge crossing)
 * fall through to the duck-typed reads below.
 */
export function readGitErrorFields(err: unknown): {
  gitReason?: GitOperationReason;
  leaseSha?: string;
  branchName?: string;
} {
  if (!(err instanceof Error)) return {};
  isClientGitError(err);
  const gitReason = Reflect.get(err, "gitReason");
  const leaseSha = Reflect.get(err, "leaseSha");
  const branchName = Reflect.get(err, "branchName");
  return {
    // GitOperationReason is a closed string union — runtime-validated via the
    // typeof string check; the cast narrows the union for downstream consumers.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    gitReason: typeof gitReason === "string" ? (gitReason as GitOperationReason) : undefined,
    leaseSha: typeof leaseSha === "string" ? leaseSha : undefined,
    branchName: typeof branchName === "string" ? branchName : undefined,
  };
}

export function getPushBannerConfig(
  state: PushErrorState,
  behindCount?: number,
  /**
   * Resolved forge provider's `contribution.id`. When present, `auth-failed`
   * gains a "Open forge settings" CTA routed to that provider's settings
   * subtab. When absent (no provider resolvable), the banner shows the message
   * with no settings CTA — there's no provider-agnostic route to offer.
   */
  forgeProviderId?: string | null
): PushBannerConfig {
  const base = PUSH_BANNER_CONFIGS[state.reason];
  if (state.reason === "auth-failed") {
    return forgeProviderId
      ? {
          ...base,
          cta: {
            kind: "settings-forge",
            label: "Open forge settings",
            providerId: forgeProviderId,
          },
        }
      : base;
  }
  // `push-rejected-outdated` is the only reason whose copy and CTAs depend on
  // runtime state (behindCount + whether we captured a lease SHA). Override the
  // table entry with a dynamic message and an optional force-push secondary
  // CTA — the latter only when we have a captured `refs/remotes/origin/<branch>`
  // SHA. Without that lease, `--force-with-lease` would silently degrade to
  // `--force` if a background fetch advanced the local remote-tracking ref
  // between rejection and click.
  if (state.reason === "push-rejected-outdated") {
    const remoteCount = behindCount && behindCount > 0 ? behindCount : null;
    const message = remoteCount
      ? `Remote has ${remoteCount} new commit${remoteCount === 1 ? "" : "s"}. Pull and rebase, or force push to overwrite.`
      : "The remote has new commits. Pull and rebase, or force push to overwrite.";
    return {
      ...base,
      message,
      secondaryCta:
        state.leaseSha && state.branchName
          ? { kind: "force-push", label: "Force push" }
          : undefined,
    };
  }
  return base;
}

const BASE_BRANCH_STATUS_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  A: { label: "A", bg: "bg-status-success/15", text: "text-status-success" },
  D: { label: "D", bg: "bg-status-error/15", text: "text-status-error" },
  M: { label: "M", bg: "bg-status-warning/15", text: "text-status-warning" },
  R: { label: "R", bg: "bg-status-info/15", text: "text-status-info" },
  C: { label: "C", bg: "bg-status-info/15", text: "text-status-info" },
  U: { label: "U", bg: "bg-status-error/15", text: "text-status-error" },
};

export function getBaseBranchStatusConfig(status: string): {
  label: string;
  bg: string;
  text: string;
} {
  return (
    BASE_BRANCH_STATUS_CONFIG[status] ?? {
      label: status,
      bg: "bg-tint/[0.06]",
      text: "text-daintree-text/40",
    }
  );
}

export type SortKey = "path" | "status" | "churn";
export type SortDirection = "asc" | "desc";
export type Density = "comfortable" | "compact";

export interface SectionViewState {
  filterQuery: string;
  sortKey: SortKey;
  sortDir: SortDirection;
  density: Density;
  showGenerated: boolean;
}

export const DEFAULT_SECTION_STATE: SectionViewState = {
  filterQuery: "",
  sortKey: "path",
  sortDir: "asc",
  density: "comfortable",
  showGenerated: true,
};

export function matchesFilter(path: string, query: string): boolean {
  const trimmed = query.trim().replace(/\\/g, "/");
  if (!trimmed) return true;

  const globChars = /[*?[\]{}()]/;
  if (globChars.test(trimmed)) {
    try {
      let regexStr = "";
      for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed.charAt(i);
        if (ch === "*") {
          regexStr += i + 1 < trimmed.length && trimmed.charAt(i + 1) === "*" ? ".*" : "[^/]*";
          if (i + 1 < trimmed.length && trimmed.charAt(i + 1) === "*") i++;
        } else if (ch === "?") {
          regexStr += "[^/]";
        } else if ("[]{}()".includes(ch)) {
          regexStr += "\\" + ch;
        } else if (".+^$|\\".includes(ch)) {
          regexStr += "\\" + ch;
        } else {
          regexStr += ch;
        }
      }
      return new RegExp(`^${regexStr}$`, "i").test(path.replace(/\\/g, "/"));
    } catch {
      // fall through to substring match
    }
  }

  return path.toLowerCase().includes(trimmed.toLowerCase());
}

export function sortFiles(
  files: StagingFileEntry[],
  key: SortKey,
  dir: SortDirection
): StagingFileEntry[] {
  const sorted = [...files];
  const statusOrder: GitStatus[] = [
    "modified",
    "added",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "conflicted",
    "ignored",
  ];

  sorted.sort((a, b) => {
    // Generated files sort last across every sort mode and direction — this
    // tier is intentionally outside the dir flip below so descending sorts
    // don't surface generated files first.
    const genTier = Number(isGeneratedFile(a.path)) - Number(isGeneratedFile(b.path));
    if (genTier !== 0) return genTier;

    let cmp: number;
    if (key === "path") {
      cmp = a.path.localeCompare(b.path);
    } else if (key === "churn") {
      const aChurn = (a.insertions ?? 0) + (a.deletions ?? 0);
      const bChurn = (b.insertions ?? 0) + (b.deletions ?? 0);
      cmp = aChurn - bChurn;
      if (cmp === 0) {
        cmp = a.path.localeCompare(b.path);
      }
    } else {
      const ai = statusOrder.indexOf(a.status);
      const bi = statusOrder.indexOf(b.status);
      cmp = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      if (cmp === 0) {
        cmp = a.path.localeCompare(b.path);
      }
    }
    return dir === "desc" ? -cmp : cmp;
  });

  return sorted;
}

/**
 * The pin for a Review Hub band header inside `review-hub-scroll-container`.
 *
 * Four band headers share this: both `FileSection` instances, the base-branch
 * "Changed vs <main>" header, and the conflict panel's two rails. They all sit
 * in the same scroll container, so one of them sticking while the others scroll
 * away is visible the moment a user switches diff mode.
 *
 * `bg-daintree-bg` is the hub root's own surface (`ReviewHubContent`) and is
 * here only to make the band opaque over rows passing underneath — the visible
 * tint is still the `bg-overlay-subtle` on the band itself, so a pinned header
 * looks exactly like an unpinned one.
 */
export const REVIEW_HUB_STICKY_BAND = "sticky top-0 z-10 bg-daintree-bg";

export type BulkScope = "selection" | "shown" | "all";

/**
 * The single source of truth for what a section's bulk action targets.
 *
 * Both the button's label and the handler the hub dispatches read this, because
 * they used to decide independently: the label branched on `filterQuery` alone
 * while the handler branched on `filterQuery || !showGenerated`. With generated
 * files hidden and no query, the button therefore read "Stage all (12)" and then
 * staged only the twelve shown, leaving the hidden ones behind. Any new thing
 * that narrows a section has to be added here, once, or that divergence returns.
 */
export function resolveBulkScope(view: SectionViewState, hasSelection: boolean): BulkScope {
  if (hasSelection) return "selection";
  return view.filterQuery || !view.showGenerated ? "shown" : "all";
}

/**
 * How many of a section's view settings differ from the defaults, so a collapsed
 * trigger can admit it is holding state. Sort key and direction count as one
 * setting — flipping direction is not a second decision the user made.
 *
 * `filterQuery` is deliberately excluded: it has its own always-visible field.
 */
export function countNonDefaultView(view: SectionViewState): number {
  let n = 0;
  if (
    view.sortKey !== DEFAULT_SECTION_STATE.sortKey ||
    view.sortDir !== DEFAULT_SECTION_STATE.sortDir
  ) {
    n += 1;
  }
  if (view.density !== DEFAULT_SECTION_STATE.density) n += 1;
  if (view.showGenerated !== DEFAULT_SECTION_STATE.showGenerated) n += 1;
  return n;
}

export function isSortKey(v: string): v is SortKey {
  return v === "path" || v === "status" || v === "churn";
}

export function isDensity(v: string): v is Density {
  return v === "comfortable" || v === "compact";
}

/**
 * Applies a sort-column click from a `DropdownMenuRadioGroup`: switches the
 * sort key, or flips direction when the same key is re-selected. Switching to
 * a new key defaults to descending for `churn` (biggest change first) and
 * otherwise keeps the current direction. `value` is untyped because it comes
 * from `onValueChange`'s string param; an unrecognized value leaves
 * `sortKey`/`sortDir` unchanged.
 */
export function applySortChange(prev: SectionViewState, value: string): SectionViewState {
  return {
    ...prev,
    sortKey: isSortKey(value) ? value : prev.sortKey,
    sortDir:
      prev.sortKey === value
        ? prev.sortDir === "asc"
          ? "desc"
          : "asc"
        : value === "churn"
          ? "desc"
          : prev.sortDir,
  };
}

export interface ChurnTotals {
  ins: number;
  del: number;
}

/** Sums insertions/deletions across a file list for a section's churn chip. */
export function sumChurn(
  files: { insertions: number | null; deletions: number | null }[]
): ChurnTotals {
  return files.reduce<ChurnTotals>(
    (acc, f) => ({
      ins: acc.ins + (f.insertions ?? 0),
      del: acc.del + (f.deletions ?? 0),
    }),
    { ins: 0, del: 0 }
  );
}

const FILTER_QUERY_DISPLAY_MAX = 40;

// Filter-query echoes in narrow sidebar surfaces would overflow otherwise:
// file paths regularly exceed 40 chars and the panel can sit at ~200px.
export function truncateFilterQuery(query: string): string {
  const codepoints = Array.from(query);
  return codepoints.length > FILTER_QUERY_DISPLAY_MAX
    ? `${codepoints.slice(0, FILTER_QUERY_DISPLAY_MAX).join("")}…`
    : query;
}
