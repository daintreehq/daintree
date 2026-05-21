import { useErrorTerminals } from "@/hooks/useTerminalSelectors";
import { STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import { StatusContainer, type StatusContainerConfig } from "./StatusContainer";

const errorsConfig: StatusContainerConfig = {
  icon: STATE_ICONS.exited,
  iconColor: "text-status-error",
  badgeColor: "bg-status-error",
  badgeTextColor: "text-daintree-bg",
  headerLabel: "Errored agents",
  buttonLabel: "Errors",
  statusAriaLabel: "Exited with error",
  contentAriaLabel: "Errored terminals",
  contentId: "errors-container-popover",
};

interface ErrorsContainerProps {
  compact?: boolean;
}

export function ErrorsContainer({ compact = false }: ErrorsContainerProps) {
  const terminals = useErrorTerminals();
  return <StatusContainer config={errorsConfig} terminals={terminals} compact={compact} />;
}
