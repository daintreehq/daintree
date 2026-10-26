import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DICTIONARY_KEYTERMS } from "../../../shared/config/voiceKeyterms";
import {
  allFixtureTerms,
  encodePcm16Wav,
  longestUtteranceMs,
  prepareClip,
  readPcm16Wav,
  REPLAY_CLIPS,
  REPLAY_SAMPLE_RATE,
  trimSilence,
  type Pcm16,
} from "../voiceReplayFixtures";
import { scoreClip } from "../voiceReplayScore";

const RATE = REPLAY_SAMPLE_RATE;

/** `ms` of tone at `amplitude` (0..1) or silence at 0. */
function segment(ms: number, amplitude: number): number[] {
  return Array.from({ length: Math.round((ms / 1000) * RATE) }, (_, i) =>
    Math.round(Math.sin((2 * Math.PI * 300 * i) / RATE) * amplitude * 32767)
  );
}

const pcm = (...parts: number[][]): Pcm16 => ({
  sampleRate: RATE,
  samples: Int16Array.from(parts.flat()),
});

describe("the fixture corpus", () => {
  it("has 15 to 20 clips with unique ids", () => {
    expect(REPLAY_CLIPS.length).toBeGreaterThanOrEqual(15);
    expect(REPLAY_CLIPS.length).toBeLessThanOrEqual(20);
    expect(new Set(REPLAY_CLIPS.map((clip) => clip.id)).size).toBe(REPLAY_CLIPS.length);
  });

  it("covers pauses, a long utterance, short prompts and dense vocabulary", () => {
    const tagged = (tag: string) => REPLAY_CLIPS.filter((clip) => clip.tags.includes(tag as never));
    expect(tagged("pause").length).toBeGreaterThanOrEqual(3);
    expect(tagged("long").length).toBeGreaterThanOrEqual(1);
    expect(tagged("short").length).toBeGreaterThanOrEqual(1);
    expect(tagged("vocab").length).toBeGreaterThanOrEqual(10);
    for (const clip of REPLAY_CLIPS) {
      // A tag is a claim about the audio, so it has to match what's said.
      expect(clip.tags.includes("pause"), clip.id).toBe(/\[\[slnc \d+\]\]/.test(clip.speech));
      if (clip.tags.includes("vocab")) expect(clip.terms.length, clip.id).toBeGreaterThan(0);
      // Over eight seconds of speech at any plausible rate, before a pause.
      if (clip.tags.includes("long")) {
        const firstUtterance = clip.speech.split(/\[\[slnc/)[0]!;
        expect(firstUtterance.split(/\s+/).length, clip.id).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it("scores a perfect transcript of every reference as perfect", () => {
    for (const clip of REPLAY_CLIPS) {
      const score = scoreClip(clip.reference, clip.reference, clip.terms);
      expect(score.referenceWords, clip.id).toBeGreaterThan(0);
      expect(score.wer, clip.id).toBe(0);
      expect(score.termsRecalled, clip.id).toBe(clip.terms.length);
    }
  });

  it("says each clip so that a faithful transcript of the speech scores perfectly", () => {
    // Spoken forms ("N P M", "dash dash watch") normalise to the written ones,
    // so a provider that hears every word loses nothing to the fixture itself.
    for (const clip of REPLAY_CLIPS) {
      const speech = clip.speech.replace(/\[\[slnc \d+\]\]/g, " ");
      const score = scoreClip(clip.reference, speech, clip.terms);
      expect(score.wer, clip.id).toBe(0);
      expect(score.missedTerms, clip.id).toEqual([]);
      expect([score.firstWordKept, score.lastWordKept], clip.id).toEqual([true, true]);
    }
  });

  it("collects every fixture term once, in the casing and order first seen", () => {
    const expected = [...new Set(REPLAY_CLIPS.flatMap((clip) => clip.terms))];
    expect(allFixtureTerms()).toEqual(expected);
    expect(
      allFixtureTerms([
        { id: "a", speech: "", reference: "", tags: [], terms: ["Zustand", "npm"] },
        { id: "b", speech: "", reference: "", tags: [], terms: ["zustand", "Vite"] },
      ])
    ).toEqual(["Zustand", "npm", "Vite"]);
  });

  it("fits every fixture term in the dictionary's share of the keyterm budget", () => {
    // Past the cap the app drops the oldest terms, and a "+terms" config would
    // silently run without some of them.
    expect(allFixtureTerms().length).toBeLessThanOrEqual(MAX_DICTIONARY_KEYTERMS);
  });
});

describe("WAV handling", () => {
  it("reads past a chunk before data, including an odd-sized padded one", () => {
    const wav = encodePcm16Wav(pcm([1, -2, 3]));
    const extra = Buffer.concat([
      Buffer.from("FLLR"),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from([9, 9, 9, 0]),
    ]);
    const withChunk = Buffer.concat([wav.subarray(0, 36), extra, wav.subarray(36)]);
    withChunk.writeUInt32LE(withChunk.length - 8, 4);
    expect(Array.from(readPcm16Wav(withChunk).samples)).toEqual([1, -2, 3]);
  });

  it("refuses anything but whole mono 16-bit PCM at a real rate", () => {
    const corrupt = (edit: (wav: Buffer) => Buffer | void) => {
      const wav = encodePcm16Wav(pcm([1, 2, 3, 4]));
      return () => readPcm16Wav(edit(wav) ?? wav);
    };
    expect(corrupt((w) => void w.writeUInt16LE(2, 22))).toThrow(/mono 16-bit/);
    expect(corrupt((w) => void w.writeUInt16LE(3, 20))).toThrow(/format 3/);
    expect(corrupt((w) => void w.writeUInt16LE(8, 34))).toThrow(/8-bit/);
    expect(corrupt((w) => void w.writeUInt32LE(0, 24))).toThrow(/sample rate/);
    // A copy cut short: the header promises more samples than the file holds.
    expect(corrupt((w) => w.subarray(0, w.length - 2))).toThrow(/past the end/);
    expect(corrupt((w) => void w.writeUInt32LE(7, 40))).toThrow(/partway through a sample/);
    expect(() => readPcm16Wav(Buffer.from("not a wav file at all"))).toThrow(/RIFF/);
    expect(
      readPcm16Wav(encodePcm16Wav({ sampleRate: 16_000, samples: Int16Array.from([5]) }))
    ).toMatchObject({ sampleRate: 16_000 });
  });

  it("reads a streamed WAV whose data length was never filled in", () => {
    const wav = encodePcm16Wav(pcm([7, -7, 9]));
    wav.writeUInt32LE(0xffffffff, 40);
    expect(Array.from(readPcm16Wav(wav).samples)).toEqual([7, -7, 9]);
    expect(() => readPcm16Wav(wav.subarray(0, wav.length - 1))).toThrow(/partway/);
  });

  it("trims the edges but keeps a pause inside the speech", () => {
    const trimmed = trimSilence(
      pcm(segment(300, 0), segment(500, 0.5), segment(600, 0), segment(500, 0.5), segment(200, 0))
    );
    const ms = (trimmed.samples.length / RATE) * 1000;
    expect(ms).toBeGreaterThan(1550);
    expect(ms).toBeLessThan(1610);
    expect(Math.abs(trimmed.samples[0]!)).toBeGreaterThanOrEqual(Math.round(0.01 * 32768));
  });

  it("treats loud negative samples as speech and quiet ones as silence", () => {
    const negative = (n: number, value: number) => new Array<number>(n).fill(value);
    const trimmed = trimSilence(pcm(negative(10, -100), negative(5, -20_000), negative(10, 100)));
    expect(Array.from(trimmed.samples)).toEqual(negative(5, -20_000));
    expect(trimSilence(pcm(negative(10, 0))).samples.length).toBe(0);
  });

  it("measures the longest utterance between pauses, wherever it falls", () => {
    const audio = pcm(segment(2000, 0.5), segment(600, 0), segment(900, 0.5));
    expect(longestUtteranceMs(audio)).toBeGreaterThan(1950);
    expect(longestUtteranceMs(audio)).toBeLessThan(2050);
    // A gap shorter than a pause doesn't split the utterance.
    const joined = pcm(segment(900, 0.5), segment(200, 0), segment(900, 0.5));
    expect(longestUtteranceMs(joined)).toBeGreaterThan(1950);
    expect(longestUtteranceMs(pcm(segment(500, 0)))).toBe(0);
  });
});

describe("prepareClip", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("plays a recording as it is when one exists for the clip", () => {
    dir = mkdtempSync(path.join(tmpdir(), "voice-replay-test-"));
    const clip = REPLAY_CLIPS[0]!;
    const recording = path.join(dir, `${clip.id}.wav`);
    writeFileSync(recording, encodePcm16Wav(pcm(segment(100, 0), segment(1000, 0.5))));
    const prepared = prepareClip(clip, { cacheDir: path.join(dir, "cache"), recordingsDir: dir });
    expect(prepared.source).toBe("recorded");
    expect(prepared.wavPath).toBe(recording);
    expect(prepared.audioMs).toBe(1100);
  });
});
