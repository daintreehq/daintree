import type {
  CIStatus,
  CIStatusState,
  NormalizedPRState,
  PRMergeIntent,
} from "../../shared/types/forge.js";

// A worktree's detected PR, shared by PullRequestService and its CI tracker.
export interface InternalLinkedPR {
  number: number;
  title: string;
  url: string;
  state: NormalizedPRState;
  isDraft?: boolean;
  // Carried so every emit for this PR — not just the detection one — rebuilds
  // `linked.pr` with it. The host full-replaces `linked.pr` per event, so an
  // emit without it dropped the base-branch divergence target back to main.
  baseRef?: string;
  ciStatus?: CIStatusState;
  _ciStatus?: CIStatus;
  providerId: string;
  stagnantPollCount: number;
  // REST change-detection markers for the open-PR-list revalidation probe.
  // Only the REST probe populates these (the GraphQL PR shape carries neither
  // head.sha nor a raw ISO updated_at), so they stay undefined until the first
  // probe-driven revalidation cycle seeds them.
  headSha?: string;
  updatedAt?: string;
  // Wall-clock stamp of the last getCIStatuses attempt, taken at enqueue rather
  // than on resolve so a rejected or slow batch still counts against the
  // terminal re-check interval — otherwise a failing provider would re-fire the
  // same PR on every revalidation tick. Undefined until the first attempt,
  // which reads as "due" so entries detected before this field existed (or
  // seeded by a re-detection) self-heal on the next tick.
  lastCiCheckAt?: number;
  // Set by sweepStaleCiStatus when a pending badge is cleared to `undefined` on
  // blur. That state is invisible to every other trigger — it isn't `pending`,
  // isn't terminal, and a CI re-run doesn't bump updated_at for the probe — so
  // without an explicit marker the badge stays blank until the next push. The
  // focus catch-up normally backfills it, but that's a single edge-triggered
  // event: throttled, rate-limited, or rejected, it's gone. This flag keeps the
  // entry eligible on the periodic tick until an authoritative result lands.
  needsCiBackfill?: boolean;
  // Some head of this PR has reported checks, so a rollup-less read after a
  // push means "not registered yet" rather than "this repo has no CI".
  ciSeen?: boolean;
  // Deadline of the post-push wait for the new head's checks; see
  // CI_HEAD_MOVE_GRACE_MS. While set, a read that reports no checks or
  // describes another commit is held back instead of shown.
  ciGraceUntil?: number;
  // The head this PR moved off most recently. GitHub's PR head trails a push
  // by seconds, so a read can still answer for it after the probe saw the new
  // one; that answer is never shown.
  displacedHeadSha?: string;
  // The PR's head branch name on the forge — what a worktree's upstream ref
  // must name before its movement is read as this PR's head moving.
  headRef?: string;
  // A head this PR moved to by a push seen on the local upstream ref, before
  // the forge's probe has caught up (#13400). Kept apart from `headSha`, the
  // probe's change marker: the probe keeps diffing against the head GitHub last
  // reported, so its catch-up still reads as a change, and a probe that still
  // reports the old head reads as unchanged rather than as a move back.
  localHeadSha?: string;
  // When the first local move of the current run was seen, and the head the
  // probe knew then. A push the probe never confirms within the post-push wait
  // wasn't to this PR's head after all (a fork's same-named branch on the same
  // commit), so the move is undone rather than left hiding a real result.
  localHeadAt?: number;
  localMoveBaseSha?: string;
  // `displacedHeadSha` was last set by a local move, so undoing the move must
  // drop it too — a head only a local sighting displaced may be the real one.
  displacedByLocalMove?: boolean;
  // The pending forge-side merge GitHub last reported (auto-merge or queue).
  mergeIntent?: PRMergeIntent | null;
  // The forge's head when this host first saw the current arming episode, and
  // whether a later read found another one. A push by anyone with write access
  // leaves auto-merge armed, so a moved head is a commit that may land unseen.
  armedHeadSha?: string;
  headMovedWhileArmed?: boolean;
}
