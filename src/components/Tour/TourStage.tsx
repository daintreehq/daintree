import { useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { cn } from "@/lib/utils";
import { TOUR_CANVAS } from "./mockup/TourMock";
import { AgentsScene } from "./scenes/AgentsScene";
import { FleetScene } from "./scenes/FleetScene";
import { ReviewScene } from "./scenes/ReviewScene";
import { StateScene } from "./scenes/StateScene";
import { WelcomeScene } from "./scenes/WelcomeScene";
import { WorktreesScene } from "./scenes/WorktreesScene";
import { useTourPlayer, useTourTime } from "./useTourPlayer";

export const TOUR_SCENES: Record<string, ComponentType> = {
  welcome: WelcomeScene,
  worktrees: WorktreesScene,
  agents: AgentsScene,
  state: StateScene,
  fleet: FleetScene,
  review: ReviewScene,
};

function Caption() {
  const player = useTourPlayer();
  const time = useTourTime();
  const caption = player.timing.captions.find((c) => time >= c.start && time < c.end);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-6">
      {caption && (
        <span className="max-w-[80%] rounded-md bg-surface-panel-elevated px-2.5 py-1 text-center text-xs text-text-primary shadow-[var(--theme-shadow-ambient)]">
          {caption.text}
        </span>
      )}
    </div>
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
  showCaptions,
}: {
  chapterId: string;
  showCaptions: boolean;
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
    <div
      ref={ref}
      className={cn(
        "relative aspect-video w-full select-none overflow-hidden rounded-lg border border-border-subtle bg-surface-canvas"
      )}
    >
      {/* The mockup is illustration; the chapter text and captions carry the content. */}
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: TOUR_CANVAS.width, height: TOUR_CANVAS.height, scale: String(scale) }}
      >
        {Scene && <Scene key={chapterId} />}
      </div>
      {showCaptions && <Caption />}
    </div>
  );
}
