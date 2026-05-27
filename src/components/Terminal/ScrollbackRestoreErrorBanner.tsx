import { Clock, FileX2, History, RotateCcw, type LucideIcon } from "lucide-react";
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

interface ScrollbackBannerConfig {
  title: string;
  icon: LucideIcon;
  description: (message: string) => string;
}

// The terminal itself is still operational — only the replayed buffer is
// missing — so the copy leads with that reassurance. The raw message is only
// useful for the generic "error" case, where the title doesn't already convey
// the cause; for "timeout" and "parse" the title is sufficient.
const SCROLLBACK_BANNER_CONFIG = {
  timeout: {
    title: "Scrollback restore timed out",
    icon: Clock,
    description: () =>
      "Replay didn't finish in time. The terminal still works — only its earlier output is missing.",
  },
  parse: {
    title: "Scrollback contents couldn't be replayed",
    icon: FileX2,
    description: () =>
      "The saved buffer couldn't be replayed. The terminal still works — only its earlier output is missing.",
  },
  error: {
    title: "Scrollback restore failed",
    icon: History,
    description: (message) =>
      `${boundedErrorText(message)} The terminal still works — only its earlier output is missing.`,
  },
} as const satisfies Record<TerminalScrollbackRestoreError["type"], ScrollbackBannerConfig>;

export function ScrollbackRestoreErrorBanner({
  terminalId,
  error,
  onDismiss,
  onRestart,
  isRestarting = false,
  className,
}: ScrollbackRestoreErrorBannerProps) {
  const config = SCROLLBACK_BANNER_CONFIG[error.type];
  return (
    <InlineStatusBanner
      icon={config.icon}
      title={config.title}
      description={config.description(error.message)}
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
