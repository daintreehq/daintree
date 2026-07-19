import type { ReviewPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

// Review panels persist nothing beyond BasePanelData — the worktree path is
// resolved fresh from the worktree store at render time, so there is no kind-
// specific snapshot fragment.
//
// `initialCommitMessage` and `autoStageOnOpen` are deliberately omitted: both
// are open-time hints. Persisting the seed would re-populate the composer with
// a stale message on restore (#7884), and persisting auto-stage would silently
// stage files on every app start.

export function serializeReview(_panel: ReviewPanelData): Partial<PanelSnapshot> {
  return {};
}
