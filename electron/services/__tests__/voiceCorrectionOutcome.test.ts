import { describe, expect, it } from "vitest";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import { getBuiltinSlashCommands } from "../../../shared/types/slashCommands.js";
import {
  buildVoiceCommandVocabulary,
  EMPTY_VOICE_COMMAND_VOCABULARY,
} from "../../../shared/utils/voiceAgentCommands.js";
import { CORRECTION_GUARD_LIMITS } from "../voiceCorrectionGuard.js";
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

  it("refuses a low-confidence cleanup before the guards see it", () => {
    // Over the edit budget too: confidence is the reason given.
    expect(
      correctionOutcome("the promise rejects when it times out", replace("Done.", "low"), checks)
    ).toMatchObject({
      action: "no_change",
      confirmedText: "the promise rejects when it times out",
      verdict: "rejected_low_confidence",
      rejected: { reason: "low_confidence", candidate: "Done." },
    });
  });

  it("refuses what the guard refuses, with its reason", () => {
    expect(
      correctionOutcome("don't delete the branch yet", replace("Delete the branch yet."), checks)
    ).toMatchObject({
      confirmedText: "don't delete the branch yet",
      verdict: "rejected_negation",
      rejected: { reason: "negation", candidate: "Delete the branch yet." },
    });
  });

  it("checks a command the cleanup wrote before confidence and the guards", () => {
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

  it("lands under whatever edit budget it's given", () => {
    const raw = "check the logs on the staging box and the traces and the metrics";
    const shorter = "Check the logs on the staging box.";
    expect(correctionOutcome(raw, replace(shorter), checks).rejected?.reason).toBe("edit_size");
    expect(
      correctionOutcome(raw, replace(shorter), {
        ...checks,
        limits: { ...CORRECTION_GUARD_LIMITS, removedRatio: 0.5 },
      }).confirmedText
    ).toBe(shorter);
  });
});
