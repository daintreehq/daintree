import { Lock } from "lucide-react";
import {
  getTerminalInputBlockMessage,
  type TerminalInputBlock,
} from "@/services/terminal/inputGate";
import { InlineStatusBanner } from "./InlineStatusBanner";

/**
 * Why this pane isn't taking what the user types: the host link is down, or
 * another machine drives the project. Output keeps flowing, so this reports
 * what was observed, neutrally, rather than an error.
 */
export function TerminalInputBlockBanner({ block }: { block: TerminalInputBlock }) {
  return (
    <InlineStatusBanner
      icon={Lock}
      severity="neutral"
      layout="inline"
      title={getTerminalInputBlockMessage(block)}
      role="status"
      ariaLive="polite"
    />
  );
}
