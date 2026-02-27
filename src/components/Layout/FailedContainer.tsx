import { XCircle } from "lucide-react";
import { useFailedTerminals } from "@/hooks/useTerminalSelectors";
import { StatusContainer, type StatusContainerConfig } from "./StatusContainer";

const failedConfig: StatusContainerConfig = {
  icon: XCircle,
  iconColor: "text-red-400",
  badgeColor: "bg-red-400",
  badgeTextColor: "text-red-950",
  headerLabel: "Failed Sessions",
  buttonLabel: "Failed",
  statusAriaLabel: "Failed",
  contentAriaLabel: "Failed terminals",
  contentId: "failed-container-popover",
  useTerminals: useFailedTerminals,
};

interface FailedContainerProps {
  compact?: boolean;
}

export function FailedContainer({ compact = false }: FailedContainerProps) {
  return <StatusContainer config={failedConfig} compact={compact} />;
}
