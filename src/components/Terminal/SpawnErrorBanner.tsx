import React from "react";
import { AlertTriangle, RotateCcw, FolderEdit, Trash2 } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";
import type { SpawnError } from "@/types";

export interface SpawnErrorBannerProps {
  terminalId: string;
  error: SpawnError;
  cwd?: string;
  onUpdateCwd: (id: string) => void;
  onRetry: (id: string) => void;
  onTrash: (id: string) => void;
  className?: string;
}

function getErrorTitle(code: SpawnError["code"]): string {
  switch (code) {
    case "ENOENT":
      return "Shell or Command Not Found";
    case "EACCES":
      return "Permission Denied";
    case "ENOTDIR":
      return "Invalid Working Directory";
    case "EIO":
      return "PTY Allocation Failed";
    case "DISCONNECTED":
      return "Terminal Disconnected";
    default:
      return "Failed to Start Terminal";
  }
}

function getErrorDescription(error: SpawnError, cwd?: string): string {
  switch (error.code) {
    case "ENOENT":
      if (error.path) {
        return `Could not find: ${error.path}`;
      }
      return error.message;
    case "EACCES":
      return `You don't have permission to execute: ${error.path || "the shell"}`;
    case "ENOTDIR":
      return `The working directory is not valid: ${cwd || "(unknown)"}`;
    case "EIO":
      return "Failed to allocate a pseudo-terminal. The system may be running low on resources.";
    case "DISCONNECTED":
      return "The terminal process is no longer running. Click Retry to start a new session.";
    default:
      return error.message;
  }
}

function SpawnErrorBannerComponent({
  terminalId,
  error,
  cwd,
  onUpdateCwd,
  onRetry,
  onTrash,
  className,
}: SpawnErrorBannerProps) {
  const isCwdError = error.code === "ENOTDIR";

  const actions: BannerAction[] = [];
  if (isCwdError) {
    actions.push({
      id: "update-cwd",
      label: "Update Directory",
      icon: FolderEdit,
      variant: "accent",
      onClick: () => onUpdateCwd(terminalId),
      title: "Update Working Directory",
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
      title: "Retry",
      ariaLabel: "Retry starting terminal",
    },
    {
      id: "trash",
      label: "Trash",
      icon: Trash2,
      variant: "danger",
      onClick: () => onTrash(terminalId),
      title: "Move to Trash",
      ariaLabel: "Move to trash",
    }
  );

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={getErrorTitle(error.code)}
      description={getErrorDescription(error, cwd)}
      contextLine={cwd && `Directory: ${cwd}`}
      severity="error"
      actions={actions}
      className={className}
    />
  );
}

export const SpawnErrorBanner = React.memo(SpawnErrorBannerComponent);
