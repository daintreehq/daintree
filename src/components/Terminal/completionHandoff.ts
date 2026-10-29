import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { openSendToAgentPaletteWithText } from "@/hooks/useSendToAgentPalette";
import { paneHandoffHeading, type AgentHandoffContent } from "@/services/agentHandoff/agentDraft";
import { draftAssistantContext } from "@/services/agentHandoff/assistantDraft";
import { selectActiveSlot, useHelpPanelStore } from "@/store/helpPanelStore";

const COMPLETION_CAPTURE_CHARS = 20000;

/**
 * What a completion hand-off carries: the tail of the buffer, headed so the
 * receiving draft says where it came from. It is the scrollback rather than an
 * extracted answer, which is why it lands in a draft the user reads first.
 */
export function captureCompletionHandoff(terminalId: string): AgentHandoffContent | null {
  const text = peekTerminalService()?.captureBufferText(terminalId, COMPLETION_CAPTURE_CHARS) ?? "";
  return text.trim() ? { text, ...paneHandoffHeading(terminalId, "Terminal output") } : null;
}

/** The completion banner's "Send to assistant": draft this pane's output into the Assistant. */
export function sendCompletionToAssistant(terminalId: string): void {
  if (selectActiveSlot(useHelpPanelStore.getState()).terminalId === terminalId) return;
  const content = captureCompletionHandoff(terminalId);
  if (content) draftAssistantContext(content);
}

/** The completion banner's "Send to agent": pick another pane to hand this pane's output to. */
export function sendCompletionToAgent(terminalId: string): void {
  const content = captureCompletionHandoff(terminalId);
  if (content) openSendToAgentPaletteWithText(content, terminalId);
}
