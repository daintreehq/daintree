import { Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TOUR_CHAPTERS } from "./tourChapters";
import type { TourPlayer } from "./TourPlayer";
import { useTourPlayerState, useTourTime } from "./useTourPlayer";

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function CurrentFill({ player }: { player: TourPlayer }) {
  const time = useTourTime();
  const progress = Math.min(1, time / player.timing.duration);
  return (
    <span
      className="absolute inset-y-0 left-0 rounded-full bg-text-primary"
      style={{ width: `${progress * 100}%` }}
    />
  );
}

function TimeReadout({ player }: { player: TourPlayer }) {
  const time = useTourTime();
  return (
    <span className="w-[4.5rem] shrink-0 text-right text-xs tabular-nums text-text-secondary">
      {formatTime(time)} / {formatTime(player.timing.duration)}
    </span>
  );
}

function IconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Play, a per-chapter progress track, and mute. The track is segmented so the
 * whole tour's length is visible at a glance; a click on the current segment
 * seeks, a click on another jumps to that chapter.
 */
export function TourControls({
  player,
  onMutedChange,
}: {
  player: TourPlayer;
  onMutedChange: (muted: boolean) => void;
}) {
  const state = useTourPlayerState(player);
  const playing = state.status === "playing";
  const ended = state.status === "ended";

  return (
    <div className="flex items-center gap-2">
      <IconButton
        label={ended ? "Replay" : "Play"}
        pressed={ended ? undefined : playing}
        onClick={() => player.toggle()}
      >
        {ended ? <RotateCcw /> : playing ? <Pause /> : <Play />}
      </IconButton>

      <div className="flex min-w-0 flex-1 items-center gap-1" role="group" aria-label="Chapters">
        {TOUR_CHAPTERS.map((chapter, i) => {
          const current = i === state.chapterIndex;
          return (
            <Tooltip key={chapter.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`Chapter ${i + 1}: ${chapter.title}`}
                  aria-current={current ? "step" : undefined}
                  className="group flex h-6 min-w-0 flex-1 cursor-pointer items-center rounded-sm outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-border-interactive"
                  onClick={(event) => {
                    // A pointer click lands exactly where it points, in whichever
                    // chapter; keyboard activation (detail 0) goes to its start.
                    const rect = event.currentTarget.getBoundingClientRect();
                    const fraction =
                      event.detail > 0 && rect.width > 0
                        ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
                        : 0;
                    if (!current) player.goTo(i, { autoplay: true });
                    else if (state.status === "ended") player.play();
                    player.seek(fraction * player.timing.duration);
                  }}
                >
                  <span
                    className={cn(
                      "relative h-1 w-full overflow-hidden rounded-full transition-[height] duration-150 ease-out group-hover:h-1.5",
                      i < state.chapterIndex ? "bg-text-primary" : "bg-overlay-strong"
                    )}
                  >
                    {current && <CurrentFill player={player} />}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {i + 1}. {chapter.title}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <TimeReadout player={player} />

      <IconButton
        label="Mute narration"
        pressed={state.muted}
        onClick={() => {
          player.setMuted(!state.muted);
          onMutedChange(!state.muted);
        }}
      >
        {state.muted ? <VolumeX /> : <Volume2 />}
      </IconButton>
    </div>
  );
}
