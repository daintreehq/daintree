import { useLayoutEffect, useRef, useState } from "react";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import {
  UI_ANIMATION_DURATION,
  UI_EXIT_DURATION,
  UI_INLINE_LOADING_GATE_MS,
} from "@/lib/animationUtils";
import type { VoiceSubmitOutcome, VoiceSubmitWait } from "./hooks/useVoiceWaitSubmit";

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
const WASH_FEATHER_PX = 32;
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

function waitCaption(wait: VoiceSubmitWait): string {
  return `${wait.phase === "polishing" ? "Polishing…" : "Finishing…"} · Esc to cancel`;
}

interface VoiceSubmitProgressProps {
  wait: VoiceSubmitWait | null;
  outcome: VoiceSubmitOutcome | null;
  /**
   * Whether anything is on screen, exit included: the shell holds back its
   * focus ring meanwhile, which would otherwise strike through the caption.
   */
  onPresentChange: (presenting: boolean) => void;
}

/**
 * The composer shell as the voice send's progress bar: a wash behind the
 * draft and a trace along its foot, the trace carrying the contrast, with a
 * caption on the top border. All of it paints from the shell's `--ib-wait-*`
 * colours.
 *
 * The fill never moves back; each phase picks up where the last left it. The
 * drain has no end anyone knows, so it creeps toward a ceiling. The
 * correction's wait lasts as long as its request does (#14780), so the fill
 * paces to when past corrections say it lands, most of the way there by then,
 * and creeps on toward a ceiling of its own past that. Only a send the
 * composer took brings it to full, the caption turning to a receipt as it
 * fades; one still being handed over holds where it stands, saying so. Escape,
 * or a send held back, lets it fade where it stands, caption and all. A wait
 * that ends inside the gate leaves nothing to take down; a handover that
 * outlasts it still shows. Mount one per attempt (keyed), so each attempt
 * gets its own gate and no fill carries over from the last.
 */
export function VoiceSubmitProgress({ wait, outcome, onPresentChange }: VoiceSubmitProgressProps) {
  const fillRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);
  const [wasShown, setWasShown] = useState(false);
  const [lastWaitCaption, setLastWaitCaption] = useState("");
  const reduced = prefersReducedMotion();
  const handingOver = outcome?.kind === "sending";
  const active = wait !== null || handingOver;
  // Until the gate opens the shell alone says Enter landed.
  const shown = useDeferredLoading(active, UI_INLINE_LOADING_GATE_MS);

  if (wait && waitCaption(wait) !== lastWaitCaption) setLastWaitCaption(waitCaption(wait));
  const caption = wait
    ? waitCaption(wait)
    : outcome?.kind === "sent"
      ? "Sent"
      : outcome?.kind === "sending"
        ? "Sending…"
        : lastWaitCaption;

  const visible = active && shown;
  if (visible !== wasShown) {
    setWasShown(visible);
    setExiting(!visible && !active);
  }

  useLayoutEffect(() => {
    const el = fillRef.current;
    if (!el || !wait || !shown) return;
    if (wait.phase === "finishing") {
      restart(el, [at(progressOf(el)), at(FINISHING_CEILING)], {
        duration: FINISHING_CREEP_MS,
        easing: CREEP_EASING,
      });
      return;
    }
    const from = progressOf(el);
    if (from >= EXPECTED_SHARE) {
      restart(el, [at(from), at(Math.max(from, OVERRUN_CEILING))], {
        duration: OVERRUN_CREEP_MS,
        easing: CREEP_EASING,
      });
      return;
    }
    const expectedAt = wait.expectedAt ?? wait.startedAt + UNESTIMATED_MS;
    const first = Math.max(expectedAt - performance.now(), MIN_SEGMENT_MS);
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
  }, [wait, shown]);

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
      {/* Reduced motion keeps the caption and the shell's quiet outline, and no sweep. */}
      {!reduced && (
        <div
          aria-hidden="true"
          data-voice-submit-track=""
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-md"
        >
          <div
            ref={fillRef}
            data-voice-submit-progress=""
            className="absolute inset-0 border-b-2 border-[var(--ib-wait-edge)]"
            style={{
              // The wash feathers out ahead of the trace, so its edge never cuts
              // a glyph in two; the trace keeps the exact extent.
              background: `linear-gradient(to right, var(--ib-wait-fill) calc(100% - ${WASH_FEATHER_PX}px), transparent)`,
              transform: "translateX(-100%)",
            }}
          />
        </div>
      )}
      {/* On the top border like a legend: it adds no row and covers none of
          the draft. Centred on the border, it masks only the border's own
          row, so the progress beneath shows through its lower half. */}
      <div
        ref={captionRef}
        aria-hidden="true"
        data-voice-submit-caption=""
        className="pointer-events-none absolute -top-2 right-2.5 bg-[linear-gradient(transparent_6px,var(--ib-pane)_6px,var(--ib-pane)_8px,transparent_8px)] px-1.5 text-xs leading-4 whitespace-nowrap text-[var(--ib-wait-caption)]"
      >
        {caption}
      </div>
    </>
  );
}
