import { useEffect, useRef, useState, type MouseEvent } from "react";
import { CirclePlay } from "lucide-react";
import type { TourOnboardingState } from "@shared/types";
import { DAINTREE_TOUR_ID, tourProgressFor } from "@shared/utils/tourIds";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getOnboardingState } from "@/clients/onboardingClient";
import { getPerformanceModeFloor, UI_EXIT_DURATION } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { TourSummary } from "./tourDefinition";
import { openDaintreeTour, TOUR_COMPLETED_EVENT, tourIdOf } from "./tourEvents";
// The registry hands out summaries only: this card renders at startup, and the
// full definition pulls the narration, cue manifest and parser in with it.
import { getTour } from "./tourRegistry";

/** How long the "find it in Help" note stays after the invitation is turned down. */
const DISMISSED_NOTE_MS = 8000;

type Offer = { kind: "invite" } | { kind: "resume"; chapter: number };

/**
 * After a dismissal the card fades out, the note fades in where it stood, and
 * the note fades out in turn — each phase its own render so the exit can play.
 */
type NotePhase = "card-out" | "note" | "note-out";

type InviteState =
  { kind: "hidden" } | Offer | { kind: "dismissed-note"; from: Offer; phase: NotePhase };

/** The Daintree tour is built in, so its registration is always there. */
function daintreeSummary(): TourSummary {
  return getTour(DAINTREE_TOUR_ID)!.summary;
}

export function inviteStateFor(tour: TourOnboardingState): { kind: "hidden" } | Offer {
  if (tour.completed || tour.dismissed) return { kind: "hidden" };
  if (tour.lastChapter > 0 && tour.lastChapter < daintreeSummary().chapterTitles.length) {
    return { kind: "resume", chapter: tour.lastChapter };
  }
  return { kind: "invite" };
}

/**
 * Tracks whether the tour is still on offer: not finished and not turned
 * down. Re-reads when this project view comes back into use, since each view
 * is its own renderer and a tour finished elsewhere never arrives as an event.
 */
function useTourOffer() {
  const [state, setState] = useState<InviteState>({ kind: "hidden" });

  useEffect(() => {
    let active = true;
    // Restoring a minimized window fires `visibilitychange` and `focus` back to
    // back, each its own dispatch, so both would otherwise pay an IPC read.
    // One read per activation: leaving (blur or hide) starts a new one, whose
    // return must read afresh rather than inherit a read from before the user
    // left. A failed read gives its activation back so the next signal retries.
    let activation = 0;
    let readActivation: number | null = null;
    let latestRead = 0;
    const refresh = () => {
      if (readActivation === activation) return;
      const claimed = activation;
      readActivation = claimed;
      const read = ++latestRead;
      // Deferred so a missing bridge (tests, previews) rejects instead of throwing
      // out of the effect.
      safeFireAndForget(
        Promise.resolve()
          .then(() => getOnboardingState())
          .then(
            (onboarding) => {
              // An older read landing after a newer one started is stale.
              if (!active || read !== latestRead) return;
              setState((current) =>
                current.kind === "dismissed-note"
                  ? current
                  : inviteStateFor(tourProgressFor(onboarding.tours, DAINTREE_TOUR_ID))
              );
            },
            (error: unknown) => {
              if (readActivation === claimed) readActivation = null;
              throw error;
            }
          ),
        { context: "Reading tour invitation state" }
      );
    };
    const onLeave = () => {
      activation++;
    };
    // Another tour finishing leaves this one's offer where it was.
    const onCompleted = (event: Event) => {
      if (tourIdOf(event) === DAINTREE_TOUR_ID) setState({ kind: "hidden" });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
      else onLeave();
    };
    refresh();
    // Mounted while the user is elsewhere: their return is a fresh activation.
    if (!document.hasFocus()) onLeave();
    window.addEventListener(TOUR_COMPLETED_EVENT, onCompleted);
    window.addEventListener("focus", onVisible);
    window.addEventListener("blur", onLeave);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.removeEventListener(TOUR_COMPLETED_EVENT, onCompleted);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return [state, setState] as const;
}

/**
 * The tour's invitation on the empty panel grid. It stays until the user
 * starts the tour, finishes it, or turns it down — never a session count, so
 * a user who dives straight into work still finds it next time the grid is
 * empty. Turning it down is permanent, and says where the tour lives.
 *
 * `focusAfterDismiss` takes focus when the dismissal removes the control that
 * held it, so a keyboard user lands back on the canvas rather than the body.
 */
export function TourInviteCard({
  className,
  focusAfterDismiss,
}: {
  className?: string;
  focusAfterDismiss?: (options: FocusOptions) => void;
}) {
  const [state, setState] = useTourOffer();
  const cardRef = useRef<HTMLDivElement>(null);
  const phase = state.kind === "dismissed-note" ? state.phase : null;

  useEffect(() => {
    if (phase === null) return;
    // Performance mode drops the exit waits, never the note's reading time.
    const [next, delay]: [NotePhase | null, number] =
      phase === "card-out"
        ? ["note", getPerformanceModeFloor(UI_EXIT_DURATION)]
        : phase === "note"
          ? ["note-out", DISMISSED_NOTE_MS]
          : [null, getPerformanceModeFloor(UI_EXIT_DURATION)];
    const timer = window.setTimeout(
      () =>
        setState((current) =>
          current.kind !== "dismissed-note"
            ? current
            : next === null
              ? { kind: "hidden" }
              : { ...current, phase: next }
        ),
      delay
    );
    return () => window.clearTimeout(timer);
  }, [phase, setState]);

  if (state.kind === "hidden") return null;

  const summary = daintreeSummary();
  // Mounted, empty, from the first render: a live region that arrives already
  // holding its text is announced late or not at all.
  const status = (
    <p role="status" aria-atomic="true" className="sr-only">
      {phase === null ? "" : `Tour invitation hidden. Find the tour in Help, ${summary.title}.`}
    </p>
  );

  if (phase === "note" || phase === "note-out") {
    return (
      <div className={className}>
        {status}
        <p
          aria-hidden="true"
          className={cn(
            // The transparent border puts the glyph and text on the card's own content edge.
            "flex w-full items-center gap-3 border border-transparent px-4 text-xs text-text-secondary",
            phase === "note"
              ? "motion-safe:animate-in motion-safe:fade-in motion-safe:[--tw-animation-duration:var(--duration-200)]"
              : "motion-safe:animate-out motion-safe:fade-out motion-safe:fill-mode-forwards motion-safe:[--tw-animation-duration:var(--duration-120)] motion-reduce:invisible"
          )}
        >
          <CirclePlay className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Won&apos;t show again. Find the tour in{" "}
            <span className="text-text-primary">Help › {summary.title}</span>
          </span>
        </p>
      </div>
    );
  }

  const offer = state.kind === "dismissed-note" ? state.from : state;
  const resuming = offer.kind === "resume";

  const dismiss = (event: MouseEvent) => {
    if (state.kind === "dismissed-note") return;
    const hadFocus = cardRef.current?.contains(document.activeElement) ?? false;
    setState({ kind: "dismissed-note", from: state, phase: "card-out" });
    safeFireAndForget(window.electron.onboarding.dismissTourInvite(DAINTREE_TOUR_ID), {
      context: "Dismissing the tour invitation",
    });
    // A pointer press keeps the ring off; a keyboard press is what the ring is for.
    if (hadFocus) focusAfterDismiss?.({ preventScroll: true, focusVisible: event.detail === 0 });
  };

  return (
    <div className={cn("w-full", className)} data-testid="tour-invite-card">
      {status}
      <Card
        ref={cardRef}
        variant="subtle"
        padding="none"
        inert={phase === "card-out"}
        className={cn(
          "w-full px-4 py-4",
          phase === "card-out" &&
            "motion-safe:animate-out motion-safe:fade-out motion-safe:fill-mode-forwards motion-safe:[--tw-animation-duration:var(--duration-120)] motion-reduce:invisible"
        )}
      >
        <div className="flex items-start gap-3">
          <CirclePlay className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-left">
            <h3 className="text-sm font-semibold text-text-primary">
              {resuming
                ? `Pick up the ${summary.title}`
                : `Take the ${summary.minutes}-minute ${summary.title}`}
            </h3>
            {resuming ? (
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                <span className="tabular-nums">
                  Chapter {offer.chapter + 1} of {summary.chapterTitles.length}
                </span>
                <span aria-hidden="true"> · </span>
                <span className="text-text-primary">{summary.chapterTitles[offer.chapter]!}</span>
              </p>
            ) : (
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                A narrated walkthrough of worktrees, agents, the Assistant and more. Skip any
                chapter.
              </p>
            )}
            <div className="mt-4 flex items-center gap-2">
              {/* Outline, not a fill: the launcher above is this surface's lead action. */}
              <Button size="sm" variant="outline" onClick={openDaintreeTour}>
                {resuming ? "Resume tour" : "Start tour"}
              </Button>
              <Button size="sm" variant="ghost" onClick={dismiss}>
                Don&apos;t show again
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * A single quiet line for the welcome screen, where a first-run user has no
 * project yet — the tour runs on mockups, so it doesn't need one. Only after
 * agent setup has been dealt with, so it never competes with Open project and
 * the setup banner on first launch.
 */
export function TourWelcomeLink({ enabled }: { enabled: boolean }) {
  const [state] = useTourOffer();
  if (!enabled || state.kind === "hidden" || state.kind === "dismissed-note") return null;
  return (
    <Button variant="link" onClick={openDaintreeTour} className="text-xs">
      {state.kind === "resume"
        ? "Pick up where you left off in the Daintree Tour"
        : `New here? Take the ${daintreeSummary().minutes}-minute tour`}
    </Button>
  );
}
