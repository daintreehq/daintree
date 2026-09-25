import { Clock, FileX2, History, RotateCcw, type LucideIcon } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { sanitizeErrorText } from "@/utils/errorText";
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
  /** Whether the raw message says anything the title doesn't. */
  showMessage: boolean;
}

// The terminal itself is still operational — only the replayed buffer is
// missing — so every variant leads with that reassurance, and the title alone
// says what went wrong. The raw message only earns a line for the generic
// "error" case, where the title can't name the cause; it goes in the mono
// detail line rather than the sentence, so the reassurance stays first.
const SCROLLBACK_BANNER_CONFIG = {
  timeout: { title: "Scrollback restore timed out", icon: Clock, showMessage: false },
  parse: { title: "Scrollback couldn't be replayed", icon: FileX2, showMessage: false },
  error: { title: "Scrollback restore failed", icon: History, showMessage: true },
} as const satisfies Record<TerminalScrollbackRestoreError["type"], ScrollbackBannerConfig>;

const SCROLLBACK_BANNER_DESCRIPTION =
  "The terminal still works, but its earlier output is missing.";

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
      description={SCROLLBACK_BANNER_DESCRIPTION}
      // Unbounded: the line is one CSS-clipped row whose tooltip holds the
      // whole message, so the cap that protects the description isn't needed.
      contextLine={
        (config.showMessage && sanitizeErrorText(error.message).replace(/\s+/g, " ").trim()) ||
        undefined
      }
      severity="warning"
      // Nothing is blocked — the terminal works — so this waits its turn
      // rather than interrupting whatever a screen reader is saying.
      role="status"
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
