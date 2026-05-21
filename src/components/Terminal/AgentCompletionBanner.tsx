import { FileEdit, MessageSquare, Forward } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";

export interface AgentCompletionBannerProps {
  /**
   * Number of changed files in the worktree. Drives the artifact-first copy
   * ("3 files changed, review when ready"). When omitted or zero, falls back
   * to a generic phrasing so the banner stays sensible if the count isn't
   * available yet.
   */
  fileCount?: number;
  onReview: () => void;
  onDismiss: () => void;
  /**
   * Relay the completion into the active assistant session. Omitted (button
   * hidden) when no assistant terminal exists or it's mid-stream — a missing
   * guard would inject text into a working agent.
   */
  onSendToAssistant?: () => void;
  /** Open the send-to-agent palette pre-populated with the agent's output. */
  onSendToAgent?: () => void;
  className?: string;
}

function formatBannerCopy(fileCount: number | undefined): string {
  if (fileCount == null || fileCount <= 0) {
    return "Files changed, review when ready";
  }
  const noun = fileCount === 1 ? "file" : "files";
  return `${fileCount} ${noun} changed, review when ready`;
}

export function AgentCompletionBanner({
  fileCount,
  onReview,
  onDismiss,
  onSendToAssistant,
  onSendToAgent,
  className,
}: AgentCompletionBannerProps) {
  const actions: BannerAction[] = [
    {
      id: "review",
      label: "Review",
      variant: "primary",
      onClick: onReview,
    },
  ];

  if (onSendToAssistant) {
    actions.push({
      id: "send-to-assistant",
      label: "Send to assistant",
      icon: MessageSquare,
      variant: "dismiss",
      onClick: onSendToAssistant,
    });
  }

  if (onSendToAgent) {
    actions.push({
      id: "send-to-agent",
      label: "Send to agent",
      icon: Forward,
      variant: "dismiss",
      iconOnly: true,
      ariaLabel: "Send to agent",
      title: "Send to another agent…",
      onClick: onSendToAgent,
    });
  }

  return (
    <InlineStatusBanner
      icon={FileEdit}
      title={formatBannerCopy(fileCount)}
      severity="neutral"
      role="status"
      className={className ? `border-t border-divider ${className}` : "border-t border-divider"}
      actions={actions}
      onClose={onDismiss}
    />
  );
}
