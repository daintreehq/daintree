import { useWaitingTerminals } from "@/hooks/useTerminalSelectors";
import { STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import { StatusContainer, type StatusContainerConfig } from "./StatusContainer";

const waitingConfig: StatusContainerConfig = {
  icon: STATE_ICONS.waiting,
  iconColor: "text-status-warning",
  badgeColor: "bg-status-warning",
  badgeTextColor: "text-daintree-bg",
  headerLabel: "Waiting For Input",
  buttonLabel: "Waiting",
  statusAriaLabel: "Waiting for input",
  contentAriaLabel: "Waiting terminals",
  contentId: "waiting-container-popover",
  useTerminals: useWaitingTerminals,
};

interface WaitingContainerProps {
  compact?: boolean;
}

export function WaitingContainer({ compact = false }: WaitingContainerProps) {
  return <StatusContainer config={waitingConfig} compact={compact} />;
}
