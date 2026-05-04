import type { ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";

export function renderPaneStateBadge(
  paneId: string,
  state: AgentState | undefined
): ReactElement | null {
  if (state !== "working" && state !== "waiting" && state !== "exited") return null;
  const labels: Record<"working" | "waiting" | "exited", string> = {
    working: "Working",
    waiting: "Waiting",
    exited: "Exited",
  };
  const tone =
    state === "exited"
      ? "bg-tint/[0.08] text-daintree-text/40"
      : "bg-tint/[0.08] text-daintree-text/70";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
        tone
      )}
      data-testid={`fleet-pane-state-${paneId}-${state}`}
      data-state={state}
    >
      {labels[state]}
    </span>
  );
}
