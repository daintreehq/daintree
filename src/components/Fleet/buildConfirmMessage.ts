import type { FleetPendingActionKind } from "@/store/fleetPendingActionStore";
import { pluralize } from "@/lib/pluralize";

export type FleetConfirmActionId =
  "fleet.reject" | "fleet.interrupt" | "fleet.restart" | "fleet.kill" | "fleet.trash";

export function buildConfirmMessage(
  kind: FleetPendingActionKind,
  count: number,
  sessionLoss: number
): string {
  switch (kind) {
    case "reject":
      return `Reject ${pluralize(count, "prompt")}?`;
    case "interrupt":
      return `Interrupt ${pluralize(count, "agent")}?`;
    case "restart": {
      const base = `Restart ${pluralize(count, "agent")}?`;
      if (sessionLoss > 0) {
        const noun = sessionLoss === 1 ? "agent will lose its" : "agents will lose their";
        return `${base} ${sessionLoss} ${noun} session.`;
      }
      return base;
    }
    case "kill":
      return `Kill ${pluralize(count, "terminal")}?`;
    case "trash":
      return `Trash ${pluralize(count, "terminal")}?`;
  }
}
