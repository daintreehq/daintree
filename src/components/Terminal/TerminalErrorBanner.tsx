import React from "react";
import { AlertTriangle, RotateCcw, FolderEdit, Trash2 } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";
import type { TerminalRestartError } from "@/types";

export interface TerminalErrorBannerProps {
  terminalId: string;
  error: TerminalRestartError;
  onUpdateCwd: (id: string) => void;
  onRetry: (id: string) => void;
  onTrash: (id: string) => void;
  className?: string;
}

function TerminalErrorBannerComponent({
  terminalId,
  error,
  onUpdateCwd,
  onRetry,
  onTrash,
  className,
}: TerminalErrorBannerProps) {
  const isCwdError = error.code === "ENOENT" && error.context?.failedCwd;

  const actions: BannerAction[] = [];
  if (error.recoverable && isCwdError) {
    actions.push({
      id: "update-cwd",
      label: "Change directory",
      icon: FolderEdit,
      variant: "accent",
      onClick: () => onUpdateCwd(terminalId),
      title: "Change working directory",
      ariaLabel: "Update working directory",
    });
  }
  actions.push(
    {
      id: "retry",
      label: "Retry",
      icon: RotateCcw,
      variant: "primary",
      onClick: () => onRetry(terminalId),
      title: "Retry restart",
      ariaLabel: "Retry restart",
    },
    {
      id: "trash",
      label: "Trash",
      icon: Trash2,
      variant: "danger",
      onClick: () => onTrash(terminalId),
      title: "Move to trash",
      ariaLabel: "Move to trash",
    }
  );

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title="Terminal restart failed"
      description={error.message}
      contextLine={error.context?.failedCwd && `Directory: ${error.context.failedCwd}`}
      severity="error"
      actions={actions}
      className={className}
    />
  );
}

export const TerminalErrorBanner = React.memo(TerminalErrorBannerComponent);
