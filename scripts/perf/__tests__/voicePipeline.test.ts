import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodePcm16Wav,
  REPLAY_CLIPS,
  REPLAY_SAMPLE_RATE,
} from "../../../e2e/helpers/voiceReplayFixtures";
import {
  parseVoice,
  readRecording,
  speechPhrases,
  withRecordedVoice,
} from "../lib/voicePipelineAudio";
import {
  brokenWords,
  formWords,
  literalTerm,
  parsePipelineArm,
  scorePipelineSession,
  shownAtStop,
  summarisePipeline,
  type PipelineEvent,
  type PipelineSession,
} from "../lib/voicePipelineScore";

function session(overrides: Partial<PipelineSession> = {}): PipelineSession {
  return {
    clip: "c",
    voice: "say",
    arm: "prod",
    pass: 1,
    startError: null,
    events: [],
    audioMs: 3_000,
    stopTailMs: 0,
    stopMs: 3_000,
    drainEndMs: 3_400,
    raw: "",
    cleanup: null,
    reconnects: 0,
    droppedConnect: 0,
    ...overrides,
  };
}

const complete = (at: number, text: string, itemId: string): PipelineEvent => ({
  at,
  type: "complete",
  itemId,
  text,
  endOfSpeech: true,
  incomplete: false,
});
const delta = (at: number, text: string, itemId: string): PipelineEvent => ({
  at,
  type: "delta",
  itemId,
  text,
});

describe("parsePipelineArm", () => {
  it("reads each token into the run it changes", () => {
    expect(parsePipelineArm("prod")).toEqual({
      id: "prod",
      tuning: {},
      speculate: false,
      cleanup: true,
    });
    expect(parsePipelineArm("ep150+spec")).toEqual({
      id: "ep150+spec",
      tuning: { endpointingMs: 150 },
      speculate: true,
      cleanup: true,
    });
    expect(parsePipelineArm("raw").cleanup).toBe(false);
    expect(parsePipelineArm("nofmt").tuning).toEqual({ format: false });
  });

  it("refuses a token it doesn't know, and speculation without cleanup", () => {
    expect(() => parsePipelineArm("prod+fast")).toThrow(/unknown arm token/);
    expect(() => parsePipelineArm("raw+spec")).toThrow(/no cleanup/);
  });
});

describe("speechPhrases", () => {
  it("splits a clip at its silences, each phrase keeping the pause after it", () => {
    expect(speechPhrases("Looks good. [[slnc 900]] Open a pull request.")).toEqual([
      { text: "Looks good.", pauseMs: 900 },
      { text: "Open a pull request.", pauseMs: 0 },
    ]);
  });

  it("adds back-to-back silences together", () => {
    expect(speechPhrases("One. [[slnc 500]] [[slnc 400]] Two.")).toEqual([
      { text: "One.", pauseMs: 900 },
      { text: "Two.", pauseMs: 0 },
    ]);
  });
});

describe("parseVoice", () => {
  it("names the engine and its voice", () => {
    expect(parseVoice("gemini:Puck")).toEqual({
      id: "gemini:Puck",
      engine: "gemini",
      name: "Puck",
    });
    expect(parseVoice("say")).toEqual({ id: "say", engine: "say", name: "" });
    expect(parseVoice("say:Samantha")).toEqual({
      id: "say:Samantha",
      engine: "say",
      name: "Samantha",
    });
    expect(parseVoice("minimax:English_Wiselady")).toMatchObject({
      engine: "minimax",
      name: "English_Wiselady",
    });
    expect(() => parseVoice("gemini")).toThrow(/unknown voice/);
    expect(parseVoice("recorded")).toEqual({ id: "recorded", engine: "recorded", name: "" });
    expect(() => parseVoice("recorded:greg")).toThrow(/unknown voice/);
  });
});

describe("withRecordedVoice", () => {
  const voices = ["say", "gemini:Puck"].map(parseVoice);

  it("adds the recordings as a voice of their own whenever there is a directory of them", () => {
    expect(withRecordedVoice(voices, "/recordings").map((voice) => voice.id)).toEqual([
      "say",
      "gemini:Puck",
      "recorded",
    ]);
    expect(withRecordedVoice(voices, undefined)).toEqual(voices);
  });

  it("names the recorded voice once, and refuses it with no directory", () => {
    const named = [...voices, parseVoice("recorded")];
    expect(withRecordedVoice(named, "/recordings")).toEqual(named);
    expect(withRecordedVoice([parseVoice("recorded")], "/recordings")).toHaveLength(1);
    expect(() => withRecordedVoice(named, undefined)).toThrow(/VOICE_REPLAY_RECORDINGS_DIR/);
  });
});

describe("readRecording", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("plays a clip's recording as it was recorded, and skips a clip with none", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "voice-pipeline-recordings-"));
    dirs.push(dir);
    const [recorded, unrecorded] = REPLAY_CLIPS;
    // Leading and trailing silence a speaker leaves stays in.
    const samples = new Int16Array(REPLAY_SAMPLE_RATE);
    samples.fill(8_000, REPLAY_SAMPLE_RATE / 4, REPLAY_SAMPLE_RATE / 2);
    writeFileSync(
      path.join(dir, `${recorded!.id}.wav`),
      encodePcm16Wav({ sampleRate: REPLAY_SAMPLE_RATE, samples })
    );

    expect(readRecording(recorded!, dir)).toEqual({
      clip: recorded,
      wavPath: path.join(dir, `${recorded!.id}.wav`),
      source: "recorded",
      audioMs: 1_000,
      longestUtteranceMs: 250,
    });
    expect(readRecording(unrecorded!, dir)).toBeNull();
  });

  it("refuses a recording that isn't mono 16-bit PCM", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "voice-pipeline-recordings-"));
    dirs.push(dir);
    const clip = REPLAY_CLIPS[0]!;
    const wav = encodePcm16Wav({ sampleRate: REPLAY_SAMPLE_RATE, samples: new Int16Array(4) });
    wav.writeUInt16LE(2, 22);
    writeFileSync(path.join(dir, `${clip.id}.wav`), wav);
    expect(() => readRecording(clip, dir)).toThrow(/mono 16-bit PCM/);
  });
});

describe("formWords", () => {
  it("keeps what an agent reads: symbols, joins and an identifier's case", () => {
    expect(formWords("Run npm test --watch on useShallow.")).toEqual([
      "run",
      "npm",
      "test",
      "--watch",
      "on",
      "useShallow",
    ]);
    expect(formWords("dash-watch")).not.toEqual(formWords("--watch"));
    expect(formWords("use shallow")).not.toEqual(formWords("useShallow"));
  });

  it("forgives a sentence's capital and the punctuation around a word", () => {
    expect(formWords("Commit, and push.")).toEqual(formWords("commit and push"));
  });
});

describe("literalTerm", () => {
  it("finds a term only as written, never inside a longer word", () => {
    expect(literalTerm("--watch", "run npm test --watch now")).toBe(true);
    expect(literalTerm("--watch", "run npm test dash-watch now")).toBe(false);
    expect(literalTerm("xterm", "the xterms")).toBe(false);
    expect(literalTerm("useShallow", "wrap it in use shallow")).toBe(false);
    expect(literalTerm("useShallow", "wrap it in useShallow_extra")).toBe(false);
    expect(literalTerm("--watch", "run npm test ---watch")).toBe(false);
    expect(literalTerm("text-secondary", "the text-secondary-foo token")).toBe(false);
    expect(literalTerm("xterm", "an oldxterm build")).toBe(false);
  });

  it("matches a term's own symbols literally, and its case", () => {
    expect(literalTerm("package.json", "resolve package.json now")).toBe(true);
    expect(literalTerm("package.json", "resolve packageXjson now")).toBe(false);
    expect(literalTerm("useShallow", "wrap it in useshallow")).toBe(false);
  });
});

describe("brokenWords", () => {
  it("counts the words the raw transcript had right that the final text lost", () => {
    const reference = "checks the draft still holds every word";
    expect(brokenWords(reference, reference, "checks the draft still holds")).toBe(2);
    expect(brokenWords(reference, "checks the draft still holds every", reference)).toBe(0);
    // A word the raw text already had wrong isn't lost by staying wrong.
    expect(
      brokenWords(
        reference,
        "checks the graft still holds every word",
        "checks the graft still holds"
      )
    ).toBe(2);
  });
});

describe("shownAtStop", () => {
  it("counts the words completed and previewed when stop was pressed", () => {
    const shown = shownAtStop(
      session({
        stopMs: 2_000,
        raw: "run the tests then commit",
        events: [
          complete(1_000, "run the tests", "a"),
          delta(1_900, "then", "b"),
          complete(2_400, "then commit", "b"),
        ],
      })
    );
    expect(shown).toBeCloseTo(4 / 5);
  });

  it("doesn't count a preview its completion already replaced", () => {
    expect(
      shownAtStop(
        session({
          stopMs: 2_000,
          raw: "run the tests and then commit the change",
          events: [
            delta(900, "run the", "a"),
            complete(1_000, "run the tests", "a"),
            complete(2_500, "and then commit the change", "b"),
          ],
        })
      )
    ).toBeCloseTo(3 / 8);
  });
});

describe("scorePipelineSession", () => {
  it("scores a session against whichever accepted reference its text is closest to", () => {
    const references = ["First, read it. Second, fix it.", "1. Read it.\n2. Fix it."];
    const scored = scorePipelineSession(
      session({ raw: "1st, read it. 2nd, fix it.", cleanup: null }),
      references,
      [],
      "gpt-6.1-terra"
    );
    expect(scored.rawForm.edits).toBe(2);
    const listed = scorePipelineSession(
      session({ raw: "1. Read it. 2. Fix it.", cleanup: null }),
      references,
      [],
      "gpt-6.1-terra"
    );
    expect(listed.rawForm.exact).toBe(true);
    const spoken = scorePipelineSession(
      session({ raw: "First, read it. Second, fix it.", cleanup: null }),
      references,
      [],
      "gpt-6.1-terra"
    );
    expect(spoken.rawForm.exact).toBe(true);
  });

  it("never counts moving between two accepted forms as losing words", () => {
    const references = ["Swap the hex colour.", "Swap the hex color."];
    const scored = scorePipelineSession(
      session({
        raw: "Swap the hex colour.",
        cleanup: {
          sentAt: 3_400,
          firstTextAt: 4_000,
          doneAt: 4_600,
          verdict: "replaced",
          text: "Swap the hex color.",
          failed: false,
          speculation: "none",
          requests: 1,
          usage: [],
        },
      }),
      references,
      [],
      "gpt-6.1-terra"
    );
    expect(scored.brokenWords).toBe(0);
    expect(scored.finalForm.exact).toBe(true);
  });
});

describe("summarisePipeline", () => {
  const reference = "Run npm test --watch.";
  const scored = (arm: string, raw: string, text: string | null, clip = "c") =>
    scorePipelineSession(
      session({
        arm,
        clip,
        raw,
        cleanup:
          text === null
            ? null
            : {
                sentAt: 3_400,
                firstTextAt: 4_000,
                doneAt: 4_600,
                verdict: text === raw ? "rejected_low_confidence" : "replaced",
                text,
                failed: false,
                speculation: "none",
                requests: 1,
                usage: [],
              },
      }),
      reference,
      ["--watch"],
      "gpt-6.1-terra"
    );

  it("scores what landed as written, and how often a check turned cleanup away", () => {
    const [before, after] = summarisePipeline(
      [
        scored("before", "Run npm test dash-watch.", "Run npm test dash-watch."),
        scored("after", "Run npm test dash-watch.", "Run npm test --watch."),
      ],
      ["before", "after"]
    );
    expect(before).toMatchObject({ finalFormExactRate: 0, finalLiteralTermRecall: 0 });
    expect(before!.verdicts).toEqual({ rejected_low_confidence: 1 });
    expect(after).toMatchObject({ finalFormExactRate: 1, finalLiteralTermRecall: 1 });
    expect(after!.stopToSettledMs.p50).toBe(1_600);
  });

  it("compares arms only over the dictations each of them completed", () => {
    const [a, b] = summarisePipeline(
      [
        scored("a", reference, null, "one"),
        scored("a", reference, null, "two"),
        scored("b", reference, null, "one"),
      ],
      ["a", "b"]
    );
    expect(a!.sessions).toBe(1);
    expect(b!.sessions).toBe(1);
  });
});
