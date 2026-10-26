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
import { normaliseWords, scoreClip } from "../voiceReplayScore";

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
  });

  it("scores a perfect transcript of every reference as perfect", () => {
    for (const clip of REPLAY_CLIPS) {
      const score = scoreClip(clip.reference, clip.reference, clip.terms);
      expect(score.wer, clip.id).toBe(0);
      expect(score.missedTerms, clip.id).toEqual([]);
    }
  });

  it("says each clip so that a transcript of the speech is close to the reference", () => {
    // Spoken forms ("N P M", "dash dash watch") normalise to the written ones,
    // so a provider that hears every word well loses nothing to the fixture.
    for (const clip of REPLAY_CLIPS) {
      const speech = clip.speech.replace(/\[\[slnc \d+\]\]/g, " ");
      const score = scoreClip(clip.reference, speech, clip.terms);
      expect(score.wer, clip.id).toBeLessThanOrEqual(0.15);
      expect(normaliseWords(speech)[0], clip.id).toBe(normaliseWords(clip.reference)[0]);
    }
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

  it("refuses anything but mono 16-bit PCM", () => {
    const stereo = encodePcm16Wav(pcm([0, 0]));
    stereo.writeUInt16LE(2, 22);
    expect(() => readPcm16Wav(stereo)).toThrow(/mono 16-bit/);
    expect(() => readPcm16Wav(Buffer.from("not a wav file at all"))).toThrow(/RIFF/);
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

  it("measures the longest utterance between pauses, not the clip", () => {
    const audio = pcm(segment(900, 0.5), segment(600, 0), segment(2000, 0.5));
    expect(longestUtteranceMs(audio)).toBeGreaterThan(1950);
    expect(longestUtteranceMs(audio)).toBeLessThan(2050);
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
