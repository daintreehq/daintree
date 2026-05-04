import type { FleetPendingActionKind } from "@/store/fleetPendingActionStore";

export type FleetConfirmActionId =
  | "fleet.reject"
  | "fleet.interrupt"
  | "fleet.restart"
  | "fleet.kill"
  | "fleet.trash";

export function buildConfirmMessage(
  kind: FleetPendingActionKind,
  count: number,
  sessionLoss: number
): string {
  switch (kind) {
    case "reject":
      return `Reject ${count} ${count === 1 ? "prompt" : "prompts"}?`;
    case "interrupt":
      return `Interrupt ${count} ${count === 1 ? "agent" : "agents"}?`;
    case "restart": {
      const base = `Restart ${count} ${count === 1 ? "agent" : "agents"}?`;
      if (sessionLoss > 0) {
        const noun = sessionLoss === 1 ? "agent will lose its" : "agents will lose their";
        return `${base} ${sessionLoss} ${noun} session.`;
      }
      return base;
    }
    case "kill":
      return `Kill ${count} ${count === 1 ? "terminal" : "terminals"}?`;
    case "trash":
      return `Trash ${count} ${count === 1 ? "worktree" : "worktrees"}?`;
  }
}
