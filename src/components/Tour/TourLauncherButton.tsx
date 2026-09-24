import { useEffect, useState } from "react";
import { CirclePlay } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getOnboardingState } from "@/clients/onboardingClient";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { DAINTREE_TOUR_COMPLETED_EVENT, openDaintreeTour } from "./tourEvents";

/** App sessions the empty-grid launcher keeps offering the tour for. */
export const TOUR_LAUNCHER_SESSIONS = 3;

/**
 * One quiet button on the empty panel grid for a new user's first few
 * sessions. It never returns once the tour is finished, and the Help menu
 * keeps the tour reachable after it stops appearing.
 */
export function TourLauncherButton({ className }: { className?: string }) {
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const decide = async () => {
      const state = await getOnboardingState();
      if (state.tour.completed) return;
      // Main counts this at most once per app session, so remounts and other
      // project views showing the same button don't burn the window.
      const tour = await window.electron.onboarding.markTourLauncherShown();
      if (!cancelled) {
        setEligible(!tour.completed && tour.launcherSessions <= TOUR_LAUNCHER_SESSIONS);
      }
    };
    safeFireAndForget(decide(), { context: "Checking tour launcher eligibility" });
    // Finishing the tour withdraws the offer at once, and wins over an
    // eligibility check still in flight.
    const onCompleted = () => {
      cancelled = true;
      setEligible(false);
    };
    window.addEventListener(DAINTREE_TOUR_COMPLETED_EVENT, onCompleted);
    return () => {
      cancelled = true;
      window.removeEventListener(DAINTREE_TOUR_COMPLETED_EVENT, onCompleted);
    };
  }, []);

  if (!eligible) return null;
  return (
    <div className={className}>
      <Button variant="ghost" size="sm" onClick={openDaintreeTour}>
        <CirclePlay aria-hidden="true" />
        Take the Daintree Tour
      </Button>
    </div>
  );
}
