import { useWaitingTerminals } from "@/hooks/useTerminalSelectors";
import { compareWaitingAttention } from "@shared/utils/waitingReasonDisplay";
import { STATE_COLORS, STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import { AgentStatusContainer, type AgentStatusConfig } from "./AgentStatusContainer";

const WAITING_CONFIG: AgentStatusConfig = {
  kind: "waiting",
  label: "Waiting",
  Icon: STATE_ICONS.waiting,
  iconClassName: STATE_COLORS.waiting,
  tooltip: "Agents waiting",
  popoverLabel: "Waiting panels",
  heading: "Waiting for input",
  showReasons: true,
  // Triage order: approvals first, then error-blocked, then questions, then
  // plain prompts; longest-waiting first within each.
  compare: compareWaitingAttention,
};

interface WaitingContainerProps {
  compact?: boolean;
}

export function WaitingContainer({ compact = false }: WaitingContainerProps) {
  const terminals = useWaitingTerminals();
  return <AgentStatusContainer terminals={terminals} config={WAITING_CONFIG} compact={compact} />;
}
