/**
 * Assistant service utilities
 *
 * This module provides the system prompt, action tools, and related utilities
 * for Canopy's app-wide assistant.
 */

export {
  SYSTEM_PROMPT,
  buildContextBlock,
  CLARIFICATION_PATTERNS,
  CONFIRMATION_PATTERNS,
  CHOICE_PATTERNS,
  getChoicePatterns,
  DESTRUCTIVE_KEYWORDS,
  isLikelyDestructive,
} from "./systemPrompt.js";

export {
  createActionTools,
  createToolNameMap,
  sanitizeToolName,
  unsanitizeToolName,
  sanitizeSchema,
} from "./actionTools.js";

export { ListenerManager, listenerManager } from "./ListenerManager.js";

export { createListenerTools, type ListenerToolContext } from "./listenerTools.js";
