import { beforeEach, describe, expect, it } from "vitest";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import {
  rebaseCorrectionBaseline,
  recordCorrectionLanded,
  takeLandedCorrection,
} from "../voiceCorrectionLanding";

const correction = { from: 7, rawText: "hello there", correctedText: "Hello, there." };
const draft = `Intro. ${correction.correctedText}`;

describe("landed corrections", () => {
  beforeEach(() => {
    takeLandedCorrection("term-1", "p1", "");
    useVoiceRecordingStore.setState({ panelBuffers: {} });
  });

  it("hands a correction to its panel's composer once", () => {
    recordCorrectionLanded("term-1", "p1", correction);

    expect(takeLandedCorrection("term-2", "p1", draft)).toBeNull();
    expect(takeLandedCorrection("term-1", "p1", draft)).toEqual(correction);
    expect(takeLandedCorrection("term-1", "p1", draft)).toBeNull();
  });

  it("drops a correction the draft no longer holds where it landed", () => {
    recordCorrectionLanded("term-1", "p1", correction);

    expect(takeLandedCorrection("term-1", "p1", `Intro! ${correction.correctedText}`)).toEqual(
      correction
    );
    recordCorrectionLanded("term-1", "p1", correction);
    expect(takeLandedCorrection("term-1", "p1", "Intro. Hello, there")).toBeNull();
    expect(takeLandedCorrection("term-1", "p1", draft)).toBeNull();
  });

  it("keeps a correction for its own draft, apart from an isolated composer's", () => {
    recordCorrectionLanded("term-1", "p1", correction);

    expect(takeLandedCorrection("term-1", "isolated-composer", draft)).toBeNull();
    expect(takeLandedCorrection("term-1", "p1", draft)).toEqual(correction);
  });

  it("records nothing for a correction that changed nothing", () => {
    recordCorrectionLanded("term-1", "p1", { from: 0, rawText: "same", correctedText: "same" });
    expect(takeLandedCorrection("term-1", "p1", "same")).toBeNull();
  });
});

describe("rebaseCorrectionBaseline", () => {
  const baseline = () =>
    useVoiceRecordingStore.getState().panelBuffers["term-1"]?.sessionCorrectedText;

  beforeEach(() => {
    useVoiceRecordingStore.setState({ panelBuffers: {} });
  });

  it("moves the learning baseline to whichever text the passage holds", () => {
    useVoiceRecordingStore.getState().setSessionCorrectedText("term-1", correction.correctedText);

    rebaseCorrectionBaseline("term-1", correction, "raw");
    expect(baseline()).toBe(correction.rawText);
    rebaseCorrectionBaseline("term-1", correction, "corrected");
    expect(baseline()).toBe(correction.correctedText);
  });

  it("leaves a newer session's baseline, and one a send consumed, alone", () => {
    useVoiceRecordingStore.getState().setSessionCorrectedText("term-1", "a later dictation");
    rebaseCorrectionBaseline("term-1", correction, "raw");
    expect(baseline()).toBe("a later dictation");

    useVoiceRecordingStore.getState().setSessionCorrectedText("term-1", null);
    rebaseCorrectionBaseline("term-1", correction, "raw");
    expect(baseline()).toBeNull();
  });
});
