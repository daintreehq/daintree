import { XCircle, RotateCcw, FolderEdit, Trash2, Copy } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";
import { BannerOverflowMenu } from "./BannerOverflowMenu";
import { sanitizeErrorText, boundedErrorText } from "@/utils/errorText";
import type { TerminalRestartError } from "@/types";

export interface TerminalErrorBannerProps {
  terminalId: string;
  error: TerminalRestartError;
  onUpdateCwd: (id: string) => void;
  onRetry: (id: string) => void;
  onTrash: (id: string) => void;
  isRestarting?: boolean;
  className?: string;
}

export function TerminalErrorBanner({
  terminalId,
  error,
  onUpdateCwd,
  onRetry,
  onTrash,
  isRestarting = false,
  className,
}: TerminalErrorBannerProps) {
  const isCwdError = error.code === "ENOENT" && !!error.context?.failedCwd;
  const canChangeDir = error.recoverable && isCwdError;

  const retryAction: BannerAction = {
    id: "retry",
    label: "Retry",
    icon: RotateCcw,
    variant: "primary",
    onClick: () => onRetry(terminalId),
    title: "Retry restart",
    ariaLabel: "Retry restart",
    loading: isRestarting,
  };
  const changeDirAction: BannerAction = {
    id: "update-cwd",
    label: "Change directory",
    icon: FolderEdit,
    variant: "primary",
    onClick: () => onUpdateCwd(terminalId),
    title: "Change working directory",
    disabled: isRestarting,
  };
  const trashAction: BannerAction = {
    id: "trash",
    label: "Remove terminal",
    icon: Trash2,
    variant: "danger",
    onClick: () => onTrash(terminalId),
    title: "Move to trash",
    disabled: isRestarting,
  };

  // The description is capped at 200 characters, so the menu is where the
  // whole message can still be had.
  const fullMessage = sanitizeErrorText(error.message);
  const copyErrorAction: BannerAction = {
    id: "copy-error",
    label: "Copy error",
    icon: Copy,
    variant: "dismiss",
    onClick: () => {
      void navigator.clipboard?.writeText(fullMessage).catch(() => undefined);
    },
  };

  // Single contextual action: change directory is the specific fix for a
  // missing-cwd restart failure, otherwise retry. The rest move into the
  // overflow menu to honour the one-action rule.
  const primaryAction = canChangeDir ? changeDirAction : retryAction;
  const overflowActions: BannerAction[] = [
    ...(primaryAction.id === retryAction.id ? [] : [retryAction]),
    ...(fullMessage ? [copyErrorAction] : []),
    trashAction,
  ];

  return (
    <InlineStatusBanner
      icon={XCircle}
      title="Terminal restart failed"
      description={boundedErrorText(error.message)}
      contextLine={
        error.context?.failedCwd
          ? `Directory: ${sanitizeErrorText(error.context.failedCwd)}`
          : undefined
      }
      contextLineTruncate="middle"
      severity="error"
      action={primaryAction}
      trailingSlot={
        <BannerOverflowMenu actions={overflowActions} ariaLabel="More recovery options" />
      }
      className={className}
    />
  );
}
