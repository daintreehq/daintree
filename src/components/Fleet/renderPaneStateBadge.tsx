import type { ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import type { AgentState } from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import {
  actionableWaitingReason,
  WAITING_REASON_BADGE_LABEL,
} from "@shared/utils/waitingReasonDisplay";

export function renderPaneStateBadge(
  paneId: string,
  state: AgentState | undefined,
  waitingReason?: WaitingReason
): ReactElement | null {
  if (state !== "working" && state !== "waiting" && state !== "exited") return null;
  const labels: Record<"working" | "waiting" | "exited", string> = {
    working: "Working",
    waiting: "Waiting",
    exited: "Exited",
  };
  // Waiting rows are what a fleet scan is hunting for: tint them with the
  // waiting state color and name the classified reason when the classifier
  // had real evidence. The `prompt` fallback keeps the generic "Waiting".
  const reason = state === "waiting" ? actionableWaitingReason(waitingReason) : null;
  // Exited keeps a readable text tone, so the "dead pane recedes" signal moves
  // off contrast onto the chip surface: exited drops the fill the live states carry.
  // The `outline` tone washes every chip, so exited clears it back to the hairline.
  const tone =
    state === "exited"
      ? "bg-transparent text-text-secondary"
      : state === "waiting"
        ? "text-state-waiting"
        : "text-daintree-text/70";
  return (
    <Badge
      size="xs"
      tone="outline"
      className={tone}
      data-testid={`fleet-pane-state-${paneId}-${state}`}
      data-state={state}
      {...(reason ? { "data-waiting-reason": reason } : {})}
    >
      {reason ? WAITING_REASON_BADGE_LABEL[reason] : labels[state]}
    </Badge>
  );
}
