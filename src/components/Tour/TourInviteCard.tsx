import { useEffect, useState } from "react";
import { CirclePlay, X } from "lucide-react";
import type { TourOnboardingState } from "@shared/types";
import { Button } from "@/components/ui/button";
import { getOnboardingState } from "@/clients/onboardingClient";
import { cn } from "@/lib/utils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { TOUR_CHAPTERS } from "./tourChapters";
import { resolveTourTimings } from "./tourTiming";
import { DAINTREE_TOUR_COMPLETED_EVENT, openDaintreeTour } from "./tourEvents";

/** How long the "find it in Help" note stays after the invitation is turned down. */
const DISMISSED_NOTE_MS = 4000;

/** The tour's length in whole minutes, from the same timings the player uses. */
export function tourMinutes(): number {
  const seconds = resolveTourTimings().reduce((sum, timing) => sum + timing.duration, 0);
  return Math.max(1, Math.round(seconds / 60));
}

type InviteState =
  | { kind: "hidden" }
  | { kind: "invite" }
  | { kind: "resume"; chapter: number }
  | { kind: "dismissed-note" };

export function inviteStateFor(tour: TourOnboardingState): InviteState {
  if (tour.completed || tour.dismissed) return { kind: "hidden" };
  if (tour.lastChapter > 0 && tour.lastChapter < TOUR_CHAPTERS.length) {
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
    const refresh = () =>
      // Deferred so a missing bridge (tests, previews) rejects instead of throwing
      // out of the effect.
      safeFireAndForget(
        Promise.resolve()
          .then(() => getOnboardingState())
          .then((onboarding) => {
            if (!active) return;
            setState((current) =>
              current.kind === "dismissed-note" ? current : inviteStateFor(onboarding.tour)
            );
          }),
        { context: "Reading tour invitation state" }
      );
    const onCompleted = () => setState({ kind: "hidden" });
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener(DAINTREE_TOUR_COMPLETED_EVENT, onCompleted);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.removeEventListener(DAINTREE_TOUR_COMPLETED_EVENT, onCompleted);
      window.removeEventListener("focus", onVisible);
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
 */
export function TourInviteCard({ className }: { className?: string }) {
  const [state, setState] = useTourOffer();

  useEffect(() => {
    if (state.kind !== "dismissed-note") return;
    const timer = window.setTimeout(() => setState({ kind: "hidden" }), DISMISSED_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [state.kind, setState]);

  if (state.kind === "hidden") return null;

  if (state.kind === "dismissed-note") {
    return (
      <div className={className}>
        <p className="text-xs text-text-secondary" role="status">
          Find it anytime in Help › Daintree Tour
        </p>
      </div>
    );
  }

  const dismiss = () => {
    setState({ kind: "dismissed-note" });
    safeFireAndForget(window.electron.onboarding.dismissTourInvite(), {
      context: "Dismissing the tour invitation",
    });
  };
  const resuming = state.kind === "resume";

  return (
    <div className={cn("w-full", className)} data-testid="tour-invite-card">
      <div className="relative w-full rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle px-4 py-3.5">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss tour invitation"
          className="absolute top-2 right-2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-secondary transition-colors hover:bg-overlay-emphasis hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="flex items-start gap-3 pr-6">
          <CirclePlay className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-left">
            <h3 className="text-sm font-semibold text-text-primary">
              {resuming ? "Pick up the Daintree Tour" : "Take the Daintree Tour"}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              {resuming
                ? `You stopped at chapter ${state.chapter + 1} of ${TOUR_CHAPTERS.length}: ${TOUR_CHAPTERS[state.chapter]!.title}.`
                : `A narrated walkthrough of worktrees, agents, the Assistant and more, about ${tourMinutes()} minutes. Skip any chapter.`}
            </p>
            <div className="mt-4 flex items-center gap-2">
              {/* Outline, not a fill: the launcher above is this surface's lead action. */}
              <Button size="sm" variant="outline" onClick={openDaintreeTour}>
                <CirclePlay className="h-3.5 w-3.5" />
                {resuming ? "Resume tour" : "Start tour"}
              </Button>
              <button
                type="button"
                onClick={dismiss}
                className="text-xs text-text-secondary transition-colors hover:text-text-primary"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      </div>
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
    <button
      type="button"
      onClick={openDaintreeTour}
      className="text-xs text-text-secondary underline-offset-4 transition-colors hover:text-text-primary hover:underline"
    >
      {state.kind === "resume"
        ? "Pick up where you left off in the Daintree Tour"
        : `New here? Take the ${tourMinutes()}-minute tour`}
    </button>
  );
}
