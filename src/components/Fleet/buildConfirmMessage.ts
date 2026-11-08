import type { FleetPendingActionKind } from "@/store/fleetPendingActionStore";
import { pluralize, pluralNoun } from "@/lib/pluralize";

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

interface FleetConfirmCopy {
  actionId: FleetConfirmActionId;
  verb: string;
  target: string;
  /** What is called off, as a noun: "Cancel restart". */
  noun: string;
}

const CONFIRM_COPY: Record<FleetPendingActionKind, FleetConfirmCopy> = {
  reject: { actionId: "fleet.reject", verb: "Reject", target: "prompt", noun: "rejection" },
  interrupt: { actionId: "fleet.interrupt", verb: "Interrupt", target: "agent", noun: "interrupt" },
  restart: { actionId: "fleet.restart", verb: "Restart", target: "agent", noun: "restart" },
  kill: { actionId: "fleet.kill", verb: "Kill", target: "terminal", noun: "kill" },
  trash: { actionId: "fleet.trash", verb: "Trash", target: "terminal", noun: "trash" },
};

export function confirmActionId(kind: FleetPendingActionKind): FleetConfirmActionId {
  return CONFIRM_COPY[kind].actionId;
}

export interface FleetConfirmLabels {
  confirm: string;
  cancel: string;
  /** Announced when the confirmation lapses unanswered. */
  expired: string;
}

export function buildConfirmLabels(
  kind: FleetPendingActionKind,
  count: number
): FleetConfirmLabels {
  const { verb, target, noun } = CONFIRM_COPY[kind];
  const capitalized = noun.charAt(0).toUpperCase() + noun.slice(1);
  return {
    confirm: `${verb} ${pluralNoun(count, target)}`,
    cancel: `Cancel ${noun}`,
    expired: `${capitalized} confirmation expired`,
  };
}
