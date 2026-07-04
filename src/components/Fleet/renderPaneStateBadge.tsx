import type { ReactElement } from "react";
import { cn } from "@/lib/utils";
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
  const tone =
    state === "exited"
      ? "bg-tint/[0.08] text-daintree-text/40"
      : state === "waiting"
        ? "bg-tint/[0.08] text-state-waiting"
        : "bg-tint/[0.08] text-daintree-text/70";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
        tone
      )}
      data-testid={`fleet-pane-state-${paneId}-${state}`}
      data-state={state}
      {...(reason ? { "data-waiting-reason": reason } : {})}
    >
      {reason ? WAITING_REASON_BADGE_LABEL[reason] : labels[state]}
    </span>
  );
}
