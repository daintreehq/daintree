import { RotateCcw, SendHorizontal } from "lucide-react";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { actionService } from "@/services/ActionService";

export interface TerminalSubmitStatusBannerProps {
  terminalId: string;
  /** Only the two escalated states reach this banner; `slow` stays an ambient
   *  header pill and never renders here. */
  status: "stalled" | "failed";
  isRestarting?: boolean;
  className?: string;
}

const BANNER_COPY = {
  stalled: {
    title: "Prompt send stalled",
    description:
      "Daintree is still waiting for this prompt to finish sending. Later prompts stay queued so they can't merge into it.",
  },
  failed: {
    title: "Prompt send failed",
    description:
      "The terminal couldn't finish sending this prompt. Restart it before trying again so a partial prompt doesn't merge with the next one.",
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
 *
 * Restart goes through `ActionService` rather than the store primitive the
 * sibling error banners call. Those fire on a dead or failed terminal, where
 * there is nothing running to lose; this one fires while a submit is in
 * flight, which is exactly the running-agent case `terminal.restart`'s
 * `danger: "confirm"` gate exists to catch (D1, docs/architecture/
 * destructive-action-safeguards.md).
 */
export function TerminalSubmitStatusBanner({
  terminalId,
  status,
  isRestarting = false,
  className,
}: TerminalSubmitStatusBannerProps) {
  const copy = BANNER_COPY[status];

  return (
    <InlineStatusBanner
      icon={SendHorizontal}
      title={copy.title}
      description={copy.description}
      severity="error"
      action={{
        id: "restart",
        label: "Restart terminal",
        icon: RotateCcw,
        variant: "primary",
        onClick: () => {
          void actionService.dispatch("terminal.restart", { terminalId }, { source: "user" });
        },
        ariaLabel: "Restart terminal",
        loading: isRestarting,
      }}
      className={className}
    />
  );
}
