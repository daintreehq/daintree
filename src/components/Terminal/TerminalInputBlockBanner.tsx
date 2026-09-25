import { useState } from "react";
import { Lock } from "lucide-react";
import {
  getTerminalInputBlockMessage,
  type TerminalInputBlock,
} from "@/services/terminal/inputGate";
import { takeOverDrive } from "@/hooks/useHostConnection";
import { logWarn } from "@/utils/logger";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";

/**
 * Why this pane isn't taking what the user types: the host link is down, or
 * another machine drives the project. Output keeps flowing, so this reports
 * what was observed, neutrally, rather than an error. When another machine
 * drives, the one action is to ask for the project back.
 */
export function TerminalInputBlockBanner({ block }: { block: TerminalInputBlock }) {
  const [takingOver, setTakingOver] = useState(false);
  const projectId = block.kind === "driven-elsewhere" ? block.projectId : undefined;

  const actions: BannerAction[] = [];
  if (projectId) {
    actions.push({
      id: "take-over",
      label: block.kind === "driven-elsewhere" && block.hostLocal ? "Take back" : "Take over",
      variant: "primary",
      loading: takingOver,
      disabled: takingOver,
      onClick: () => {
        setTakingOver(true);
        takeOverDrive(projectId)
          .catch((error: unknown) => {
            // The lease stays where it was and the banner with it; nothing
            // else changed that the user needs telling about.
            logWarn("[HostConnection] Couldn't take over driving this project", { error });
          })
          .finally(() => setTakingOver(false));
      },
    });
  }

  return (
    <InlineStatusBanner
      icon={Lock}
      severity="neutral"
      layout="inline"
      title={getTerminalInputBlockMessage(block)}
      role="status"
      ariaLive="polite"
      {...(actions.length > 0 && { actions })}
    />
  );
}
