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
 * The narration line, always shown, under the stage rather than over it so it
 * can never hide the part of the mockup being talked about.
 */
export function TourCaption() {
  const player = useTourPlayer();
  const time = useTourTime();
  const caption = player.timing.captions.find((c) => time >= c.start && time < c.end);
  return (
    <p className="min-h-[2.5rem] text-center text-sm text-text-primary">{caption?.text ?? ""}</p>
  );
}

/** How long a finished chapter waits before moving on by itself. */
export const TOUR_AUTO_ADVANCE_MS = 5000;

export interface TourEndCard {
  /** Title of the chapter Next leads to; null on the last chapter. */
  nextTitle: string | null;
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

/**
 * What the stage becomes when a chapter has played out: one large, obvious way
 * on, with a ring that drains over five seconds and then moves on by itself —
 * the tour keeps its pace without waiting to be pushed. The last chapter
 * doesn't advance on its own; finishing is the user's call.
 */
function EndCard({ nextTitle, held, onHold, onNext, onReplay }: TourEndCard) {
  const autoAdvance = nextTitle !== null && !held;
  const onNextRef = useRef(onNext);
  useEffect(() => {
    onNextRef.current = onNext;
  }, [onNext]);

  useEffect(() => {
    if (!autoAdvance) return;
    const timer = window.setTimeout(() => onNextRef.current(), TOUR_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [autoAdvance]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-surface-canvas/85 backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in motion-safe:[--tw-animation-duration:var(--duration-200)]">
      <span className="text-xs font-medium text-text-secondary">
        {nextTitle ? "Up next" : "That's the tour"}
      </span>
      <span className="text-xl font-semibold tracking-tight text-text-primary">
        {nextTitle ?? "Try it for real"}
      </span>
      {!nextTitle && (
        <span className="-mt-1.5 text-xs text-text-secondary">
          Finish opens the Getting Started checklist for your first task
        </span>
      )}
      <button
        type="button"
        onClick={onNext}
        aria-label={nextTitle ? `Next: ${nextTitle}` : "Finish tour and open Getting Started"}
        className="relative mt-1 flex size-[76px] items-center justify-center rounded-full outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-border-interactive"
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
        <span className="flex size-14 items-center justify-center rounded-full bg-text-primary text-text-inverse shadow-[var(--theme-shadow-ambient)] transition-[background-color] duration-150 ease-out">
          {nextTitle ? (
            <ArrowRight className="size-6" aria-hidden="true" />
          ) : (
            <Check className="size-6" aria-hidden="true" />
          )}
        </span>
      </button>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onReplay}>
          <RotateCcw aria-hidden="true" />
          Replay
        </Button>
        {autoAdvance && (
          <Button variant="ghost" size="sm" onClick={onHold}>
            <Pause aria-hidden="true" />
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
 * it with its own controls.
 */
function PlaySurface() {
  const player = useTourPlayer();
  const state = useTourPlayerState(player);
  const paused = state.status === "paused" || state.status === "idle";
  return (
    <>
      <button
        type="button"
        aria-label="Play or pause the tour"
        onClick={() => player.toggle()}
        className="absolute inset-0 z-10 cursor-pointer outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-border-interactive"
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 z-10 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-surface-panel-elevated text-text-primary shadow-[var(--theme-shadow-ambient)] transition-opacity duration-150 ease-out",
          paused ? "opacity-100" : "opacity-0"
        )}
      >
        <Play className="ml-0.5 size-6" />
      </span>
    </>
  );
}

/**
 * The scene viewport. Scenes are authored on a fixed canvas and scaled to the
 * stage's width, so every mockup keeps its proportions at any dialog size.
 * The scene inherits the live theme — it is built from the same tokens as the
 * real UI, not a picture of it.
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
  const [scale, setScale] = useState(1);

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
    // The stage is the only part of the dialog that can give up space, so on a
    // short window its width follows the height left after the dialog's chrome
    // (header, controls, chapter text, footer — about 20rem).
    <div
      ref={ref}
      className={cn(
        "relative mx-auto aspect-video w-full max-w-[calc((92vh-20rem)*16/9)] select-none overflow-hidden rounded-lg border border-border-subtle bg-surface-canvas"
      )}
    >
      {/* The mockup is illustration; the chapter text and captions carry the content. */}
      <div
        aria-hidden="true"
        data-tour-canvas=""
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: TOUR_CANVAS.width, height: TOUR_CANVAS.height, scale: String(scale) }}
      >
        {Scene && <Scene key={chapterId} />}
      </div>
      <PlaySurface />
      {endCard && <EndCard {...endCard} />}
    </div>
  );
}
