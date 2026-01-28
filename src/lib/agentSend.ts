import type { TerminalInstance } from "@/store";
import { isAgentTerminal } from "@/utils/terminalType";
import type { EditorView } from "@codemirror/view";

export interface SendToAgentResult {
  success: boolean;
  terminalId?: string;
  error?: string;
}

/**
 * Find the best target agent terminal for sending content.
 *
 * Priority order:
 * 1. Focused agent terminal (if in same worktree or no worktree)
 * 2. Most recent agent terminal in the same worktree (by createdAt)
 * 3. Any agent terminal (fallback)
 */
export function findTargetAgentTerminal(
  terminals: TerminalInstance[],
  focusedId: string | null,
  worktreeId: string | undefined,
  agentId?: string
): TerminalInstance | null {
  const agentTerminals = terminals.filter(
    (t) =>
      isAgentTerminal(t.kind ?? t.type, t.agentId) &&
      t.location !== "trash" &&
      (!agentId || t.agentId === agentId || t.type === agentId)
  );

  if (agentTerminals.length === 0) {
    return null;
  }

  // Filter by worktree if provided
  const worktreeAgents = worktreeId
    ? agentTerminals.filter((t) => t.worktreeId === worktreeId)
    : agentTerminals;

  const relevantAgents = worktreeAgents.length > 0 ? worktreeAgents : agentTerminals;

  // 1. Check if focused terminal is an agent
  if (focusedId) {
    const focused = relevantAgents.find((t) => t.id === focusedId);
    if (focused) return focused;
  }

  // 2. Use most recent agent in worktree (by createdAt timestamp)
  const byMostRecent = [...relevantAgents].sort((a, b) => {
    const aTime = a.createdAt ?? 0;
    const bTime = b.createdAt ?? 0;
    return bTime - aTime;
  });

  if (byMostRecent.length > 0) {
    return byMostRecent[0];
  }

  return null;
}

/**
 * Send content to an agent terminal.
 * Handles queuing if the agent is busy.
 */
export async function sendToAgent(
  terminalId: string,
  content: string,
  queueCommand: (
    terminalId: string,
    payload: string,
    description: string,
    origin?: "user" | "automation"
  ) => void
): Promise<SendToAgentResult> {
  if (!content.trim()) {
    return {
      success: false,
      error: "No content to send",
    };
  }

  try {
    // Preserve internal whitespace, only ensure trailing newline for submission
    // Remove only a single trailing newline if present, then add one back
    const normalized = content.replace(/\n$/, "");
    const payload = normalized + "\n";

    // Queue the command (will send immediately if agent is ready)
    queueCommand(terminalId, payload, "Note content", "automation");

    return {
      success: true,
      terminalId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send to agent",
    };
  }
}

/**
 * Get the selection from a CodeMirror EditorView, or full content if no selection.
 */
export function getEditorSelection(
  editorView: EditorView | null | undefined,
  fallbackContent: string
): string {
  if (!editorView) {
    return fallbackContent;
  }

  try {
    const { state } = editorView;
    const { selection } = state;

    // Check if there's a non-empty selection
    const hasSelection = selection.ranges.some((range) => !range.empty);

    if (hasSelection) {
      // Get selected text from all ranges (CodeMirror supports multiple selections)
      const selections = selection.ranges
        .filter((range) => !range.empty)
        .map((range) => state.sliceDoc(range.from, range.to));

      return selections.join("\n");
    }

    return fallbackContent;
  } catch (error) {
    console.error("Failed to extract selection:", error);
    return fallbackContent;
  }
}
