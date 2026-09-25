import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { EMPTY_MOCK_KIT, MockKitContext } from "./mockup/MockKitContext";
import { TourControls } from "./TourControls";
import { TourPlayer, type TourAudio } from "@daintreehq/tour";
import type { TourDefinition } from "./tourDefinition";
import { TourCaption, TourStage } from "./TourStage";
import { currentTourKeyboard, type TourKeyboard } from "./tourKeys";
import { TourPlayerContext, useTourPlayerState } from "@daintreehq/tour/react";
import { TourKeyboardContext } from "./tourKeyboardContext";

export interface TourDialogProps {
  isOpen: boolean;
  /** The tour to play. Held for the whole opening: a different tour is a new opening. */
  tour: TourDefinition;
  onClose: () => void;
  initialChapter: number;
  initialMuted: boolean;
  onChapterReached: (index: number) => void;
  onCompleted: () => void;
  onMutedChange: (muted: boolean) => void;
  /** Harness seam: receives each player as it is created. */
  onPlayer?: (player: TourPlayer) => void;
  /** Harness seam: the keyboard to narrate and draw. Defaults to this platform's. */
  keyboard?: TourKeyboard;
}

function createBrowserPlayer(
  tour: TourDefinition,
  muted: boolean,
  keyboard: TourKeyboard
): TourPlayer {
  return new TourPlayer(
    tour.resolveTimings(keyboard),
    {
      createAudio: (url) => new Audio(url) as TourAudio,
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
    },
    { muted }
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function TourBody({
  tour,
  player,
  onClose,
  onChapterReached,
  onCompleted,
  onMutedChange,
}: Omit<TourDialogProps, "isOpen" | "initialChapter" | "initialMuted" | "onPlayer" | "keyboard"> & {
  player: TourPlayer;
}) {
  const state = useTourPlayerState(player);
  // Holding stops a finished chapter's countdown; any new chapter or replay starts fresh.
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const backLeavingRef = useRef(false);
  const held = state.status === "ended" && heldAt === state.chapterIndex;
  const chapters = tour.chapters;
  const chapter = chapters[state.chapterIndex]!;
  const isLast = state.chapterIndex === chapters.length - 1;

  // "Stay here" holds one ending: once the chapter plays again, from any
  // control, its next ending counts down afresh.
  useEffect(() => {
    if (state.status === "playing") setHeldAt(null);
  }, [state.status]);

  useLayoutEffect(() => {
    if (!backLeavingRef.current) return;
    backLeavingRef.current = false;
    bodyRef.current?.querySelector<HTMLElement>("[data-confirm-role='confirm']")?.focus();
  }, [state.chapterIndex]);

  const reachedRef = useRef(onChapterReached);
  const completedRef = useRef(onCompleted);
  useEffect(() => {
    reachedRef.current = onChapterReached;
    completedRef.current = onCompleted;
  }, [onChapterReached, onCompleted]);

  useEffect(() => {
    reachedRef.current(state.chapterIndex);
  }, [state.chapterIndex]);

  useEffect(() => {
    if (isLast && state.status === "ended") completedRef.current();
  }, [isLast, state.status]);

  const Icon = tour.icon;

  const advance = () => {
    if (isLast) {
      completedRef.current();
      onClose();
      tour.finish?.run();
    } else {
      player.next();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
    const onButton = event.target instanceof HTMLButtonElement;
    switch (event.key) {
      case "k":
      case " ":
        if (event.key === " " && onButton) return;
        // On a finished chapter, pause means "stay here", not "replay".
        if (state.status === "ended") setHeldAt(state.chapterIndex);
        else player.toggle();
        break;
      case "m":
        player.setMuted(!state.muted);
        onMutedChange(!state.muted);
        break;
      case "ArrowLeft":
        player.seek(player.getTime() - 5);
        break;
      case "ArrowRight":
        player.seek(player.getTime() + 5);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    // Player keys mirror common video players and cover the whole dialog —
    // header and footer too, where focus starts. `contents` keeps the dialog's
    // own column layout intact.
    <div ref={bodyRef} className="contents" onKeyDown={onKeyDown}>
      <AppDialog.Header>
        <div className="flex min-w-0 items-center gap-3">
          <AppDialog.Title
            icon={Icon ? <Icon className="shrink-0 text-text-secondary" /> : undefined}
          >
            {tour.title}
          </AppDialog.Title>
          {/* Position in the tour, beside the title like a wizard's step count. */}
          <span
            className="shrink-0 text-sm tabular-nums text-text-secondary"
            data-testid="tour-chapter-count"
          >
            Chapter {state.chapterIndex + 1} of {chapters.length}
          </span>
        </div>
        <AppDialog.CloseButton aria-label="Close tour" />
      </AppDialog.Header>
      <div className="px-6 py-5">
        {/* One player: stage, caption band and bar share a frame, like a video.
            The stage is the only part of the dialog that can give up space, so
            on a short window the player's width follows the height left after
            the chrome (header, caption band, bar, footer, padding — 21rem). */}
        <div className="mx-auto w-full max-w-[calc((92vh-21rem)*16/9)] overflow-hidden rounded-lg border border-border-subtle">
          <TourStage
            tourId={tour.id}
            chapterId={chapter.id}
            chapterTitle={chapter.title}
            Scene={chapter.scene}
            // A broken scene has nothing to narrate over; the controls stay to move on.
            onSceneError={() => player.pause()}
            endCard={
              state.status === "ended"
                ? {
                    nextTitle: chapters[state.chapterIndex + 1]?.title ?? null,
                    nextNumber: isLast ? null : state.chapterIndex + 2,
                    held,
                    onHold: () => setHeldAt(state.chapterIndex),
                    onNext: advance,
                    onReplay: () => player.play(),
                    finishHint: tour.finish?.hint,
                  }
                : null
            }
          />
          <TourCaption />
          <TourControls player={player} chapters={chapters} onMutedChange={onMutedChange} />
        </div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {/* Position and title only: the narration starts at the same moment. */}
          {`Chapter ${state.chapterIndex + 1} of ${chapters.length}: ${chapter.title}`}
        </div>
      </div>
      <AppDialog.Footer
        secondaryAction={
          state.chapterIndex > 0
            ? {
                label: "Back",
                onClick: () => {
                  // Back leaves with the first chapter; its focus goes to Next.
                  const active = document.activeElement;
                  backLeavingRef.current =
                    state.chapterIndex === 1 &&
                    active instanceof HTMLElement &&
                    active.dataset.confirmRole === "cancel";
                  player.previous();
                },
              }
            : undefined
        }
        primaryAction={{ label: isLast ? "Finish" : "Next", onClick: advance }}
      />
    </div>
  );
}

/**
 * Plays a tour: short narrated chapters, each an animated mockup of one idea.
 * Starts playing on open; every chapter's narration preloads as soon as it
 * does. Closing at any point is the skip.
 */
export function TourDialog({
  isOpen,
  tour,
  onClose,
  initialChapter,
  initialMuted,
  onChapterReached,
  onCompleted,
  onMutedChange,
  onPlayer,
  keyboard = currentTourKeyboard(),
}: TourDialogProps) {
  const [player, setPlayer] = useState<TourPlayer | null>(null);
  // The player is built once per opening from these; afterwards chapter and
  // mute are the player's own state, so later prop changes must not rebuild it.
  const openingRef = useRef({ initialChapter, initialMuted, onPlayer });
  useEffect(() => {
    openingRef.current = { initialChapter, initialMuted, onPlayer };
  }, [initialChapter, initialMuted, onPlayer]);

  useEffect(() => {
    if (!isOpen) return;
    const opening = openingRef.current;
    const next = createBrowserPlayer(tour, opening.initialMuted, keyboard);
    const chapter = Math.min(Math.max(0, opening.initialChapter), tour.chapters.length - 1);
    next.goTo(chapter, { autoplay: true });
    opening.onPlayer?.(next);
    setPlayer(next);
    return () => {
      next.dispose();
      setPlayer(null);
    };
  }, [isOpen, tour, keyboard]);

  return (
    <AppDialog
      isOpen={isOpen && player !== null}
      onClose={onClose}
      size="4xl"
      maxHeight="max-h-[92vh]"
      initialFocus="confirm"
      data-testid="daintree-tour"
    >
      {player && (
        <MockKitContext.Provider value={tour.mockKit ?? EMPTY_MOCK_KIT}>
          <TourPlayerContext.Provider value={player}>
            <TourKeyboardContext.Provider value={keyboard}>
              <TourBody
                tour={tour}
                player={player}
                onClose={onClose}
                onChapterReached={onChapterReached}
                onCompleted={onCompleted}
                onMutedChange={onMutedChange}
              />
            </TourKeyboardContext.Provider>
          </TourPlayerContext.Provider>
        </MockKitContext.Provider>
      )}
    </AppDialog>
  );
}
