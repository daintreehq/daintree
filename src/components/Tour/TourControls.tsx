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

function segmentBar(played: boolean) {
  return cn(
    "relative h-1 w-full overflow-hidden rounded-full transition-[height,background-color] duration-150 ease-out group-hover:h-1.5",
    played ? "bg-text-primary" : "bg-border-strong group-hover:bg-text-secondary"
  );
}

/** Another chapter's segment: a jump to the start of that chapter. */
function ChapterSegment({
  player,
  index,
  title,
  played,
}: {
  player: TourPlayer;
  index: number;
  title: string;
  played: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Chapter ${index + 1}: ${title}`}
          className="group flex h-6 min-w-0 flex-1 cursor-pointer items-center rounded-sm outline-hidden transition-[flex-grow] duration-150 ease-out focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-border-interactive"
          onClick={() => player.goTo(index, { autoplay: true })}
        >
          <span className={segmentBar(played)} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {index + 1}. {title}
      </TooltipContent>
    </Tooltip>
  );
}

function spokenTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${s} second${s === 1 ? "" : "s"}`;
}

/**
 * The playing chapter's segment, widened so it can be scrubbed with some
 * precision: a slider over the chapter's own timeline. Arrow keys seek through
 * the dialog's player keys; Home and End are its own.
 */
function CurrentSegment({ player, ended }: { player: TourPlayer; ended: boolean }) {
  const time = useTourTime();
  const duration = player.timing.duration;
  const progress = Math.min(1, time / duration);

  const seekTo = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    if (ended) player.play();
    player.seek(fraction * duration);
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Chapter position"
      aria-valuemin={0}
      aria-valuemax={Math.floor(duration)}
      aria-valuenow={Math.floor(time)}
      aria-valuetext={`${spokenTime(time)} of ${spokenTime(duration)}`}
      className="group flex h-6 min-w-0 flex-[5] cursor-pointer touch-none items-center rounded-sm outline-hidden transition-[flex-grow] duration-150 ease-out focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-border-interactive"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        seekTo(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) seekTo(event);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        player.seek(event.key === "Home" ? 0 : duration);
      }}
    >
      <span className={cn(segmentBar(false), "overflow-visible")}>
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-text-primary"
          style={{ width: `${progress * 100}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-primary opacity-0 shadow-[var(--theme-shadow-ambient)] transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
          style={{ left: `${progress * 100}%` }}
        />
      </span>
    </div>
  );
}

function TimeReadout({ player }: { player: TourPlayer }) {
  const time = useTourTime();
  return (
    <span className="shrink-0 text-xs tabular-nums text-text-secondary">
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
 * The player bar: a per-chapter progress track along its top edge, then play,
 * the time and the chapter's title, and mute. The track is segmented so the
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
  const chapter = TOUR_CHAPTERS[state.chapterIndex]!;

  return (
    <div className="border-t border-border-subtle bg-surface-panel px-3 pb-2 pt-1">
      <div className="flex items-center gap-1" role="group" aria-label="Chapters">
        {TOUR_CHAPTERS.map((c, i) => {
          return i !== state.chapterIndex ? (
            <ChapterSegment
              key={c.id}
              player={player}
              index={i}
              title={c.title}
              played={i < state.chapterIndex}
            />
          ) : (
            <CurrentSegment key={c.id} player={player} ended={state.status === "ended"} />
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <IconButton
          label={ended ? "Replay" : "Play"}
          pressed={ended ? undefined : playing}
          onClick={() => player.toggle()}
        >
          {ended ? (
            <RotateCcw />
          ) : playing ? (
            <Pause className="fill-current" />
          ) : (
            <Play className="fill-current" />
          )}
        </IconButton>
        <TimeReadout player={player} />
        <span aria-hidden="true" className="text-xs text-text-secondary">
          ·
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {chapter.title}
        </h3>
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
    </div>
  );
}
