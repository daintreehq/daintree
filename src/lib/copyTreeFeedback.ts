import { notify } from "@/lib/notify";

/**
 * Completion feedback for clipboard-bound copy-tree runs (the full toast felt
 * heavy for a one-second copy). The toolbar's Copy context button registers a
 * presenter that shows the notice as a transient tooltip on the button itself;
 * `announceCopyTreeCopy` hands each completion to that presenter first and only
 * falls back to the old toast when no visible button can carry it — the button
 * unpinned from the toolbar, evicted into the overflow menu, or not mounted at
 * all. Feedback about a silent clipboard overwrite must never just vanish.
 */
export interface CopyTreeCompletionNotice {
  /** Short outcome line, e.g. "Context copied". */
  title: string;
  /** The one-line summary from `formatCopyResultMessage`. */
  message: string;
}

type CopyTreeNoticePresenter = (notice: CopyTreeCompletionNotice) => boolean;

let presenter: CopyTreeNoticePresenter | null = null;

/**
 * One presenter at a time — each project view runs its own V8 context with its
 * own toolbar, so "the" button is unambiguous here. The presenter returns false
 * to decline (its anchor is currently hidden), which sends the notice down the
 * toast fallback instead.
 */
export function registerCopyTreeNoticePresenter(next: CopyTreeNoticePresenter): () => void {
  presenter = next;
  return () => {
    if (presenter === next) presenter = null;
  };
}

export function announceCopyTreeCopy(notice: CopyTreeCompletionNotice, rateLimitKey: string): void {
  if (presenter?.(notice)) return;

  // The pre-tooltip toast, verbatim. No `context.worktreeId`, deliberately:
  // notify() diverts a high-priority toast to the inbox when context names the
  // worktree already on screen — the common case here — which would silence
  // exactly this signal. A clipboard overwrite is invisible whichever worktree
  // is displayed. "agent", not "completed": both route active → high, but
  // "completed" owns the `completedEnabled` setting, which gates only
  // main-process completion watches and never a renderer notify(). The
  // rateLimitKey keeps each caller in its own bucket so an unrelated success
  // burst can't swallow the one message saying what is now on the clipboard
  // (#11735).
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "success",
    title: notice.title,
    message: notice.message,
    rateLimitKey,
    context: { eventKind: "agent" },
  });
}

/** Test-only: drop whatever presenter a case left behind. */
export function _resetCopyTreeNoticePresenterForTest(): void {
  presenter = null;
}
