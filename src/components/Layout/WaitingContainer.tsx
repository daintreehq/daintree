import { AlertCircle } from "lucide-react";
import { useWaitingTerminals } from "@/hooks/useTerminalSelectors";
import { StatusContainer, type StatusContainerConfig } from "./StatusContainer";

const waitingConfig: StatusContainerConfig = {
  icon: AlertCircle,
  iconColor: "text-status-warning",
  badgeColor: "bg-status-warning",
  badgeTextColor: "text-canopy-bg",
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
