import type { FleetBand } from "@/lib/fleetAttention";
import { openInAssistant, type OpenInAssistantResult } from "@/services/assistantSubject";
import type { CanopyAssistantItem } from "./canopyAssistants";

/**
 * The band an assistant's glyph wears, from what was observed of it alone.
 *
 * Amber is for an ask Canopy read, and Canopy never reads an assistant (it
 * reads fleet runs, and assistants aren't any), so an approval or question
 * the patterns saw is at most unread. A confirmation is different: Daintree's
 * own dialog holds the call until the user answers it, which is no guess.
 */
export function assistantBand(item: CanopyAssistantItem): FleetBand {
  switch (item.ask) {
    case "error":
      return "blocked";
    case "confirm":
      return "needs-you";
    case "approval":
    case "question":
    case "handback":
      return "review";
    default:
      break;
  }
  if (item.agentState === "working" || item.agentState === "directing") return "running";
  if (item.agentState === "completed") return "done";
  return "idle";
}

export function canopyAssistantDomId(id: string): string {
  return `canopy-assistant-${encodeURIComponent(id)}`;
}

const OPEN_REFUSED: Record<Extract<OpenInAssistantResult, { ok: false }>["reason"], string> = {
  ended:
    "This assistant's session has ended. Start or resume one from its project's Assistant panel.",
  unsupported: "This global assistant opens from a window on the machine it runs on.",
  "not-attached":
    "This assistant runs without a window here. Open its project's Assistant panel to take it over.",
  "not-switched": "This assistant runs on another host, and this window couldn't move there.",
};

/**
 * Open the assistant's own lane in its project's Assistant panel. Nothing is
 * launched or resumed; a refusal is said in words, for the surface to show.
 */
export async function openAssistantItem(item: CanopyAssistantItem): Promise<string | null> {
  try {
    const result = await openInAssistant(item.subject);
    return result.ok ? null : OPEN_REFUSED[result.reason];
  } catch {
    return "Daintree couldn't open this assistant. Try again from its project's Assistant panel.";
  }
}
