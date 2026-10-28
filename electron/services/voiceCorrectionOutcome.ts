import type { VoiceCorrectionVerdict } from "../../shared/types/voiceSessionSummary.js";
import {
  checkVoiceCommandEdit,
  type VoiceCommandEditRejection,
  type VoiceCommandVocabulary,
} from "../../shared/utils/voiceAgentCommands.js";

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

export type VoiceCorrectionRejectReason = VoiceCommandEditRejection | "low_confidence";

export interface VoiceCorrectionOutcome {
  action: "no_change" | "replace";
  /** The text the passage becomes: the cleanup, or the raw text exactly. */
  confirmedText: string;
  verdict: VoiceCorrectionVerdict;
  /** The cleanup a check turned down, and which check. */
  rejected?: { reason: VoiceCorrectionRejectReason; candidate: string };
}

export interface VoiceCorrectionChecks {
  vocabulary: VoiceCommandVocabulary;
  /** Nothing comes before the passage in the draft, so it may open with a command. */
  startsPrompt: boolean;
}

/**
 * Decides what a proposal becomes: the cleanup as the model wrote it, unless
 * it invents or rewrites an agent command the speaker didn't say, or the model
 * itself marked it low-confidence. Pure, so the cleanup benchmark lands the
 * replies it recorded exactly as the service would have.
 */
export function correctionOutcome(
  rawText: string,
  proposal: VoiceCorrectionProposal,
  checks: VoiceCorrectionChecks
): VoiceCorrectionOutcome {
  let confirmedText = rawText;
  if (proposal.action === "replace" && proposal.correctedText.trim()) {
    const candidate = proposal.correctedText.trim();
    const rejection: VoiceCorrectionRejectReason | null =
      checkVoiceCommandEdit(rawText, candidate, checks.vocabulary, checks.startsPrompt) ??
      (proposal.confidence === "low" ? "low_confidence" : null);
    if (rejection) {
      return {
        action: "no_change",
        confirmedText: rawText,
        verdict: rejection === "low_confidence" ? "rejected_low_confidence" : "rejected_command",
        rejected: { reason: rejection, candidate },
      };
    }
    confirmedText = candidate;
  }
  const action = confirmedText === rawText ? "no_change" : "replace";
  return { action, confirmedText, verdict: action === "replace" ? "replaced" : "unchanged" };
}
