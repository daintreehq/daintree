import { Clock, FileX2, History, RotateCcw } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { boundedErrorText } from "@/utils/errorText";
import type { TerminalScrollbackRestoreError } from "@/types";

export interface ScrollbackRestoreErrorBannerProps {
  terminalId: string;
  error: TerminalScrollbackRestoreError;
  onDismiss: (id: string) => void;
  onRestart: (id: string) => void;
  isRestarting?: boolean;
  className?: string;
}

function getErrorIcon(type: TerminalScrollbackRestoreError["type"]) {
  switch (type) {
    case "timeout":
      return Clock;
    case "parse":
      return FileX2;
    default:
      return History;
  }
}

function getErrorTitle(type: TerminalScrollbackRestoreError["type"]): string {
  switch (type) {
    case "timeout":
      return "Scrollback restore timed out";
    case "parse":
      return "Scrollback contents couldn't be replayed";
    default:
      return "Scrollback restore failed";
  }
}

function getErrorDescription(type: TerminalScrollbackRestoreError["type"], message: string): string {
  const detail = boundedErrorText(message);
  switch (type) {
    case "timeout":
      return `Replay didn't finish in time. The terminal still works, but its earlier output isn't visible. ${detail}`;
    case "parse":
      return `The saved buffer couldn't be parsed. The terminal still works, but its earlier output isn't visible. ${detail}`;
    default:
      return `The terminal still works, but its earlier output isn't visible. ${detail}`;
  }
}

export function ScrollbackRestoreErrorBanner({
  terminalId,
  error,
  onDismiss,
  onRestart,
  isRestarting = false,
  className,
}: ScrollbackRestoreErrorBannerProps) {
  return (
    <InlineStatusBanner
      icon={getErrorIcon(error.type)}
      title={getErrorTitle(error.type)}
      description={getErrorDescription(error.type, error.message)}
      severity="warning"
      actions={[
        {
          id: "reset",
          label: "Reset terminal",
          icon: RotateCcw,
          variant: "primary",
          onClick: () => onRestart(terminalId),
          title: "Restart the terminal",
          ariaLabel: "Reset terminal",
          loading: isRestarting,
        },
      ]}
      onClose={() => onDismiss(terminalId)}
      className={className}
    />
  );
}
