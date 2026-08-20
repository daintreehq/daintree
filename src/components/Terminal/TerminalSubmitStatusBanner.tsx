import { RotateCcw, SendHorizonal } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";

export interface TerminalSubmitStatusBannerProps {
  terminalId: string;
  /** Only the two escalated states reach this banner; `slow` stays an ambient
   *  header pill and never renders here. */
  status: "stalled" | "failed";
  onRestart: (id: string) => void;
  isRestarting?: boolean;
  className?: string;
}

const BANNER_COPY = {
  stalled: {
    title: "Prompt send stalled",
    description:
      "Daintree is still waiting for this prompt to finish sending. Later prompts stay queued so they can't merge into it.",
    icon: SendHorizonal,
  },
  failed: {
    title: "Prompt send failed",
    description:
      "The terminal couldn't finish sending this prompt. Restart it before trying again so a partial prompt doesn't merge with the next one.",
    icon: SendHorizonal,
  },
} as const;

/**
 * Tier-3 surface for a submit that stopped making progress (#11875).
 *
 * There is deliberately no "send again" or "press Enter" affordance. The
 * original submit still owns the composer and its Enter is still armed, so a
 * second send would submit the prompt twice. Restarting the terminal is the
 * only recovery that actually resolves the ambiguity, so it is the only action
 * offered.
 */
export function TerminalSubmitStatusBanner({
  terminalId,
  status,
  onRestart,
  isRestarting = false,
  className,
}: TerminalSubmitStatusBannerProps) {
  const copy = BANNER_COPY[status];

  return (
    <InlineStatusBanner
      icon={copy.icon}
      title={copy.title}
      description={copy.description}
      severity={status === "failed" ? "error" : "warning"}
      action={{
        id: "restart",
        label: "Restart terminal",
        icon: RotateCcw,
        variant: "primary",
        onClick: () => onRestart(terminalId),
        ariaLabel: "Restart terminal",
        loading: isRestarting,
      }}
      className={className}
    />
  );
}
