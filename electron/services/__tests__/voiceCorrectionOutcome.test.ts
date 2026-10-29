import { describe, expect, it } from "vitest";
import { correctionOutcome, type VoiceCorrectionProposal } from "../voiceCorrectionOutcome.js";

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
      correctionOutcome(raw, { action: "no_change", correctedText: "x", confidence: "low" })
    ).toEqual(unchanged);
    expect(correctionOutcome(raw, replace("   ", "low"))).toEqual(unchanged);
  });

  it("reads a reply that hands the raw text back as no change", () => {
    expect(correctionOutcome("commit and push", replace(" commit and push "))).toEqual({
      action: "no_change",
      confirmedText: "commit and push",
      verdict: "unchanged",
    });
  });

  it("lands a cleanup that keeps the meaning, trimmed", () => {
    expect(
      correctionOutcome(
        "um wire up the racked component",
        replace(" Wire up the React component. ")
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
    expect(correctionOutcome(raw, replace(cleaned))).toEqual({
      action: "replace",
      confirmedText: cleaned,
      verdict: "replaced",
    });
  });

  it("lands a cleanup the model marked low-confidence", () => {
    expect(
      correctionOutcome(
        "wire up the racked component",
        replace("Wire up the React component.", "low")
      )
    ).toEqual({
      action: "replace",
      confirmedText: "Wire up the React component.",
      verdict: "replaced",
    });
  });

  it("lands a skill the cleanup moved to the front of the prompt, the lead-in dropped", () => {
    // Dictated 2026-10-29 and turned down whole while the command checks stood.
    expect(
      correctionOutcome(
        "Okay, go ahead and use the github create issue skill to create a new issue for this.",
        replace("/github-create-issue to create a new issue for this.")
      )
    ).toEqual({
      action: "replace",
      confirmedText: "/github-create-issue to create a new issue for this.",
      verdict: "replaced",
    });
  });

  it("lands a command the cleanup wrote in place, however it was named", () => {
    expect(
      correctionOutcome(
        "From there we should do a full design review workflow",
        replace("From there, we should do a full /design-review workflow.")
      )
    ).toMatchObject({
      action: "replace",
      confirmedText: "From there, we should do a full /design-review workflow.",
    });
  });
});
