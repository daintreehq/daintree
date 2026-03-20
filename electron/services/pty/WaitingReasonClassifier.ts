import type { WaitingReason } from "../../../shared/types/agent.js";
import { stripAnsi } from "./AgentPatternDetector.js";

const APPROVAL_PATTERNS: RegExp[] = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\(Y\/n\)/,
  /\(y\/N\)/,
  /\bapprove\b/i,
  /\ballow\b/i,
  /\baccept\b/i,
  /\bdeny\b/i,
  /\breject\b/i,
  /waiting for approval/i,
  /do you want to (proceed|allow|continue)/i,
  /bypass permissions/i,
  /confirmation required/i,
];

const QUESTION_SUPPRESS_PATTERNS: RegExp[] = [
  /^usage:/i,
  /^options:/i,
  /^\s*--/,
  /\berror:/i,
  /\bexception:/i,
  /\bfailed\b/i,
];

const QUESTION_START_WORDS = /^\s*(what|where|which|why|how|should|would|do|is|are|can|could)\b/i;

export function classifyWaitingReason(lines: string[], isPromptDetected: boolean): WaitingReason {
  const strippedLines = lines.map((l) => stripAnsi(l));
  const lastLines = strippedLines.filter((l) => l.trim().length > 0).slice(-5);

  // Priority 1: Check for approval patterns in last lines
  for (const line of lastLines) {
    for (const pattern of APPROVAL_PATTERNS) {
      if (pattern.test(line)) {
        return "approval";
      }
    }
  }

  // Priority 2: If prompt was detected by PromptDetector, it's a standard prompt
  if (isPromptDetected) {
    return "prompt";
  }

  // Priority 3: Check for question patterns in last 3 lines
  const questionCandidates = lastLines.slice(-3);
  const hasSuppression = strippedLines.some((line) =>
    QUESTION_SUPPRESS_PATTERNS.some((p) => p.test(line))
  );

  if (!hasSuppression) {
    for (const line of questionCandidates) {
      if (line.trim().endsWith("?")) {
        return "question";
      }
      if (QUESTION_START_WORDS.test(line) && line.trim().length < 200) {
        return "question";
      }
    }
  }

  // Default: if we're going idle, a prompt is the safest assumption
  return "prompt";
}
