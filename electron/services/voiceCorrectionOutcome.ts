import type { VoiceCorrectionVerdict } from "../../shared/types/voiceSessionSummary.js";

/**
 * What the model proposed for a passage, read from a reply that parsed: its
 * action, its text with leading hesitations stripped (the raw text, trimmed,
 * for `no_change`), and its confidence. Transcript content, so never logged.
 */
export interface VoiceCorrectionProposal {
  action: "no_change" | "replace";
  correctedText: string;
  confidence: "low" | "medium" | "high";
}

export interface VoiceCorrectionOutcome {
  action: "no_change" | "replace";
  /** The text the passage becomes: the cleanup, or the raw text exactly. */
  confirmedText: string;
  verdict: VoiceCorrectionVerdict;
}

/**
 * Decides what a proposal becomes: the cleanup exactly as the model wrote it,
 * commands, confidence and all. Pure, so the cleanup benchmark lands the
 * replies it recorded exactly as the service would have.
 */
export function correctionOutcome(
  rawText: string,
  proposal: VoiceCorrectionProposal
): VoiceCorrectionOutcome {
  const candidate = proposal.correctedText.trim();
  const confirmedText = proposal.action === "replace" && candidate ? candidate : rawText;
  const action = confirmedText === rawText ? "no_change" : "replace";
  return { action, confirmedText, verdict: action === "replace" ? "replaced" : "unchanged" };
}
