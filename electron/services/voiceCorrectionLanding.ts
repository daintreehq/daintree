import type { VoiceCorrectionVerdict } from "../../shared/types/voiceSessionSummary.js";
import {
  checkVoiceCommandEdit,
  voiceCommandBaseline,
  type VoiceCommandEditRejection,
  type VoiceCommandVocabulary,
} from "../../shared/utils/voiceAgentCommands.js";
import {
  CORRECTION_GUARD_LIMITS,
  validateCorrection,
  type CorrectionGuardLimits,
  type CorrectionRejectReason,
} from "./voiceCorrectionGuard.js";

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

export type VoiceCorrectionRejectReason =
  | CorrectionRejectReason
  | VoiceCommandEditRejection
  | "low_confidence";

export interface VoiceCorrectionLanding {
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
  limits?: CorrectionGuardLimits;
}

function rejectionVerdict(rejection: VoiceCorrectionRejectReason): VoiceCorrectionVerdict {
  switch (rejection) {
    case "edit_size":
      return "rejected_edit_size";
    case "negation":
      return "rejected_negation";
    case "number":
      return "rejected_number";
    case "protected_span":
      return "rejected_protected_span";
    case "low_confidence":
      return "rejected_low_confidence";
    default:
      return "rejected_command";
  }
}

/**
 * Decides what a proposal lands as. A command the cleanup wrote in place of
 * its spoken request is measured as that command, so "can you please run the
 * review skill on…" isn't over the edit budget for the words the command
 * replaced. Pure, so the cleanup benchmark can land the replies it recorded
 * under other edit budgets exactly as the service would have.
 */
export function landCorrection(
  rawText: string,
  proposal: VoiceCorrectionProposal,
  checks: VoiceCorrectionChecks
): VoiceCorrectionLanding {
  let confirmedText = rawText;
  if (proposal.action === "replace" && proposal.correctedText.trim()) {
    const candidate = proposal.correctedText.trim();
    const commandRejection = checkVoiceCommandEdit(
      rawText,
      candidate,
      checks.vocabulary,
      checks.startsPrompt
    );
    const baseline = commandRejection
      ? rawText
      : (voiceCommandBaseline(rawText, candidate, checks.vocabulary) ?? rawText);
    let rejection: VoiceCorrectionRejectReason | null = commandRejection;
    if (!rejection && proposal.confidence === "low") rejection = "low_confidence";
    if (!rejection) {
      const verdict = validateCorrection(
        baseline,
        candidate,
        checks.limits ?? CORRECTION_GUARD_LIMITS
      );
      if (!verdict.ok) rejection = verdict.reason;
    }
    if (rejection) {
      return {
        action: "no_change",
        confirmedText: rawText,
        verdict: rejectionVerdict(rejection),
        rejected: { reason: rejection, candidate },
      };
    }
    confirmedText = candidate;
  }
  const action = confirmedText === rawText ? "no_change" : "replace";
  return { action, confirmedText, verdict: action === "replace" ? "replaced" : "unchanged" };
}
