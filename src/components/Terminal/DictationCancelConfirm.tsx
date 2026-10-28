import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import { PRESS_AGAIN_CONFIRM_MS } from "@/lib/pressAgain";
import { useVoiceRecordingStore } from "@/store";
import type { DictationCancelConfirm } from "@/store/voiceRecordingStore";

export const DICTATION_CANCEL_CONFIRM_PROMPT = "Press Escape again to cancel dictation";

/** The first Escape waiting on a second for the dictation into `voiceId`, if any. */
export function useDictationCancelConfirm(voiceId: string): DictationCancelConfirm | null {
  return useVoiceRecordingStore((state) =>
    state.dictationCancelConfirm?.panelId === voiceId ? state.dictationCancelConfirm : null
  );
}

const secondsLeft = (expiresAt: number) =>
  Math.max(1, Math.ceil((expiresAt - performance.now()) / 1000));

/**
 * Covers the whole composer while a first Escape waits for the second
 * (#14927), the draft greyed beneath it. It only paints: the mic stays live,
 * words keep landing underneath, and pointer and keys pass through to the
 * composer. The countdown is the seconds left and a bar along the foot that
 * runs out with them; reduced motion keeps the seconds.
 */
export function DictationCancelConfirmOverlay({ confirm }: { confirm: DictationCancelConfirm }) {
  const barRef = useRef<HTMLDivElement>(null);
  const [seconds, setSeconds] = useState(() => secondsLeft(confirm.expiresAt));
  const reduced = prefersReducedMotion();

  useEffect(() => {
    setSeconds(secondsLeft(confirm.expiresAt));
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const left = confirm.expiresAt - performance.now();
      setSeconds(secondsLeft(confirm.expiresAt));
      if (left <= 0) return;
      // Wake at the next whole second, so the figure turns when it should.
      timer = setTimeout(tick, (left % 1000) + 1);
    };
    timer = setTimeout(tick, ((confirm.expiresAt - performance.now()) % 1000) + 1);
    return () => clearTimeout(timer);
  }, [confirm.expiresAt]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const left = Math.max(0, confirm.expiresAt - performance.now());
    const animation = bar.animate(
      [{ transform: `scaleX(${left / PRESS_AGAIN_CONFIRM_MS})` }, { transform: "scaleX(0)" }],
      { duration: left, easing: "linear", fill: "forwards" }
    );
    return () => animation.cancel();
  }, [confirm.expiresAt]);

  return (
    <div
      aria-hidden="true"
      data-dictation-cancel-confirm=""
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 overflow-hidden rounded-md bg-[color-mix(in_oklab,var(--ib-bg)_82%,transparent)] px-3 text-xs text-[var(--ib-fg)]"
    >
      <span className="truncate">{DICTATION_CANCEL_CONFIRM_PROMPT}</span>
      <span
        data-dictation-cancel-countdown=""
        className="shrink-0 tabular-nums text-[var(--ib-wait-caption)]"
      >
        {seconds}s
      </span>
      {!reduced && (
        <div
          ref={barRef}
          data-dictation-cancel-progress=""
          className="absolute inset-x-0 bottom-0 origin-left border-b-2 border-[var(--ib-wait-edge)]"
        />
      )}
    </div>
  );
}
