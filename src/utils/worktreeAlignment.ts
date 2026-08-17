import type { PanelWorktreeMoveOptOut } from "@shared/types/panel";
import { inferWorktreeIdFromCwd } from "./worktreePaths";

/**
 * Where a panel's process was launched, relative to the worktree the panel is
 * (or is about to be) filed under.
 *
 * Deliberately not "PWD divergence": there is no live PWD to read. Agents don't
 * emit shell prompts, so OSC 7 never fires when it matters (#1605). This is a
 * launch-root check and nothing more.
 */
export type LaunchRootAlignment = "aligned" | "launch-root-mismatch" | "unknown";

function normalizeForComparison(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Reconcile the renderer's mirrored `panel.cwd` against the backend's
 * authoritative launch cwd from `terminal.getInfo`.
 *
 * A disagreement returns `undefined` rather than picking a winner: neither value
 * has earned the right to speak for the process, and `undefined` classifies as
 * `unknown`, which asks the user instead of assuming.
 */
export function resolveLaunchCwd(
  panelCwd: string | undefined,
  backendCwd: string | undefined
): string | undefined {
  const panel = panelCwd?.trim() ? panelCwd : undefined;
  const backend = backendCwd?.trim() ? backendCwd : undefined;
  if (!backend) return panel;
  if (!panel) return backend;
  return normalizeForComparison(panel) === normalizeForComparison(backend) ? backend : undefined;
}

/**
 * Classify a launch cwd against a worktree id.
 *
 * Built on `inferWorktreeIdFromCwd` rather than string equality: it is
 * segment-aware, normalizes separators and trailing slashes, and takes the
 * longest match, so a subdirectory launch and a nested worktree path both
 * resolve correctly where `===` or `startsWith` would not.
 *
 * Anything unprovable is `unknown` — an empty cwd, a cwd under no worktree, a
 * panel with no worktree of its own. Callers must treat `unknown` as "ask",
 * never as "aligned".
 */
export function classifyLaunchRootAlignment(
  cwd: string | undefined,
  worktrees: ReadonlyArray<{ id: string; path: string }> | undefined,
  worktreeId: string | undefined
): LaunchRootAlignment {
  if (!worktreeId) return "unknown";
  const inferred = inferWorktreeIdFromCwd(cwd, worktrees);
  if (inferred === undefined) return "unknown";
  return inferred === worktreeId ? "aligned" : "launch-root-mismatch";
}

export interface WorktreeDivergenceWorktree {
  id: string;
  path: string;
  name?: string;
  /** HEAD as last polled, for the drift comparison. */
  headOid?: string;
}

export type WorktreeDivergence =
  | { kind: "none" }
  | {
      kind: "diverged";
      /** Where the process actually runs, named if it maps to a worktree. */
      launchLabel: string;
      /** False when the launch root maps to no live worktree — say so, don't guess. */
      launchResolved: boolean;
      /** The launch root's HEAD has moved since consent was given. */
      headDrifted: boolean;
    };

/**
 * Whether a panel is currently living under a worktree its process never
 * entered, with the user's recorded consent.
 *
 * Derived rather than stored as a boolean. The fact of divergence is a live
 * comparison between the launch cwd and the filed worktree, so a restart that
 * re-anchors the process clears the marker on its own, and one that doesn't
 * keeps it — which is right, because the divergence is still there. The stored
 * record only carries the consent and the drift baseline, and applies solely to
 * the cwd and worktree it was given for.
 */
export function deriveWorktreeDivergence(
  panel: {
    cwd?: string;
    worktreeId?: string;
    worktreeMoveOptOut?: PanelWorktreeMoveOptOut;
  },
  worktrees: ReadonlyArray<WorktreeDivergenceWorktree> | undefined
): WorktreeDivergence {
  const optOut = panel.worktreeMoveOptOut;
  if (!optOut) return { kind: "none" };
  if (!panel.worktreeId) return { kind: "none" };
  // Normalized, not `===`: hydration can hand back a separator- or
  // trailing-slash variant of the same directory, and losing the marker over
  // punctuation would hide a live divergence.
  if (!panel.cwd) return { kind: "none" };
  if (normalizeForComparison(optOut.acknowledgedCwd) !== normalizeForComparison(panel.cwd)) {
    return { kind: "none" };
  }

  // Only proven alignment clears the marker, and only when the consent wasn't
  // recorded against an unresolvable launch root in the first place. `unknown`
  // means the renderer's cwd and the backend's disagreed, or the cwd sat under
  // no worktree at all — so a cwd that now *looks* aligned proves nothing, and
  // treating "can't prove it" as "it's fine" is the original bug. This is also
  // what keeps the marker alive once the launch worktree has been deleted.
  if (
    optOut.acknowledgedAlignment !== "unknown" &&
    classifyLaunchRootAlignment(panel.cwd, worktrees, panel.worktreeId) === "aligned"
  ) {
    return { kind: "none" };
  }

  const launchWorktree = optOut.launchWorktreeId
    ? worktrees?.find((w) => w.id === optOut.launchWorktreeId)
    : undefined;
  const launchResolved = launchWorktree !== undefined;

  return {
    kind: "diverged",
    launchLabel: launchWorktree?.name ?? launchWorktree?.path ?? optOut.launchCwd ?? panel.cwd,
    launchResolved,
    // Only a positive comparison counts as drift. An unknown baseline, or a
    // worktree that hasn't been polled yet, is "don't know", not "moved" —
    // but a `null` baseline is a known-unborn HEAD, so the launch root's first
    // commit is real drift.
    headDrifted:
      optOut.sourceHeadOid !== undefined &&
      launchWorktree?.headOid !== undefined &&
      launchWorktree.headOid !== optOut.sourceHeadOid,
  };
}
