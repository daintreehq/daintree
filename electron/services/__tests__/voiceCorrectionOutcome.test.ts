import { describe, expect, it } from "vitest";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import { getBuiltinSlashCommands } from "../../../shared/types/slashCommands.js";
import {
  buildVoiceCommandVocabulary,
  EMPTY_VOICE_COMMAND_VOCABULARY,
} from "../../../shared/utils/voiceAgentCommands.js";
import { correctionOutcome, type VoiceCorrectionProposal } from "../voiceCorrectionOutcome.js";

const checks = { vocabulary: EMPTY_VOICE_COMMAND_VOCABULARY, startsPrompt: true };

function replace(
  correctedText: string,
  confidence: VoiceCorrectionProposal["confidence"] = "high"
): VoiceCorrectionProposal {
  return { action: "replace", correctedText, confidence };
}

describe("correctionOutcome", () => {
  it("keeps the raw text exactly for no_change or an empty reply, whatever the confidence", () => {
    const raw = "  commit and push ";
    const unchanged = { action: "no_change", confirmedText: raw, verdict: "unchanged" };
    expect(
      correctionOutcome(raw, { action: "no_change", correctedText: "x", confidence: "low" }, checks)
    ).toEqual(unchanged);
    expect(correctionOutcome(raw, replace("   ", "low"), checks)).toEqual(unchanged);
  });

  it("reads a reply that hands the raw text back as no change", () => {
    expect(correctionOutcome("commit and push", replace(" commit and push "), checks)).toEqual({
      action: "no_change",
      confirmedText: "commit and push",
      verdict: "unchanged",
    });
  });

  it("lands a cleanup that keeps the meaning, trimmed", () => {
    expect(
      correctionOutcome(
        "um wire up the racked component",
        replace(" Wire up the React component. "),
        checks
      )
    ).toEqual({
      action: "replace",
      confirmedText: "Wire up the React component.",
      verdict: "replaced",
    });
  });

  it("lands a cleanup of rambling speech however much it takes out, a repeated negation included", () => {
    // A dictation that once lost its whole cleanup to a word-count guard.
    const raw =
      "So this is a test of, like what the whole system is. Even kind of, you know. Capable of. So, yeah, you just. Yeah, I mean, I'm, I'm not quite Yeah, I'm not quite sure what I'm actually saying here, but I want you to just Yeah, just go ahead.";
    const cleaned =
      "This is a test of what the whole system is capable of. I'm not quite sure what I'm saying here, but go ahead.";
    expect(correctionOutcome(raw, replace(cleaned), checks)).toEqual({
      action: "replace",
      confirmedText: cleaned,
      verdict: "replaced",
    });
  });

  it("refuses a cleanup the model itself marked low-confidence", () => {
    expect(
      correctionOutcome("the promise rejects when it times out", replace("Done.", "low"), checks)
    ).toMatchObject({
      action: "no_change",
      confirmedText: "the promise rejects when it times out",
      verdict: "rejected_low_confidence",
      rejected: { reason: "low_confidence", candidate: "Done." },
    });
  });

  it("checks a command the cleanup wrote before its confidence", () => {
    expect(
      correctionOutcome(
        "can you review the auth module",
        replace("/nonexistent the auth module", "low"),
        checks
      )
    ).toMatchObject({ verdict: "rejected_command", rejected: { reason: "unknown_command" } });
  });

  it("measures a command written for its spoken request as that command", () => {
    const vocabulary = buildVoiceCommandVocabulary(
      getBuiltinSlashCommands("claude"),
      getAgentConfig("claude")!.completionSources!
    );
    expect(
      correctionOutcome("can you please run the review skill on auth", replace("/review on auth"), {
        vocabulary,
        startsPrompt: true,
      })
    ).toMatchObject({ action: "replace", confirmedText: "/review on auth" });
  });
});
