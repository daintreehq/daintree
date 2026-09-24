import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { ArrowRight, Check, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TOUR_CANVAS } from "./mockup/TourMock";
import { AgentsScene } from "./scenes/AgentsScene";
import { AssistantScene } from "./scenes/AssistantScene";
import { ContextScene } from "./scenes/ContextScene";
import { FilesScene } from "./scenes/FilesScene";
import { OutroScene } from "./scenes/OutroScene";
import { PaletteScene } from "./scenes/PaletteScene";
import { FleetScene } from "./scenes/FleetScene";
import { GitHubScene } from "./scenes/GitHubScene";
import { PilotScene } from "./scenes/PilotScene";
import { PreviewScene } from "./scenes/PreviewScene";
import { ReviewScene } from "./scenes/ReviewScene";
import { StateScene } from "./scenes/StateScene";
import { WelcomeScene } from "./scenes/WelcomeScene";
import { WorktreesScene } from "./scenes/WorktreesScene";
import { useTourPlayer, useTourPlayerState, useTourTime } from "./useTourPlayer";

export const TOUR_SCENES: Record<string, ComponentType> = {
  welcome: WelcomeScene,
  worktrees: WorktreesScene,
  agents: AgentsScene,
  state: StateScene,
  fleet: FleetScene,
  files: FilesScene,
  context: ContextScene,
  preview: PreviewScene,
  github: GitHubScene,
  review: ReviewScene,
  pilot: PilotScene,
  assistant: AssistantScene,
  palette: PaletteScene,
  outro: OutroScene,
};

/**
 * The narration line, in a band of its own under the stage rather than over
 * it, so it can never hide the part of the mockup being talked about. The band
 * is always two lines tall: a one-line cue, a two-line cue, and the silence
 * between them all leave everything around it exactly where it was.
 */
export function TourCaption() {
  const player = useTourPlayer();
  const time = useTourTime();
  const caption = player.timing.captions.find((c) => time >= c.start && time < c.end);
  return (
    <div className="flex h-16 items-center justify-center border-t border-border-subtle bg-surface-panel px-8">
      {caption && (
        <p
          key={caption.start}
          className="max-w-[60ch] text-balance text-center text-sm leading-snug text-text-primary motion-safe:animate-in motion-safe:fade-in motion-safe:[--tw-animation-duration:var(--duration-150)]"
        >
          {caption.text}
        </p>
      )}
    </div>
  );
}

/** How long a finished chapter waits before moving on by itself. */
export const TOUR_AUTO_ADVANCE_MS = 3000;

export interface TourEndCard {
  /** Title of the chapter Next leads to; null on the last chapter. */
  nextTitle: string | null;
  /** One-based number of that chapter; null on the last chapter. */
  nextNumber: number | null;
  /** The user asked to stay: no countdown, no auto-advance. */
  held: boolean;
  onHold: () => void;
  onNext: () => void;
  onReplay: () => void;
}

const RING_RADIUS = 34;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
// Declared apart from the JSX so the custom properties ride along with a real
// one; the keyframe drains the dash offset from 0 to the ring's length.
const RING_STYLE = {
  strokeDasharray: RING_LENGTH,
  "--tour-ring-length": RING_LENGTH,
  "--tour-countdown": `${TOUR_AUTO_ADVANCE_MS}ms`,
};

const COUNTDOWN_TICK_MS = 250;

/** Whole seconds left on a running countdown, for the visible readout. */
function useCountdown(running: boolean): number {
  const total = Math.round(TOUR_AUTO_ADVANCE_MS / 1000);
  const [left, setLeft] = useState(total);
  useEffect(() => {
    if (!running) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((performance.now() - started) / 1000);
      setLeft(Math.max(1, total - elapsed));
    }, COUNTDOWN_TICK_MS);
    return () => {
      window.clearInterval(timer);
      setLeft(total);
    };
  }, [running, total]);
  return left;
}

/**
 * What the stage becomes when a chapter has played out: one large, obvious way
 * on, with a ring that drains over three seconds and then moves on by itself —
 * the tour keeps its pace without waiting to be pushed. The last chapter
 * doesn't advance on its own; finishing is the user's call.
 */
function EndCard({
  nextTitle,
  nextNumber,
  held,
  onHold,
  onNext,
  onReplay,
  onUnmountWithFocus,
}: TourEndCard & { onUnmountWithFocus: () => void }) {
  const autoAdvance = nextTitle !== null && !held;
  const secondsLeft = useCountdown(autoAdvance);
  const ref = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const onNextRef = useRef(onNext);
  const handoffRef = useRef(onUnmountWithFocus);
  useEffect(() => {
    onNextRef.current = onNext;
    handoffRef.current = onUnmountWithFocus;
  }, [onNext, onUnmountWithFocus]);

  useEffect(() => {
    if (!autoAdvance) return;
    const timer = window.setTimeout(() => onNextRef.current(), TOUR_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [autoAdvance]);

  // Whatever takes the card away (the countdown, Replay, a click on the track),
  // focus inside it would otherwise fall to <body> and out of the dialog. The
  // stage takes it back once it is out from under the card.
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (node?.contains(document.activeElement)) handoffRef.current();
    };
  }, []);

  return (
    <div
      ref={ref}
      className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-surface-canvas/90 backdrop-blur-md motion-safe:animate-in motion-safe:fade-in motion-safe:[--tw-animation-duration:var(--duration-200)]"
    >
      <span className="text-xs font-medium text-text-secondary">
        {nextTitle ? `Up next · Chapter ${nextNumber}` : "That's the tour"}
      </span>
      <span className="mt-1.5 text-xl font-semibold tracking-tight text-text-primary">
        {nextTitle ?? "Try it for real"}
      </span>
      {nextTitle && (
        <>
          <span aria-hidden="true" className="mt-1 text-xs tabular-nums text-text-secondary">
            {autoAdvance ? `Starts in ${secondsLeft}s` : "Auto-advance paused"}
          </span>
          {/* Announced once per state, never per tick. */}
          <span className="sr-only" role="status">
            {autoAdvance
              ? `Chapter ${nextNumber}, ${nextTitle}, starts in ${TOUR_AUTO_ADVANCE_MS / 1000} seconds. Press K to stay here.`
              : "Auto-advance paused"}
          </span>
        </>
      )}
      {!nextTitle && (
        <span className="mt-1 text-xs text-text-secondary">
          Finish opens the Getting Started checklist to run your first agents
        </span>
      )}
      {nextTitle ? (
        <button
          ref={nextRef}
          type="button"
          data-tour-end-primary=""
          onClick={onNext}
          aria-label={`Next: ${nextTitle}`}
          className="relative mt-5 flex size-[76px] items-center justify-center rounded-full outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-accent-primary"
        >
          {autoAdvance && (
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 76 76" aria-hidden="true">
              <circle
                cx="38"
                cy="38"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="3"
                className="stroke-overlay-strong"
              />
              <circle
                cx="38"
                cy="38"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="3"
                strokeLinecap="round"
                className="tour-countdown-ring stroke-text-primary"
                style={RING_STYLE}
              />
            </svg>
          )}
          <span className="flex size-14 items-center justify-center rounded-full bg-text-primary text-text-inverse shadow-[var(--theme-shadow-ambient)]">
            <ArrowRight className="size-6" aria-hidden="true" />
          </span>
        </button>
      ) : (
        <Button
          ref={nextRef}
          variant="contrast"
          className="mt-5"
          data-tour-end-primary=""
          onClick={onNext}
        >
          <Check aria-hidden="true" />
          Finish tour
        </Button>
      )}
      <div className="mt-4 flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onReplay}>
          <RotateCcw aria-hidden="true" />
          Replay
        </Button>
        {autoAdvance && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // The button goes with the countdown; keep focus on the card.
              nextRef.current?.focus();
              onHold();
            }}
          >
            <Pause className="fill-current" aria-hidden="true" />
            Stay here
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The whole stage is a play/pause surface, like a video. A real button under
 * the scene so it takes focus and keyboard activation; the end card sits above
 * it with its own controls. Paused, the scene dims a step and a large play
 * mark sits over it, so a stopped tour never reads as a frozen one.
 */
function PlaySurface({
  buttonRef,
  covered,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  /** The end card is over the stage: it owns the stage's controls until it goes. */
  covered: boolean;
}) {
  const player = useTourPlayer();
  const state = useTourPlayerState(player);
  const paused = state.status === "paused" || state.status === "idle";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Play"
        aria-pressed={state.status === "playing"}
        data-testid="tour-stage-toggle"
        inert={covered}
        onClick={() => player.toggle()}
        className="group/stage absolute inset-0 z-10 cursor-pointer outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-accent-primary"
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-surface-canvas/40 transition-opacity duration-150 ease-out",
          paused ? "opacity-100" : "opacity-0"
        )}
      >
        <span className="flex size-16 items-center justify-center rounded-full border border-border-default bg-surface-panel-elevated text-text-primary shadow-[var(--theme-shadow-ambient)]">
          <Play className="ml-1 size-7 fill-current" />
        </span>
      </span>
    </>
  );
}

/**
 * The scene viewport. Scenes are authored on a fixed canvas and scaled to the
 * stage's width, so every mockup keeps its proportions at any dialog size.
 * The scene inherits the live theme — it is built from the same tokens as the
 * real UI, not a picture of it. A new chapter fades up from the canvas rather
 * than cutting, so the change of scene reads as a change of chapter.
 */
export function TourStage({
  chapterId,
  endCard,
}: {
  chapterId: string;
  /** Present once the chapter has finished playing. */
  endCard: TourEndCard | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const restoreToStageRef = useRef(false);
  const [scale, setScale] = useState(1);
  const covered = endCard !== null;

  // Focus follows the stage's controls as the end card comes and goes. Both
  // moves run here, after the commit, so the destination is mounted and no
  // longer inert when it is focused.
  useLayoutEffect(() => {
    if (covered) {
      if (document.activeElement === playRef.current) {
        ref.current?.querySelector<HTMLElement>("[data-tour-end-primary]")?.focus();
      }
    } else if (restoreToStageRef.current) {
      restoreToStageRef.current = false;
      playRef.current?.focus();
    }
  }, [covered]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / TOUR_CANVAS.width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const Scene = TOUR_SCENES[chapterId];

  return (
    <div
      ref={ref}
      className="relative aspect-video w-full select-none overflow-hidden bg-surface-canvas"
    >
      {/* The mockup is illustration; the chapter title and captions carry the content. */}
      <div
        key={chapterId}
        aria-hidden="true"
        data-tour-canvas=""
        className="absolute left-0 top-0 origin-top-left motion-safe:animate-in motion-safe:fade-in motion-safe:[--tw-animation-duration:var(--duration-200)]"
        style={{ width: TOUR_CANVAS.width, height: TOUR_CANVAS.height, scale: String(scale) }}
      >
        {Scene && <Scene />}
      </div>
      <PlaySurface buttonRef={playRef} covered={endCard !== null} />
      {endCard && (
        <EndCard
          {...endCard}
          onUnmountWithFocus={() => {
            restoreToStageRef.current = true;
          }}
        />
      )}
    </div>
  );
}
