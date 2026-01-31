import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import type { ActionContext } from "../../../shared/types/actions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FALLBACK_PROMPT =
  "You are Canopy's assistant. Help users control the IDE using available tools.";

function loadSystemPrompt(): string {
  const isDev = !app.isPackaged;

  let promptPath: string;
  if (isDev) {
    // Development: load from dist-electron copy (created by build script)
    // Note: __dirname points to the bundled main.js location (dist-electron/electron/),
    // not the original source directory, so we need the relative path from there.
    promptPath = path.join(__dirname, "services", "assistant", "systemPrompt.txt");
  } else {
    // Production: load from resources (via electron-builder extraResources)
    promptPath = path.join(process.resourcesPath, "systemPrompt.txt");
  }

  try {
    const content = fs.readFileSync(promptPath, "utf-8").trim();
    if (!content) {
      console.warn("[SystemPrompt] File is empty:", promptPath);
      return FALLBACK_PROMPT;
    }
    return content;
  } catch (error) {
    console.error("[SystemPrompt] Failed to load from file:", promptPath, error);
    return FALLBACK_PROMPT;
  }
}

export const SYSTEM_PROMPT = loadSystemPrompt();

/**
 * Template for constructing the context block in user messages
 * Only includes fields that are useful for agent decision-making
 */
/**
 * Sanitize context values to prevent breaking parseability
 * Removes newlines and escapes pipe characters
 */
function sanitizeContextValue(value: string): string {
  return value.replace(/\n/g, " ").replace(/\|/g, "\\|");
}

export function buildContextBlock(
  context: ActionContext & { activeListenerCount?: number }
): string {
  const lines: string[] = [];

  // Project context - show name or path if available
  if (context.projectName || context.projectPath) {
    const name = context.projectName ? sanitizeContextValue(context.projectName) : "";
    const path = context.projectPath ? sanitizeContextValue(context.projectPath) : "";
    if (name && path) {
      lines.push(`Current project: ${name} (${path})`);
    } else if (name) {
      lines.push(`Current project: ${name}`);
    } else {
      lines.push(`Current project: ${path}`);
    }
  } else if (context.projectId) {
    lines.push(`Current project: ${context.projectId}`);
  }

  // Active worktree context
  if (context.activeWorktreeName) {
    const parts = [sanitizeContextValue(context.activeWorktreeName)];
    if (context.activeWorktreeBranch) {
      parts.push(sanitizeContextValue(context.activeWorktreeBranch));
    }
    if (context.activeWorktreePath) {
      parts.push(sanitizeContextValue(context.activeWorktreePath));
    }
    // Tri-state: only use "main" when explicitly true
    const worktreeLabel = context.activeWorktreeIsMain === true ? "main" : "worktree";
    lines.push(`Active ${worktreeLabel}: ${parts.join(" | ")}`);
  } else if (context.activeWorktreeId) {
    lines.push(`Active worktree: ${context.activeWorktreeId}`);
  }

  // Focused worktree (if different from active)
  if (context.focusedWorktreeId && context.focusedWorktreeId !== context.activeWorktreeId) {
    lines.push(`Focused worktree: ${context.focusedWorktreeId}`);
  }

  // Focused terminal context
  if (context.focusedTerminalId) {
    const parts = [context.focusedTerminalId];
    if (context.focusedTerminalKind || context.focusedTerminalType) {
      const kind = context.focusedTerminalKind || context.focusedTerminalType || "";
      parts.push(sanitizeContextValue(kind));
    }
    if (context.focusedTerminalTitle) {
      // Sanitize and quote the title
      const sanitized = sanitizeContextValue(context.focusedTerminalTitle);
      parts.push(`"${sanitized.replace(/"/g, '\\"')}"`);
    }
    lines.push(`Focused terminal: ${parts.filter((p) => p).join(" | ")}`);
  }

  if (context.isTerminalPaletteOpen) {
    lines.push(`Terminal palette: open`);
  }
  if (context.isSettingsOpen) {
    lines.push(`Settings: open`);
  }
  if (context.activeListenerCount && context.activeListenerCount > 0) {
    lines.push(`Active listeners: ${context.activeListenerCount}`);
  }

  return lines.length > 0 ? `Context:\n${lines.join("\n")}` : "";
}

/**
 * Standard clarification question patterns that the UI can parse
 */
export const CLARIFICATION_PATTERNS = {
  WHICH: /^which\s+(\w+)\s+would\s+you\s+like/i,
  DO_YOU_WANT: /^do\s+you\s+want\s+to/i,
  SHOULD_I: /^should\s+i/i,
  WOULD_YOU_PREFER: /^would\s+you\s+prefer/i,
};

/**
 * Confirmation question patterns
 */
export const CONFIRMATION_PATTERNS = {
  PROCEED: /do\s+you\s+want\s+(?:me\s+)?to\s+proceed\??/i,
};

/**
 * Standard choices for bullet point parsing
 * Note: These are templates - create new instances when using matchAll
 * to avoid global regex lastIndex persistence issues
 */
export const CHOICE_PATTERNS = {
  BULLET: /(?:^|\n)\s*[-*•]\s*(.+?)(?=\n|$)/gm,
  NUMBERED: /(?:^|\n)\s*\d+[.)]\s*(.+?)(?=\n|$)/gm,
} as const;

/**
 * Get fresh regex instances for choice parsing to avoid lastIndex issues
 */
export function getChoicePatterns() {
  return {
    BULLET: /(?:^|\n)\s*[-*•]\s*(.+?)(?=\n|$)/gm,
    NUMBERED: /(?:^|\n)\s*\d+[.)]\s*(.+?)(?=\n|$)/gm,
  };
}

/**
 * Destructive action keywords that trigger confirmation requirements
 */
export const DESTRUCTIVE_KEYWORDS = [
  "delete",
  "remove",
  "kill",
  "close", // terminal.close moves to trash
  "clear",
  "reset",
  "trash",
  "force",
  "overwrite",
  "destroy",
  "wipe",
  "purge",
  "terminate",
  "stop",
];

/**
 * Check if an action description suggests a destructive operation
 */
export function isLikelyDestructive(text: string): boolean {
  const lower = text.toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((keyword) => lower.includes(keyword));
}
