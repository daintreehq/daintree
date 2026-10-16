import type { PtyPanelData } from "@shared/types/panel";
import { useUnreadTerminals } from "@/hooks/useTerminalSelectors";
import { SESSION_COLORS, SESSION_ICONS } from "@/components/Worktree/terminalStateConfig";
import { AgentStatusContainer, type AgentStatusConfig } from "./AgentStatusContainer";

/**
 * Longest-unread first. No reason ranking: every row is a hand-back, and one
 * Canopy read as not asking still carries its raw `question` reason.
 */
function compareUnread(a: PtyPanelData, b: PtyPanelData): number {
  const aSince = a.lastStateChange ?? Number.POSITIVE_INFINITY;
  const bSince = b.lastStateChange ?? Number.POSITIVE_INFINITY;
  if (aSince !== bSince) return aSince - bSince;
  return a.id.localeCompare(b.id);
}

const UNREAD_CONFIG: AgentStatusConfig = {
  kind: "unread",
  label: "Unread",
  Icon: SESSION_ICONS.unread,
  iconClassName: SESSION_COLORS.unread,
  tooltip: "Unread hand-backs",
  popoverLabel: "Unread panels",
  heading: "Unread hand-backs",
  showReasons: false,
  compare: compareUnread,
};

interface UnreadContainerProps {
  compact?: boolean;
}

/**
 * Agents that handed their turn back and haven't been read. Drains on its own:
 * a hand-back reads as seen once its pane has been in front of the user.
 */
export function UnreadContainer({ compact = false }: UnreadContainerProps) {
  const terminals = useUnreadTerminals();
  return <AgentStatusContainer terminals={terminals} config={UNREAD_CONFIG} compact={compact} />;
}
