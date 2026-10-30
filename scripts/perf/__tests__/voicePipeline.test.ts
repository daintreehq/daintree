import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodePcm16Wav,
  REPLAY_CLIPS,
  REPLAY_SAMPLE_RATE,
  type ReplayClip,
} from "../../../e2e/helpers/voiceReplayFixtures";
import { VOICE_CORRECTION_VERDICTS } from "../../../shared/types/voiceSessionSummary";
import {
  parseVoice,
  readRecording,
  speechPhrases,
  withRecordedVoice,
} from "../lib/voicePipelineAudio";
import {
  brokenWords,
  checkIntent,
  formWords,
  literalTerm,
  parsePipelineArm,
  renderStopPreviewTable,
  scorePipelineSession,
  shownAtStop,
  stopPreview,
  summarisePipeline,
  summariseStopPreview,
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
    expect(withRecordedVoice(voices, "/recordings")).toEqual([
      ...voices,
      { id: "recorded", engine: "recorded", name: "" },
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
    const [short, long, unrecorded] = REPLAY_CLIPS;
    // Speech from `from` to `to` seconds; the silence a speaker leaves either side stays in.
    const record = (clip: ReplayClip, seconds: number, from: number, to: number) => {
      const samples = new Int16Array(seconds * REPLAY_SAMPLE_RATE);
      samples.fill(8_000, from * REPLAY_SAMPLE_RATE, to * REPLAY_SAMPLE_RATE);
      writeFileSync(
        path.join(dir, `${clip.id}.wav`),
        encodePcm16Wav({ sampleRate: REPLAY_SAMPLE_RATE, samples })
      );
    };
    record(short!, 1, 0.25, 0.5);
    record(long!, 3, 0.5, 2);

    expect(readRecording(short!, dir)).toEqual({
      clip: short,
      wavPath: path.join(dir, `${short!.id}.wav`),
      source: "recorded",
      audioMs: 1_000,
      longestUtteranceMs: 250,
    });
    expect(readRecording(long!, dir)).toMatchObject({ audioMs: 3_000, longestUtteranceMs: 1_500 });
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

describe("stopPreview", () => {
  // Stop at 3 s; "Run the tests." landed before it, and the open item "b" drains after it.
  const preview = (
    previews: PipelineEvent[],
    final: string,
    extra: Partial<PipelineSession> = {}
  ) =>
    stopPreview(
      session({
        stopMs: 3_000,
        events: [complete(1_000, "Run the tests.", "a"), ...previews, complete(3_900, final, "b")],
        ...extra,
      })
    );
  const fate = (...args: Parameters<typeof preview>) => preview(...args).fate;

  it("matches when the text held at the stop is the text the final commits", () => {
    expect(fate([delta(2_900, "Then commit.", "b")], "Then commit.")).toBe("match");
    expect(fate([delta(2_900, "Then commit.", "b")], "Then commit it.")).toBe("mismatch");
    expect(fate([delta(2_900, "then commit", "b")], "Then commit.")).toBe("mismatch");
    // A closing word the preview hadn't caught yet is a miss.
    expect(fate([delta(2_900, "Then", "b")], "Then commit.")).toBe("mismatch");
    // So is a final with no preview of it at the stop.
    expect(fate([], "Then commit.")).toBe("mismatch");
    // An event timed at the stop is before it.
    expect(fate([delta(3_000, "Then commit.", "b")], "Then commit.")).toBe("match");
  });

  it("reads only the latest preview of the open item, and none it retracted", () => {
    expect(
      fate([delta(2_000, "Then come", "b"), delta(2_900, "Then commit.", "b")], "Then commit.")
    ).toBe("match");
    expect(fate([delta(2_000, "Then commit.", "b"), delta(2_900, "", "b")], "Then commit.")).toBe(
      "mismatch"
    );
    // A preview arriving after the stop is no help to a cleanup started at it.
    expect(fate([delta(3_100, "Then commit.", "b")], "Then commit.")).toBe("mismatch");
    // A late delta for an item already completed doesn't reopen it.
    expect(
      stopPreview(
        session({
          stopMs: 3_000,
          events: [complete(1_000, "Run the tests.", "a"), delta(1_200, "Run the test", "a")],
        })
      ).fate
    ).toBe("settled");
  });

  it("compares what production lands: each piece trimmed, its hesitations gone", () => {
    expect(fate([delta(2_900, "  Um, then commit. ", "b")], "Then commit.")).toBe("match");
    expect(fate([delta(2_900, "Then commit.", "b")], "Uh, then commit.")).toBe("match");
  });

  it("calls a dictation settled when nothing was pending at the stop", () => {
    const events = [
      delta(800, "Run the", "a"),
      complete(1_000, "Run the tests.", "a"),
      // Retracted before the stop, and the end marker after it carries no words.
      delta(2_000, "then", "b"),
      delta(2_500, "", "b"),
      { at: 3_600, type: "complete", itemId: null, text: "", endOfSpeech: true, incomplete: false },
    ] satisfies PipelineEvent[];
    expect(stopPreview(session({ stopMs: 3_000, events })).fate).toBe("settled");
    // The same retraction followed by words after the stop waited for them.
    expect(
      stopPreview(
        session({ stopMs: 3_000, events: [...events, complete(3_900, "Then commit.", "c")] })
      ).fate
    ).toBe("mismatch");
    // A preview at the stop that the final retired with no words waited, and missed.
    expect(fate([delta(2_900, "Then", "b")], "")).toBe("mismatch");
  });

  it("never counts a final that didn't come, or a session that broke, as evidence", () => {
    // Settled from its preview, so preview and final agree by construction.
    expect(
      stopPreview(
        session({
          stopMs: 3_000,
          events: [
            delta(2_900, "Then commit.", "b"),
            { ...complete(3_900, "Then commit.", "b"), incomplete: true } as PipelineEvent,
          ],
        })
      )
    ).toMatchObject({ fate: "invalid", equal: true });
    expect(fate([delta(2_900, "Then commit.", "b")], "Then commit.", { reconnects: 1 })).toBe(
      "invalid"
    );
    expect(stopPreview(session({ stopMs: 3_000, events: [] })).fate).toBe("invalid");
    const broken: Partial<PipelineSession>[] = [
      { startError: "socket refused" },
      { droppedConnect: 1 },
      {
        events: [
          complete(1_000, "Run the tests.", "a"),
          { at: 2_000, type: "error", code: "timeout", severity: "recoverable" },
          delta(2_900, "Then commit.", "b"),
          complete(3_900, "Then commit.", "b"),
        ],
      },
    ];
    for (const extra of broken) {
      expect(fate([delta(2_900, "Then commit.", "b")], "Then commit.", extra)).toBe("invalid");
    }
  });

  it("excludes a final production rewrites once it lands, whatever the preview held", () => {
    const sent = preview([delta(2_900, "Then commit, send it.", "b")], "Then commit, send it.");
    expect(sent).toEqual({ fate: "excluded", equal: true, command: true, file: false });
    expect(fate([delta(2_900, "Then commit new line", "b")], "Then commit new line")).toBe(
      "excluded"
    );
    // Excluded when the preview missed too, so a rewrite never reads as an ordinary miss.
    expect(preview([delta(2_900, "Then commit, send", "b")], "Then commit, send it.")).toEqual({
      fate: "excluded",
      equal: false,
      command: true,
      file: false,
    });
    const named = "Check the add file voice pipeline score.";
    expect(preview([delta(2_900, named, "b")], named)).toMatchObject({
      fate: "excluded",
      file: true,
    });
    expect(preview([delta(2_900, "Check the add", "b")], named)).toMatchObject({
      fate: "excluded",
      equal: false,
      file: true,
    });
    // Main reads each completion for a file command alone, so none spans two.
    expect(
      stopPreview(
        session({
          stopMs: 3_000,
          events: [
            complete(1_000, "Please add", "a"),
            delta(2_900, "file indexing.", "b"),
            complete(3_900, "file indexing.", "b"),
          ],
        })
      )
    ).toMatchObject({ fate: "match", file: false });
    // A "send it" that belongs to its sentence is no command.
    const told = "Review it before you send it.";
    expect(fate([delta(2_900, told, "b")], told)).toBe("match");
    // Nor is one in words that landed before the stop, which production read then.
    expect(
      stopPreview(
        session({
          stopMs: 3_000,
          events: [
            complete(1_000, "Fix the test, send it.", "a"),
            delta(2_900, "Then commit.", "b"),
            complete(3_900, "Then commit.", "b"),
          ],
        })
      )
    ).toMatchObject({ fate: "match", command: false });
  });

  it("excludes a send only when nothing heard after it let it go as words", () => {
    const drained = (first: string, after: PipelineEvent[]) =>
      stopPreview(
        session({
          stopMs: 3_000,
          events: [delta(2_900, first, "b"), complete(3_400, first, "b"), ...after],
        })
      );
    expect(drained("Fix it, send it.", [])).toMatchObject({ fate: "excluded", command: true });
    const thenTests = complete(3_900, "Then add tests.", "c");
    expect(
      stopPreview(
        session({
          stopMs: 3_000,
          events: [
            delta(2_900, "Fix it, send it. Then add tests.", "b"),
            complete(3_400, "Fix it, send it.", "b"),
            thenTests,
          ],
        })
      )
    ).toMatchObject({ fate: "match", command: false });
    // A preview alone lets it go, as does a completion of nothing but a hesitation.
    expect(
      drained("Fix it, send it.", [delta(3_600, "And", "c"), complete(3_900, "", "c")])
    ).toMatchObject({ fate: "match", command: false });
    expect(drained("Fix it, send it.", [complete(3_900, "Um", "c")])).toMatchObject({
      fate: "match",
      command: false,
    });
    // Let go as words, it keeps a break command before it as words too.
    expect(
      stopPreview(
        session({
          stopMs: 3_000,
          events: [
            delta(2_900, "Fix it new line send it. Then add tests.", "b"),
            complete(3_400, "Fix it new line send it.", "b"),
            thenTests,
          ],
        })
      )
    ).toMatchObject({ fate: "match", command: false });
  });
});

describe("summariseStopPreview and renderStopPreviewTable", () => {
  const scored = (voice: string, stopTailMs: number, fate: string, drainEndMs: number) => {
    const final = fate === "excluded" ? "Commit, send it." : "Commit it.";
    const shown = fate === "mismatch" ? "Commit" : final;
    const events =
      fate === "settled"
        ? [complete(2_500, final, "a")]
        : [delta(2_900, shown, "a"), complete(drainEndMs - 200, final, "a")];
    return scorePipelineSession(
      session({
        voice,
        stopTailMs,
        stopMs: 3_000,
        drainEndMs,
        events,
        raw: final,
        reconnects: fate === "invalid" ? 1 : 0,
      }),
      "Commit it.",
      [],
      "gpt-6.1-terra"
    );
  };
  const rows = [
    scored("say", 0, "match", 4_000),
    scored("say", 0, "mismatch", 4_200),
    scored("say", 0, "invalid", 4_400),
    scored("say", 700, "settled", 3_300),
    scored("gemini:Kore", 700, "excluded", 3_900),
    scored("gemini:Kore", 700, "match", 4_100),
  ];

  it("shares matches over the valid dictations that waited, an excluded one a miss", () => {
    expect(rows.map((row) => row.stopPreview.fate)).toEqual([
      "match",
      "mismatch",
      "invalid",
      "settled",
      "excluded",
      "match",
    ]);
    const summary = summariseStopPreview(rows);
    expect(summary).toMatchObject({
      sessions: 6,
      invalid: 1,
      waited: 4,
      match: 2,
      command: 1,
      file: 0,
      exactShare: 0.5,
    });
    // Neither the settled dictation's drain nor the broken one's is a wait.
    expect(summary.stopToDrainMs).toEqual({ p50: 1_000, p95: 1_200, n: 4 });
    expect(summary.stopToFinalMs).toEqual({ p50: 800, p95: 1_000, n: 4 });
    expect(summary.matchStopToDrainMs).toEqual({ p50: 1_000, p95: 1_100, n: 2 });
    expect(summariseStopPreview(rows.slice(3, 4)).exactShare).toBeNull();
  });

  it("counts a file named, and times a wait whose last words came before the stop as none", () => {
    const retired = scorePipelineSession(
      session({
        stopMs: 3_000,
        drainEndMs: 3_500,
        events: [
          complete(1_000, "Commit it.", "a"),
          delta(2_900, "And", "b"),
          complete(3_400, "", "b"),
        ],
        raw: "Commit it.",
      }),
      "Commit it.",
      [],
      "gpt-6.1-terra"
    );
    const named = scorePipelineSession(
      session({
        stopMs: 3_000,
        drainEndMs: 4_000,
        events: [
          delta(2_900, "Add file the score.", "a"),
          complete(3_800, "Add file the score.", "a"),
        ],
        raw: "Add file the score.",
      }),
      "Commit it.",
      [],
      "gpt-6.1-terra"
    );
    expect([retired.stopPreview.fate, named.stopPreview.fate]).toEqual(["mismatch", "excluded"]);
    const summary = summariseStopPreview([retired, named]);
    expect(summary).toMatchObject({ waited: 2, match: 0, command: 0, file: 1, exactShare: 0 });
    expect(summary.stopToFinalMs).toEqual({ p50: 0, p95: 800, n: 2 });
  });

  it("rows each stop tail by voice, then every voice, then every stop", () => {
    const table = renderStopPreviewTable(rows, "prod").split("\n");
    const cells = (tail: string, voice: string) =>
      table
        .find((line) => line.startsWith(`| ${tail} | ${voice} |`))
        ?.split("|")
        .slice(3, -1)
        .map((cell) => cell.trim());
    expect(cells("0 ms", "say")).toEqual([
      "3",
      "1",
      "2",
      "1",
      "0",
      "0",
      "50.0%",
      "800 / 1000",
      "1000 / 1200",
      "1000 / 1000",
    ]);
    expect(cells("0 ms", "gemini:Kore")).toBeUndefined();
    expect(cells("700 ms", "all")?.slice(0, 7)).toEqual(["3", "0", "2", "1", "1", "0", "50.0%"]);
    expect(cells("all", "all")?.slice(0, 7)).toEqual(["6", "1", "4", "2", "1", "0", "50.0%"]);
    // Tails in order whatever order the dictations ran in; voices as they first appear.
    const order = renderStopPreviewTable([...rows].reverse(), "prod")
      .split("\n")
      .slice(2)
      .map((line) =>
        line
          .split("|")
          .slice(1, 3)
          .map((cell) => cell.trim())
      );
    expect(order).toEqual([
      ["0 ms", "say"],
      ["0 ms", "all"],
      ["700 ms", "gemini:Kore"],
      ["700 ms", "say"],
      ["700 ms", "all"],
      ["all", "all"],
    ]);
  });

  it("compares arms only over the dictations each of them completed", () => {
    const kept = (arm: string, clip: string) =>
      scorePipelineSession(
        session({
          arm,
          clip,
          stopMs: 3_000,
          events: [delta(2_900, "Commit it.", "a"), complete(3_300, "Commit it.", "a")],
          raw: "Commit it.",
        }),
        "Commit it.",
        [],
        "gpt-6.1-terra"
      );
    const all = [kept("a", "one"), kept("a", "two"), kept("b", "one")];
    const total = (arm: string, arms: string[]) =>
      renderStopPreviewTable(all, arm, arms)
        .split("\n")
        .find((line) => line.startsWith("| all | all |"))
        ?.split("|")[3]
        ?.trim();
    expect(total("a", ["a", "b"])).toBe("1");
    expect(total("b", ["a", "b"])).toBe("1");
    expect(total("a", ["a"])).toBe("2");
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

  // #14901: a turned-down reply streamed in only as a tentative rewrite, then went.
  it("times the first clean only for a cleanup that landed", () => {
    const firstClean = (verdict: string, firstTextAt: number | null = 4_000) =>
      scorePipelineSession(
        session({
          raw: "fix the bug",
          stopMs: 3_000,
          cleanup: {
            sentAt: 3_400,
            firstTextAt,
            doneAt: 4_600,
            verdict,
            text: "Fix the bug.",
            failed: false,
            speculation: "none",
            requests: 1,
            usage: [],
          },
        }),
        "Fix the bug.",
        [],
        "gpt-6.1-terra"
      ).stopToFirstCleanMs;
    expect(firstClean("replaced")).toBe(1_000);
    // A prefetch's words can stream before the stop; they show no earlier than it.
    expect(firstClean("replaced", 2_500)).toBe(0);
    expect(firstClean("replaced", null)).toBeNull();
    for (const verdict of VOICE_CORRECTION_VERDICTS.filter((v) => v !== "replaced")) {
      expect(firstClean(verdict), verdict).toBeNull();
    }
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
                verdict: text === raw ? "unchanged" : "replaced",
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

  it("scores what landed as written, and how often cleanup changed it", () => {
    const [before, after] = summarisePipeline(
      [
        scored("before", "Run npm test dash-watch.", "Run npm test dash-watch."),
        scored("after", "Run npm test dash-watch.", "Run npm test --watch."),
      ],
      ["before", "after"]
    );
    expect(before).toMatchObject({ finalFormExactRate: 0, finalLiteralTermRecall: 0 });
    expect(before!.verdicts).toEqual({ unchanged: 1 });
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

describe("checkIntent", () => {
  const question = ["question"];
  const quote = ["quote"];

  it("holds a question to a question and a statement to a statement", () => {
    const asked = "Is it cached? Find out.";
    expect(checkIntent(asked, "Is it cached? Find out.", question).question).toBe(true);
    expect(checkIntent(asked, "Is it cached. Find out.", question).question).toBe(false);
    // The instruction after the question doesn't become one.
    expect(checkIntent(asked, "Is it cached, find out?", question).question).toBe(false);
    const told = "I'm wondering whether it's cached.";
    expect(checkIntent(told, told, question).question).toBe(true);
    expect(checkIntent(told, "I'm wondering whether it's cached?", question).question).toBe(false);
    // A question mark that moved, or a first question turned into a statement, is caught.
    const two = "Why does it fail? Find out. Fix it.";
    expect(checkIntent(two, "Why does it fail. Find out? Fix it.", question).question).toBe(false);
    const pair = "How many a day? And what a month?";
    expect(checkIntent(pair, "How many a day. And what a month?", question).question).toBe(false);
    // Two questions joined into one is still asking both.
    expect(checkIntent(pair, "How many a day, and what a month?", question).question).toBe(true);
  });

  it("holds quoted words to the reference's quotes, straight or curly", () => {
    const reference = 'Make it say "Save and close" instead of "Done".';
    expect(
      checkIntent(
        reference,
        "Make it say \u201cSave and close\u201d instead of \u201cDone\u201d.",
        quote
      ).quotes
    ).toBe(true);
    expect(
      checkIntent(reference, "Make it say save and close instead of done.", quote).quotes
    ).toBe(false);
    expect(
      checkIntent(reference, 'Make it say "Save and close" instead of done.', quote).quotes
    ).toBe(false);
    // Swapped, or one span standing in for two, doesn't pass.
    expect(
      checkIntent(reference, 'Make it say "Done" instead of "Save and close".', quote).quotes
    ).toBe(false);
    // Reported speech stays unquoted.
    const reported = "It told me the tests pass.";
    expect(checkIntent(reported, reported, quote).quotes).toBe(true);
    expect(checkIntent(reported, 'It told me "the tests pass".', quote).quotes).toBe(false);
  });

  it("checks nothing a clip doesn't test", () => {
    expect(checkIntent("Commit it.", "Commit it?", [])).toEqual({ question: null, quotes: null });
  });
});
