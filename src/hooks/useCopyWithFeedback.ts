import { useCallback, useEffect, useRef, useState } from "react";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";

export interface UseCopyWithFeedbackOptions {
  /** How long the `copied` flag stays true. Defaults to UI_ACTION_SUCCESS_DWELL_MS. */
  dwellMs?: number;
  /** Polite live-region message announced on success. Defaults to "Copied". */
  announcement?: string;
}

export interface UseCopyWithFeedbackResult {
  copied: boolean;
  /**
   * The text the live `copied` window describes, or null while idle. Callers
   * whose copy target can change under them (a path label that re-roots) gate
   * their feedback on this rather than on `copied`, so the flag and the value
   * it refers to can never be read apart.
   */
  copiedText: string | null;
  copy: (text: string) => Promise<boolean>;
}

/**
 * Standard clipboard-with-feedback gesture: writes text, flips a `copied` flag
 * for the dwell window, and announces once via the polite live region. The
 * announcer is the sole SR signal — callers must keep their visible
 * `aria-label` constant to avoid double-announce.
 */
export function useCopyWithFeedback(
  options: UseCopyWithFeedbackOptions = {}
): UseCopyWithFeedbackResult {
  const { dwellMs = UI_ACTION_SUCCESS_DWELL_MS, announcement = "Copied" } = options;
  // One state, not a flag beside a value: `announce` below can drive a
  // synchronous external-store commit, which would otherwise let a render
  // observe the raised flag while the text still names the previous copy.
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      if (!isMountedRef.current) return true;

      setCopiedText(text);
      useAnnouncerStore.getState().announce(announcement, "polite");

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (!isMountedRef.current) return;
        setCopiedText(null);
        timeoutRef.current = null;
      }, dwellMs);

      return true;
    },
    [announcement, dwellMs]
  );

  return { copied: copiedText !== null, copiedText, copy };
}
