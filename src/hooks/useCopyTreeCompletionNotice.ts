import { useCallback, useEffect, useState } from "react";
import type React from "react";
import {
  registerCopyTreeNoticePresenter,
  type CopyTreeCompletionNotice,
} from "@/lib/copyTreeFeedback";

/**
 * How long a copy-tree completion notice stays pinned to the Copy context
 * button. A display window, not a motion tier: long enough to read "Context
 * copied" plus its one-line summary, short enough that the tooltip never
 * outstays a signal about work that took a second or two.
 */
export const COPY_TREE_NOTICE_DURATION_MS = 2000;

export interface CopyTreeNoticeState {
  /** The completion currently pinned to the anchor, shown as a tooltip. */
  notice: CopyTreeCompletionNotice | null;
  /**
   * Live-region mirror of the notice — tooltips aren't announced by assistive
   * tech the way the toast this replaced was. Identical back-to-back
   * completions toggle a zero-width space so the text change re-announces
   * (same pattern as BrowserToolbar's history announcements).
   */
  announcement: string;
  /** Dismiss early — Escape, dialog transitions, opening the recents panel. */
  clearNotice: () => void;
}

/**
 * The anchor's half of the copy-tree completion contract (the announce half
 * lives in `@/lib/copyTreeFeedback`): registers a presenter that pins each
 * finished clipboard copy to the anchor as a short-lived notice — including
 * MCP and assistant copies the user never clicked for — and declines (falling
 * back to a toast) whenever the notice would go unseen:
 *
 * - the anchor can't carry it — unmounted, or overflow-evicted (`invisible
 *   absolute` under an aria-hidden wrapper, so offsetParent is null);
 * - nobody is looking — the view is background-hidden (MCP dispatches run in
 *   their project's renderer even when another project is on screen) or the
 *   window is blurred. A two-second tooltip in an unwatched window evaporates,
 *   where the fallback toast also leaves a durable inbox row;
 * - the caller suppressed it — e.g. while the recents dropdown is open on the
 *   same anchor, where the two portaled surfaces would stack.
 */
export function useCopyTreeCompletionNotice(
  anchorRef: React.RefObject<HTMLElement | null>,
  options?: { suppress?: boolean }
): CopyTreeNoticeState {
  const suppress = options?.suppress ?? false;
  const [notice, setNotice] = useState<CopyTreeCompletionNotice | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    return registerCopyTreeNoticePresenter((next) => {
      if (suppress) return false;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
      const el = anchorRef.current;
      if (!el || el.offsetParent === null || el.closest('[aria-hidden="true"]') !== null) {
        return false;
      }
      // Spread so back-to-back completions always change identity and re-arm
      // the hide timer below.
      setNotice({ ...next });
      const text = `${next.title}. ${next.message}`;
      setAnnouncement((prev) => (prev === text ? `${text}\u200b` : text));
      return true;
    });
  }, [anchorRef, suppress]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      setNotice(null);
      // Cleared together so a later identical completion re-announces as a
      // plain text change, and stale text isn't left for a screen reader
      // walking the toolbar to stumble over.
      setAnnouncement("");
    }, COPY_TREE_NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const clearNotice = useCallback(() => {
    setNotice(null);
    setAnnouncement("");
  }, []);

  return { notice, announcement, clearNotice };
}
