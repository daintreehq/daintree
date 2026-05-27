import { XCircle, RotateCcw, FolderEdit, Trash2, Settings2 } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";
import { BannerOverflowMenu } from "./BannerOverflowMenu";
import { sanitizeErrorText, boundedErrorText } from "@/utils/errorText";
import { actionService } from "@/services/ActionService";
import type { SpawnError } from "@/types";

const RESOURCE_LIMIT_CODES: ReadonlySet<SpawnError["code"]> = new Set([
  "EMFILE",
  "EAGAIN",
  "ENOMEM",
  "ENXIO",
]);

export interface SpawnErrorBannerProps {
  terminalId: string;
  error: SpawnError;
  cwd?: string;
  onUpdateCwd: (id: string) => void;
  onRetry: (id: string) => void;
  onTrash: (id: string) => void;
  isRestarting?: boolean;
  className?: string;
}

function getErrorTitle(code: SpawnError["code"]): string {
  switch (code) {
    case "ENOENT":
      return "Couldn't find shell or command";
    case "EACCES":
      return "Couldn't execute shell";
    case "ENOTDIR":
      return "Invalid working directory";
    case "EIO":
      return "Couldn't allocate terminal";
    case "EMFILE":
      return "File descriptor limit reached";
    case "EAGAIN":
      return "Process limit reached";
    case "ENOMEM":
      return "Out of memory";
    case "ENXIO":
      return "PTY pool exhausted";
    case "EBUSY":
      return "Terminal device busy";
    case "DISCONNECTED":
      return "Terminal disconnected";
    default:
      return "Couldn't start terminal";
  }
}

function getErrorDescription(error: SpawnError, cwd?: string): string {
  const safePath = error.path ? boundedErrorText(error.path) : "";
  const safeCwd = cwd ? boundedErrorText(cwd) : "";
  switch (error.code) {
    case "ENOENT":
      if (safePath) {
        return `Couldn't find: ${safePath}`;
      }
      return boundedErrorText(error.message);
    case "EACCES":
      return `Couldn't execute ${safePath || "the shell"} — check permissions`;
    case "ENOTDIR":
      return `The working directory isn't valid: ${safeCwd || "(unknown)"}`;
    case "EIO":
      return "Couldn't allocate a terminal session. The system may be running low on resources.";
    case "EMFILE":
      return "The per-process file descriptor limit was reached. Try closing some terminals to free up descriptors.";
    case "EAGAIN":
      return "The system process limit was hit (fork failed). Wait a moment and retry, or close some terminals.";
    case "ENOMEM":
      return "The system is out of memory. Try closing other applications to free up memory.";
    case "ENXIO":
      return "The pseudo-terminal pool is exhausted. Try closing some terminals and retrying.";
    case "EBUSY":
      return "The terminal device is busy. Retry or close the conflicting terminal.";
    case "DISCONNECTED":
      return "The terminal process is no longer running.";
    default:
      return boundedErrorText(error.message);
  }
}

export function SpawnErrorBanner({
  terminalId,
  error,
  cwd,
  onUpdateCwd,
  onRetry,
  onTrash,
  isRestarting = false,
  className,
}: SpawnErrorBannerProps) {
  const isCwdError = error.code === "ENOTDIR";
  const isResourceLimit = RESOURCE_LIMIT_CODES.has(error.code);

  const retryAction: BannerAction = {
    id: "retry",
    label: "Retry",
    icon: RotateCcw,
    variant: "primary",
    onClick: () => onRetry(terminalId),
    title: "Retry",
    ariaLabel: "Retry starting terminal",
    loading: isRestarting,
  };
  const changeDirAction: BannerAction = {
    id: "update-cwd",
    label: "Change directory",
    icon: FolderEdit,
    variant: "accent",
    onClick: () => onUpdateCwd(terminalId),
    title: "Change working directory",
    ariaLabel: "Update working directory",
    disabled: isRestarting,
  };
  const limitsAction: BannerAction = {
    id: "open-limits",
    label: "Terminal limits",
    icon: Settings2,
    variant: "accent",
    onClick: () => {
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "terminal", subtab: "performance", sectionId: "terminal-panel-limits" },
        { source: "user" }
      );
    },
    title: "Open terminal limits settings",
    ariaLabel: "Open terminal limits settings",
  };
  const trashAction: BannerAction = {
    id: "trash",
    label: "Remove terminal",
    icon: Trash2,
    variant: "danger",
    onClick: () => onTrash(terminalId),
    title: "Move to trash",
    ariaLabel: "Move to trash",
    disabled: isRestarting,
  };

  // Single contextual action: the most specific recovery for the error code.
  // Everything else moves into the overflow menu so the banner keeps to the
  // one-action rule (CLAUDE.md Title-Message-Action).
  const primaryAction = isCwdError ? changeDirAction : isResourceLimit ? limitsAction : retryAction;
  const overflowActions: BannerAction[] = [
    ...(primaryAction.id === retryAction.id ? [] : [retryAction]),
    trashAction,
  ];

  return (
    <InlineStatusBanner
      icon={XCircle}
      title={getErrorTitle(error.code)}
      description={getErrorDescription(error, cwd)}
      contextLine={cwd ? `Directory: ${sanitizeErrorText(cwd)}` : undefined}
      severity="error"
      action={primaryAction}
      trailingSlot={
        <BannerOverflowMenu actions={overflowActions} ariaLabel="More recovery options" />
      }
      className={className}
    />
  );
}
