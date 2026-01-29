/**
 * Assistant service utilities
 *
 * This module provides the system prompt and related utilities for
 * Canopy's app-wide assistant.
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
