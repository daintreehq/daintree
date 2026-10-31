import { useLayoutEffect, useRef, useState } from "react";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import {
  UI_ANIMATION_DURATION,
  UI_EXIT_DURATION,
  UI_INLINE_LOADING_GATE_MS,
} from "@/lib/animationUtils";
import type { VoiceCorrectionRange } from "@/store/voiceRecordingStore";
import type {
  VoiceSendCleanup,
  VoiceSubmitOutcome,
  VoiceSubmitWait,
} from "./hooks/useVoiceWaitSubmit";

/** How far the drain's creep reaches: the correction after it owns the rest of the bar. */
const FINISHING_CEILING = 0.3;
const FINISHING_CREEP_MS = 3_000;
/** Where the fill stands at the expected landing. */
const EXPECTED_SHARE = 0.9;
/**
 * A correction that outlasts its estimate has no end anyone knows either: the
 * fill creeps on toward this, and full is kept for a send that went.
 */
const OVERRUN_CEILING = 0.98;
const OVERRUN_CREEP_MS = 6_000;
/** With no estimate, the landing is taken to be this long into the wait. */
const UNESTIMATED_MS = 1_200;
const CREEP_EASING = "cubic-bezier(0.25, 0.6, 0.4, 1)";
const MIN_SEGMENT_MS = UI_ANIMATION_DURATION;
const SENT_EXIT_MS = UI_ANIMATION_DURATION + UI_EXIT_DURATION;

const at = (p: number): Keyframe => ({ transform: `translateX(${(p - 1) * 100}%)` });

/** How much of the shell the fill covers right now, mid-animation included. */
function progressOf(el: HTMLElement): number {
  const width = el.offsetWidth;
  if (width === 0) return 0;
  const tx = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
  return Math.min(1, Math.max(0, 1 + tx / width));
}

function restart(el: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  const animation = el.animate(keyframes, { fill: "forwards", ...options });
  for (const old of el.getAnimations()) if (old !== animation) old.cancel();
  return animation;
}

/**
 * A caption on the shell's top border, like a legend: it adds no row and
 * covers none of the draft. Centred on the border, it masks only the border's
 * own row, so whatever the shell paints beneath shows through its lower half.
 */
export const COMPOSER_BORDER_CAPTION_CLASS =
  "pointer-events-none absolute -top-2 right-2.5 bg-[linear-gradient(transparent_6px,var(--ib-pane)_6px,var(--ib-pane)_8px,transparent_8px)] px-1.5 text-xs leading-4 whitespace-nowrap text-[var(--ib-wait-caption)]";

/**
 * How much of the passages being cleaned the cleanup has written so far, by
 * dictated length, or null before any of it has streamed back. With
 * `sessions`, only those sessions' passages count: a dictation started while
 * a send waits is the next prompt's.
 */
export function correctionStreamShare(
  ranges: readonly VoiceCorrectionRange[],
  sessions?: ReadonlySet<string>
): number | null {
  let total = 0;
  let written = 0;
  let streaming = false;
  for (const range of ranges) {
    if (range.to <= range.from) continue;
    if (sessions && range.session && !sessions.has(range.session)) continue;
    total += range.to - range.from;
    if (!range.rewrite) continue;
    streaming = true;
    written += Math.min(range.rewrite.to, range.to) - range.from;
  }
  return streaming && total > 0 ? Math.max(0, written / total) : null;
}

/**
 * Where the fill stands at `now` on the cleanup's own timeline, from its
 * request going out to its expected landing: a send whose Enter came partway
 * through opens at the share already gone. Zero with no estimate.
 */
export function polishingShareAt(wait: VoiceSubmitWait, now: number): number {
  if (wait.phase !== "polishing" || wait.expectedAt === null || wait.beganAt === null) return 0;
  const span = wait.expectedAt - wait.beganAt;
  if (span <= 0) return EXPECTED_SHARE;
  return EXPECTED_SHARE * Math.min(1, Math.max(0, (now - wait.beganAt) / span));
}

/**
 * The wait's caption: what it waits on, and the ways out. Only the cleanup's
 * wait is one Enter cuts short; the transcript still finishes first.
 */
export function voiceSubmitWaitCaption(wait: VoiceSubmitWait): string {
  return wait.phase === "polishing"
    ? "Polishing… · Enter to send as dictated · Esc to cancel"
    : "Finishing… · Esc to cancel";
}

/** A send a dictation in its draft reopened: its words wait for the next send (#15703). */
export const VOICE_SEND_REOPENED_CAPTION = "Send reopened · Enter sends it all";

const UNCLEANED_RECEIPT: Record<VoiceSendCleanup, string> = {
  skipped: "Sent · cleanup skipped",
  failed: "Sent · cleanup failed",
};

interface VoiceSubmitProgressProps {
  wait: VoiceSubmitWait | null;
  outcome: VoiceSubmitOutcome | null;
  /** The cleanup's own progress once it streams (`correctionStreamShare`). */
  streamed?: number | null;
  /**
   * Whether anything is on screen, exit included: the shell holds back its
   * focus ring meanwhile, which would otherwise strike through the caption.
   */
  onPresentChange: (presenting: boolean) => void;
}

/**
 * The voice send's progress: a thin bar along the shell's foot, with a
 * caption on the top border. The draft above it is left alone, still and
 * readable, while the cleanup writes over it. All of it paints from the
 * shell's `--ib-wait-*` colours.
 *
 * The bar never moves back; each phase picks up where the last left it. The
 * drain has no end anyone knows, so it creeps toward a ceiling. The
 * correction's wait lasts as long as its request does (#14780), so the bar
 * paces to when past corrections say it lands, and once the cleanup writes,
 * follows it. Only a send the composer took brings it to full, the caption
 * turning to a receipt as it fades; one still being handed over holds where it
 * stands, saying so. Escape, or a send held back, lets it fade where it
 * stands, caption and all; a send a new dictation reopened fades saying so.
 * A wait that ends inside the gate leaves nothing to
 * take down, unless its send went without the cleanup; a handover that
 * outlasts it still shows. Mount one per attempt
 * (keyed), so each attempt gets its own gate and no bar carries over from the
 * last.
 */
export function VoiceSubmitProgress({
  wait,
  outcome,
  streamed = null,
  onPresentChange,
}: VoiceSubmitProgressProps) {
  const fillRef = useRef<HTMLDivElement>(null);
  // Where the fill stood when the cleanup began writing.
  const streamStartRef = useRef<number | null>(null);
  // Whether this attempt's bar has been drawn yet.
  const drawnRef = useRef(false);
  const captionRef = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);
  const [wasShown, setWasShown] = useState(false);
  const [lastWaitCaption, setLastWaitCaption] = useState("");
  // A send that went without its cleanup is told once, shown wait or not.
  const [uncleanedDue, setUncleanedDue] = useState(true);
  const reduced = prefersReducedMotion();
  const handingOver = outcome?.kind === "sending";
  const active = wait !== null || handingOver;
  // Until the gate opens the shell alone says Enter landed.
  const shown = useDeferredLoading(active, UI_INLINE_LOADING_GATE_MS);

  if (wait && voiceSubmitWaitCaption(wait) !== lastWaitCaption)
    setLastWaitCaption(voiceSubmitWaitCaption(wait));
  const caption = wait
    ? voiceSubmitWaitCaption(wait)
    : outcome?.kind === "sent"
      ? outcome.cleanup
        ? UNCLEANED_RECEIPT[outcome.cleanup]
        : "Sent"
      : outcome?.kind === "sending"
        ? "Sending…"
        : outcome?.kind === "reopened"
          ? VOICE_SEND_REOPENED_CAPTION
          : lastWaitCaption;

  const visible = active && shown;
  if (visible !== wasShown) {
    setWasShown(visible);
    setExiting(!visible && !active);
  }
  // One whose wait ended inside the gate still gets its receipt: nothing else
  // says the prompt went out as dictated.
  if (uncleanedDue && outcome?.kind === "sent" && outcome.cleanup && !active) {
    setUncleanedDue(false);
    if (!wasShown && !exiting) setExiting(true);
  }

  useLayoutEffect(() => {
    const el = fillRef.current;
    if (!el || !wait || !shown) return;
    const opening = !drawnRef.current;
    drawnRef.current = true;
    const drawn = progressOf(el);
    if (wait.phase === "finishing") {
      restart(el, [at(drawn), at(FINISHING_CEILING)], {
        duration: FINISHING_CREEP_MS,
        easing: CREEP_EASING,
      });
      return;
    }
    // Once the cleanup writes over the draft, the words are the progress: the
    // rest of the fill follows them, so the bar and the text finish together.
    // A bar that opens on a cleanup already writing opens where the words are.
    if (streamed !== null) {
      streamStartRef.current ??= opening ? 0 : drawn;
      const start = streamStartRef.current;
      const target = Math.max(drawn, start + (OVERRUN_CEILING - start) * Math.min(1, streamed));
      restart(el, [at(opening ? target : drawn), at(target)], {
        duration: MIN_SEGMENT_MS,
        easing: "ease-out",
      });
      return;
    }
    const now = performance.now();
    const from = Math.max(drawn, polishingShareAt(wait, now));
    if (from >= EXPECTED_SHARE) {
      restart(el, [at(from), at(Math.max(from, OVERRUN_CEILING))], {
        duration: OVERRUN_CREEP_MS,
        easing: CREEP_EASING,
      });
      return;
    }
    // An estimate lands the fill at its share on time; the floor is for a
    // guessed landing, which owes nobody punctuality.
    const first =
      wait.expectedAt !== null
        ? Math.max(wait.expectedAt - now, 1)
        : Math.max(wait.startedAt + UNESTIMATED_MS - now, MIN_SEGMENT_MS);
    const total = first + OVERRUN_CREEP_MS;
    restart(
      el,
      [
        { ...at(from), easing: "linear" },
        { ...at(EXPECTED_SHARE), offset: first / total, easing: CREEP_EASING },
        at(OVERRUN_CEILING),
      ],
      { duration: total }
    );
  }, [wait, shown, streamed]);

  // A send still being handed over keeps the fill where it is until the
  // composer says whether it went.
  const holding = handingOver && visible;
  useLayoutEffect(() => {
    if (!holding) return;
    for (const animation of fillRef.current?.getAnimations() ?? []) animation.pause();
  }, [holding]);
  const settledOutcome = outcome !== null && outcome.kind !== "sending" ? outcome : null;
  useLayoutEffect(() => {
    const caption = captionRef.current;
    if (!caption || !exiting || !settledOutcome) return;
    const sent = settledOutcome.kind === "sent";
    const duration = sent ? SENT_EXIT_MS : UI_EXIT_DURATION;
    const fill = fillRef.current;
    if (fill) {
      const from = progressOf(fill);
      restart(
        fill,
        sent
          ? [
              { ...at(from), opacity: 1 },
              { ...at(1), opacity: 1, offset: 0.55 },
              { ...at(1), opacity: 0 },
            ]
          : [
              { ...at(from), opacity: 1 },
              { ...at(from), opacity: 0 },
            ],
        { duration, easing: "ease-out" }
      );
    }
    const fade = restart(
      caption,
      sent
        ? [{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }]
        : [{ opacity: 1 }, { opacity: 0 }],
      { duration, easing: "ease-out" }
    );
    fade.onfinish = () => setExiting(false);
    return () => {
      fade.onfinish = null;
    };
  }, [exiting, settledOutcome]);

  const presenting = visible || exiting;
  useLayoutEffect(() => {
    onPresentChange(presenting);
  }, [presenting, onPresentChange]);
  useLayoutEffect(() => () => onPresentChange(false), [onPresentChange]);

  if (!presenting) return null;

  return (
    <>
      {/* Reduced motion keeps the caption and the shell's quiet outline, and no bar. */}
      {!reduced && (
        <div
          aria-hidden="true"
          data-voice-submit-track=""
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-md"
        >
          {/* A border, not a fill: forced colours keep a border's ink. */}
          <div
            ref={fillRef}
            data-voice-submit-progress=""
            className="absolute inset-x-0 bottom-0 border-b-2 border-[var(--ib-wait-edge)]"
            style={{ transform: "translateX(-100%)" }}
          />
        </div>
      )}
      <div
        ref={captionRef}
        aria-hidden="true"
        data-voice-submit-caption=""
        className={COMPOSER_BORDER_CAPTION_CLASS}
      >
        {caption}
      </div>
    </>
  );
}
