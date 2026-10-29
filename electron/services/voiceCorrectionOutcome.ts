import type { VoiceCorrectionVerdict } from "../../shared/types/voiceSessionSummary.js";
import {
  checkVoiceCommandEdit,
  writeUnnamedCommandsAsSaid,
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
  /** The cleanup wrote commands the speaker never named, and they landed as the words said. */
  commandsAsSaid?: true;
}

export interface VoiceCorrectionChecks {
  vocabulary: VoiceCommandVocabulary;
  /** Nothing comes before the passage in the draft, so it may open with a command. */
  startsPrompt: boolean;
}

/**
 * Decides what a proposal becomes: the cleanup as the model wrote it, unless
 * it invents or rewrites an agent command the speaker didn't say, or the model
 * itself marked it low-confidence. A command written partway in where the
 * speaker only said its name goes back to those words, and the rest lands.
 * Pure, so the cleanup benchmark lands the replies it recorded exactly as the
 * service would have.
 */
export function correctionOutcome(
  rawText: string,
  proposal: VoiceCorrectionProposal,
  checks: VoiceCorrectionChecks
): VoiceCorrectionOutcome {
  let confirmedText = rawText;
  let commandsAsSaid = false;
  if (proposal.action === "replace" && proposal.correctedText.trim()) {
    let candidate = proposal.correctedText.trim();
    let commandRejection = checkVoiceCommandEdit(
      rawText,
      candidate,
      checks.vocabulary,
      checks.startsPrompt
    );
    if (commandRejection === "unprompted_command") {
      // One word too eagerly made a command shouldn't cost a long passage its cleanup.
      const asSaid = writeUnnamedCommandsAsSaid(
        rawText,
        candidate,
        checks.vocabulary,
        checks.startsPrompt
      );
      if (
        asSaid !== null &&
        checkVoiceCommandEdit(rawText, asSaid, checks.vocabulary, checks.startsPrompt) === null
      ) {
        candidate = asSaid;
        commandRejection = null;
        commandsAsSaid = true;
      }
    }
    const rejection: VoiceCorrectionRejectReason | null =
      commandRejection ?? (proposal.confidence === "low" ? "low_confidence" : null);
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
  return {
    action,
    confirmedText,
    verdict: action === "replace" ? "replaced" : "unchanged",
    ...(commandsAsSaid ? { commandsAsSaid: true as const } : {}),
  };
}
