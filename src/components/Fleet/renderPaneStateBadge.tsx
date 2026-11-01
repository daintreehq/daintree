import type { ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import type { AgentState } from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import { actionableWaitingReason } from "@shared/utils/waitingReasonDisplay";
import { bandLabel, type FleetBand } from "@/lib/fleetAttention";

/** What the terminal last showed when the fleet has no band for it to name. */
export const OBSERVED_WAIT_LABEL = "Last seen waiting";

const BAND_NAMED_WAITS: ReadonlySet<FleetBand> = new Set<FleetBand>([
  "needs-you",
  "review",
  "done",
  "blocked",
  "parked",
  "snoozed",
  "idle",
]);

/**
 * A waiting pane's badge, by its fleet band.
 *
 * Amber is the fleet's `needs-you` alone — Canopy read an ask on this turn the
 * user hasn't seen — and only while the pane itself still shows the wait: the
 * band is polled and the pane's state is pushed, so an error wait or a reply
 * that has since landed must not keep a stale ask's hue. The words are the
 * band's own, so "Waiting" never names a run that isn't asking. With no band
 * yet (no fleet report, a run the fleet doesn't hold) or one still catching up
 * with the stop, the badge says only what the terminal showed.
 */
export function describeWaitBadge(
  band: FleetBand | undefined,
  waitingReason?: WaitingReason
): { label: string; asking: boolean } {
  const asking = band === "needs-you" && waitingReason !== "error";
  if (band === undefined || !BAND_NAMED_WAITS.has(band) || (band === "needs-you" && !asking)) {
    return { label: OBSERVED_WAIT_LABEL, asking: false };
  }
  return { label: bandLabel(band, { agentState: "waiting" }), asking };
}

export function renderPaneStateBadge(
  paneId: string,
  state: AgentState | undefined,
  waitingReason?: WaitingReason,
  band?: FleetBand
): ReactElement | null {
  if (state !== "working" && state !== "waiting" && state !== "exited") return null;
  const wait = state === "waiting" ? describeWaitBadge(band, waitingReason) : null;
  // The classified reason rides along as an observation for tests and styling;
  // it never decides the hue or the words, which are the band's.
  const reason = state === "waiting" ? actionableWaitingReason(waitingReason) : null;
  const label = wait ? wait.label : state === "working" ? "Working" : "Exited";
  // Exited keeps a readable text tone, so the "dead pane recedes" signal moves
  // off contrast onto the chip surface: exited drops the fill the live states carry.
  // The `outline` tone washes every chip, so exited clears it back to the hairline.
  const tone =
    state === "exited"
      ? "bg-transparent text-text-secondary"
      : wait?.asking
        ? "text-state-waiting"
        : "text-text-secondary";
  return (
    <Badge
      size="xs"
      tone="outline"
      className={tone}
      data-testid={`fleet-pane-state-${paneId}-${state}`}
      data-state={state}
      {...(reason ? { "data-waiting-reason": reason } : {})}
    >
      {label}
    </Badge>
  );
}
