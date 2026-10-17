import { Lock, LockOpen } from "lucide-react";
import {
  getTerminalInputBlockMessage,
  type TerminalInputBlock,
} from "@/services/terminal/inputGate";
import { takeControl, useTakeControlPending } from "@/components/Recovery/takeControl";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";

/**
 * Why this pane isn't taking what the user types: the host link is down, or
 * another device controls the project. Output keeps flowing, so this reports
 * what was observed, neutrally, rather than an error. When another device has
 * control, the one action is to take it here, and the keyboard comes back to
 * this pane once it lands.
 */
export function TerminalInputBlockBanner({
  block,
  panelId,
}: {
  block: TerminalInputBlock;
  panelId?: string;
}) {
  const projectId = block.kind === "driven-elsewhere" ? block.projectId : undefined;
  const busy = useTakeControlPending(projectId);

  const actions: BannerAction[] = [];
  if (projectId) {
    actions.push({
      id: "take-control",
      label: "Take control",
      variant: "primary",
      loading: busy,
      disabled: busy,
      onClick: () => void takeControl(projectId, panelId),
    });
  }

  return (
    <InlineStatusBanner
      icon={Lock}
      severity="neutral"
      layout="inline"
      title={getTerminalInputBlockMessage(block)}
      role="status"
      // Said once for the window (a change of control by driveLeaseState, a
      // lost link by hostConnectionAnnouncements): every pane repeating it
      // would read the same sentence once per pane.
      ariaLive="off"
      {...(actions.length > 0 && { actions })}
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
