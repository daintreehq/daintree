import { XCircle, RotateCcw, FolderEdit, Trash2, Settings2 } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";
import { BannerOverflowMenu } from "./BannerOverflowMenu";
import { sanitizeErrorText } from "@/utils/errorText";
import { actionService } from "@/services/ActionService";
import { SPAWN_ERROR_BANNER_COPY } from "./spawnErrorBannerCopy";
import { DiagnosticCopyButton } from "./DiagnosticCopyButton";
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
  const copy = SPAWN_ERROR_BANNER_COPY[error.code];

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

  const hasDiagnostics = typeof error.errno === "number" || !!error.syscall || !!error.path;

  return (
    <InlineStatusBanner
      icon={XCircle}
      title={copy.title}
      description={copy.description(error, cwd)}
      contextLine={cwd ? `Directory: ${sanitizeErrorText(cwd)}` : undefined}
      severity="error"
      action={primaryAction}
      descriptionExtras={
        hasDiagnostics ? (
          <DiagnosticCopyButton
            diagnostics={{
              errno: error.errno,
              syscall: error.syscall,
              path: error.path,
            }}
          />
        ) : undefined
      }
      trailingSlot={
        <BannerOverflowMenu actions={overflowActions} ariaLabel="More recovery options" />
      }
      className={className}
    />
  );
}
