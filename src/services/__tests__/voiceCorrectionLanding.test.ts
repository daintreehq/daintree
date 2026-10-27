import { beforeEach, describe, expect, it } from "vitest";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import {
  rebaseCorrectionBaseline,
  recordCorrectionLanded,
  takeLandedCorrection,
} from "../voiceCorrectionLanding";

const correction = {
  from: 7,
  rawText: "hello there",
  correctedText: "Hello, there.",
  baseline: { raw: "hello there", corrected: "Hello, there." },
};
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
    recordCorrectionLanded("term-1", "p1", {
      from: 0,
      rawText: "same",
      correctedText: "same",
      baseline: null,
    });
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

  it("leaves the baseline alone for a correction that never set one", () => {
    useVoiceRecordingStore.getState().setSessionCorrectedText("term-1", correction.correctedText);
    rebaseCorrectionBaseline("term-1", { ...correction, baseline: null }, "raw");
    expect(baseline()).toBe(correction.correctedText);
  });

  it("moves a chunk's passages inside the baseline its session wrote at stop (#14772)", () => {
    const voice = useVoiceRecordingStore.getState();
    voice.beginSession({ panelId: "term-1" }, "session-1");
    voice.setSessionCorrectedText("term-1", "Hello, there. and the rest");
    const chunk = { baseline: { ...correction.baseline, partOf: "session-1" } };

    rebaseCorrectionBaseline("term-1", chunk, "raw");
    expect(baseline()).toBe("hello there and the rest");
    rebaseCorrectionBaseline("term-1", chunk, "corrected");
    expect(baseline()).toBe("Hello, there. and the rest");

    // Not another session's, and not where the words read twice.
    rebaseCorrectionBaseline("term-1", { baseline: { ...chunk.baseline, partOf: "other" } }, "raw");
    expect(baseline()).toBe("Hello, there. and the rest");
    voice.setSessionCorrectedText("term-1", "Hello, there. Hello, there.");
    rebaseCorrectionBaseline("term-1", chunk, "raw");
    expect(baseline()).toBe("Hello, there. Hello, there.");
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
