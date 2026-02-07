import { AlertCircle } from "lucide-react";
import { useWaitingTerminals } from "@/hooks/useTerminalSelectors";
import { StatusContainer, type StatusContainerConfig } from "./StatusContainer";

const waitingConfig: StatusContainerConfig = {
  icon: AlertCircle,
  iconColor: "text-amber-400",
  badgeColor: "bg-amber-400",
  badgeTextColor: "text-amber-950",
  headerLabel: "Waiting For Input",
  buttonTitle: "View agents waiting for input",
  buttonLabel: "Waiting",
  statusAriaLabel: "Waiting for input",
  contentAriaLabel: "Waiting terminals",
  keybindingAction: "agent.focusNextWaiting",
  contentId: "waiting-container-popover",
  useTerminals: useWaitingTerminals,
};

interface WaitingContainerProps {
  compact?: boolean;
}

export function WaitingContainer({ compact = false }: WaitingContainerProps) {
  return <StatusContainer config={waitingConfig} compact={compact} />;
}
