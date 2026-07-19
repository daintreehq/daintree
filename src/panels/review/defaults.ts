import type { ReviewPanelData } from "@shared/types/panel";
import type { ReviewPanelOptions } from "@shared/types/addPanelOptions";

// Review panels have no kind-specific *persisted* defaults — id/title/location/
// worktreeId are filled in by addTerminal from the common base. The two fields
// below are open-time hints (see `ReviewPanelData`); `serializeReview` omits
// them so they never survive into a restored panel.

export function createReviewDefaults(options: ReviewPanelOptions): Partial<ReviewPanelData> {
  return {
    // `!= null` rather than truthiness: an explicit "" seed and an explicit
    // `false` are both meaningful, and dropping them here would let a stale
    // record's value stand in for a deliberate empty.
    ...(options.initialCommitMessage != null && {
      initialCommitMessage: options.initialCommitMessage,
    }),
    ...(options.autoStageOnOpen != null && { autoStageOnOpen: options.autoStageOnOpen }),
  };
}
