import { useWaitingTerminals } from "@/hooks/useTerminalSelectors";
import { usePluginAttentionWaitingRows } from "@/hooks/usePluginPanelAttentionRows";
import { compareWaitingAttention } from "@shared/utils/waitingReasonDisplay";
import { STATE_COLORS, STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import { AGENT_BUCKET_LABEL } from "@/lib/agentStateVocabulary";
import { AgentStatusContainer, type AgentStatusConfig } from "./AgentStatusContainer";

// The bucket the sidebar's quick-state bar and Pilot call Attention: an agent
// stopped on an error is in it as well as one asking a question, so "waiting
// for input" claimed more than the tray knows.
const WAITING_CONFIG: AgentStatusConfig = {
  kind: "waiting",
  label: AGENT_BUCKET_LABEL.attention,
  Icon: STATE_ICONS.waiting,
  iconClassName: STATE_COLORS.waiting,
  tooltip: "Agents needing attention",
  popoverLabel: "Agents needing attention",
  heading: "Needs attention",
  showReasons: true,
  rowAction: "kill",
  // Triage order: approvals first, then error-blocked, then questions, then
  // plain prompts; longest-waiting first within each.
  compare: compareWaitingAttention,
};

interface WaitingContainerProps {
  compact?: boolean;
}

export function WaitingContainer({ compact = false }: WaitingContainerProps) {
  const terminals = useWaitingTerminals();
  const pluginRows = usePluginAttentionWaitingRows();
  return (
    <AgentStatusContainer
      terminals={terminals}
      pluginRows={pluginRows}
      config={WAITING_CONFIG}
      compact={compact}
    />
  );
}
