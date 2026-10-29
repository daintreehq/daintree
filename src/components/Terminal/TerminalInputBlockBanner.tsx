import { useSyncExternalStore } from "react";
import { Lock, LockOpen } from "lucide-react";
import {
  getTerminalInputBlockMessage,
  subscribeRefusedInput,
  wasInputRefused,
  type TerminalInputBlock,
} from "@/services/terminal/inputGate";
import {
  takeControl,
  useControlConfirmed,
  useTakeControlBusy,
} from "@/components/Recovery/takeControl";
import { useControlFacts } from "@/components/Recovery/driveLeaseState";
import {
  TAKING_CONTROL,
  takeControlAriaLabel,
  takeControlSentence,
} from "@/components/Recovery/recoveryCopy";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";

/**
 * What a pane's strip slot shows: why it isn't taking input, only in the pane
 * the user last tried to type or send something into — the window's banner
 * says it for every pane at once, so a grid never repeats one fact per pane —
 * and, for a moment after control lands here, that it did.
 */
export function usePaneInputNotice(
  panelId: string,
  block: TerminalInputBlock | null
): "blocked" | "confirmed" | null {
  const refused = useSyncExternalStore(
    subscribeRefusedInput,
    () => wasInputRefused(panelId),
    () => false
  );
  const confirmed = useControlConfirmed(panelId);
  if (block !== null && refused) return "blocked";
  if (block === null && confirmed) return "confirmed";
  return null;
}

/**
 * Why this pane didn't take what the user typed: the host link is down, or
 * another device controls the project. Output keeps flowing, so this reports
 * what was observed, neutrally, rather than an error. When another device has
 * control, this is where the user was working, so the offer is made here too,
 * with what it does to that device, and the keyboard comes back to this pane
 * once it lands.
 */
export function TerminalInputBlockBanner({
  block,
  panelId,
}: {
  block: TerminalInputBlock;
  panelId?: string;
}) {
  const projectId = block.kind === "driven-elsewhere" ? block.projectId : undefined;
  const busy = useTakeControlBusy(projectId);
  const facts = useControlFacts();

  const actions: BannerAction[] = [];
  if (projectId) {
    actions.push({
      id: "take-control",
      label: "Take control",
      ...(facts !== null && { ariaLabel: takeControlAriaLabel(facts) }),
      variant: "primary",
      loading: busy,
      onClick: () => void takeControl(projectId, panelId),
    });
  }

  return (
    <InlineStatusBanner
      icon={Lock}
      severity="neutral"
      layout="pane"
      title={getTerminalInputBlockMessage(block)}
      description={
        block.kind === "driven-elsewhere" && facts !== null
          ? busy
            ? TAKING_CONTROL
            : takeControlSentence(facts)
          : undefined
      }
      role="status"
      // Said once for the window (a change of control by driveLeaseState, a
      // lost link by hostConnectionAnnouncements).
      ariaLive="off"
      actions={actions}
    />
  );
}

/**
 * The pane control just arrived in, for a moment: the blocked strip giving way
 * to nothing would say it only by absence. Spoken once by the lease state, so
 * this stays silent, and it holds no control so the caret stays in the input.
 */
export function ControlConfirmedBanner() {
  return (
    <InlineStatusBanner
      icon={LockOpen}
      severity="neutral"
      layout="inline"
      title="You have control of this project"
      role="status"
      ariaLive="off"
      actions={[]}
    />
  );
}
