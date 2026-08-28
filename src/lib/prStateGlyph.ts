import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react";

/**
 * The glyph a pull request's state is drawn with.
 *
 * The two PR marks in `src/` — the worktree card's badge and the Review Hub's
 * chip — each drew one unchanging `GitPullRequest` in three colours
 * (`text-pr-open`, `-merged`, `-closed`), which put the whole distinction on
 * hue (WCAG SC 1.4.1) at 12-14px, with the state word living only in an
 * `aria-label`. The chip does show that word beside the glyph; the card's
 * badge does not.
 *
 * The GitHub plugin's list had already worked this out for itself and written
 * down why. This is that map lifted so all three share one answer rather than
 * the plugin being right on its own.
 *
 * The domain is `NormalizedPRState` (`shared/types/forge.ts`) — `open`,
 * `merged`, `closed`, `declined` — plus `undefined` while a PR is still being
 * resolved, which reads as open. `declined` is Bitbucket's spelling of
 * `closed`. The parameter stays `string` because the plugin's own list items
 * carry it as one; anything outside the domain falls through to closed, which
 * is the safe direction — a stale or unknown state should not claim to be an
 * open PR someone can still push to.
 *
 * `draft` is NOT one of these. It is a separate boolean on `PR`, and neither
 * worktree surface has it: `PluginWorktreeLinkedPR` carries the state but no
 * draft flag, so both call this without one and get the plain open glyph.
 */
export function getPrStateGlyph(state: string | undefined, isDraft?: boolean): LucideIcon {
  if (state === "merged") return GitMerge;
  if (state === undefined || state === "open") {
    // A draft reads as "open but not ready" — its own glyph, not the open one
    // recoloured. Colour alone can't carry the distinction on a 16px mark.
    return isDraft ? GitPullRequestDraft : GitPullRequest;
  }
  return GitPullRequestClosed;
}

/** The tone that rides with the glyph. Shape and colour agree; neither substitutes. */
export function getPrStateColor(state: string | undefined, isDraft?: boolean): string {
  if (isDraft) return "text-pr-draft";
  if (state === "merged") return "text-pr-merged";
  if (state === undefined || state === "open") return "text-pr-open";
  return "text-pr-closed";
}
