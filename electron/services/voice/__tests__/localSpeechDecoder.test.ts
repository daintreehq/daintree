import { describe, expect, it } from "vitest";
import { argMax, RnntGreedyDecoder, type RnntStepModel } from "../localSpeechDecoder.js";
import { LocalSpeechVocabulary } from "../localSpeechVocabulary.js";

const VOCAB = 5;
const BLANK = 4;

/**
 * A step model whose joint answers from the frame and the token its pending
 * prediction was run on, as an RNN-T's does. Records every prediction run.
 */
function modelFrom(next: (frame: number, last: number) => number) {
  const predicted: number[] = [];
  let pending = BLANK;
  const model: RnntStepModel = {
    predict: async (token) => {
      predicted.push(token);
      pending = token;
    },
    commit: () => {},
    join: async (first, count) => {
      const out = new Float32Array(count * VOCAB).fill(-10);
      for (let f = 0; f < count; f++) out[f * VOCAB + next(first + f, pending)] = 0;
      return out;
    },
    reset: () => {},
  };
  return { model, predicted };
}

describe("RnntGreedyDecoder", () => {
  it("advances on blank and feeds every emitted token back", async () => {
    const script: Record<string, number> = { "0:4": 1, "2:1": 2, "2:2": 3 };
    const { model, predicted } = modelFrom((frame, last) => script[`${frame}:${last}`] ?? BLANK);
    const tokens = await new RnntGreedyDecoder(model, BLANK, VOCAB, 10).decodeChunk(3);
    expect(tokens).toEqual([
      { id: 1, frame: 0 },
      { id: 2, frame: 2 },
      { id: 3, frame: 2 },
    ]);
    expect(predicted).toEqual([BLANK, 1, 2, 3]);
  });

  it("emits at most maxSymbolsPerStep on one frame", async () => {
    const model: RnntStepModel = {
      predict: async () => {},
      commit: () => {},
      // Frame 0 never offers blank; frame 1 always does.
      join: async (first, count) => {
        const out = new Float32Array(count * VOCAB).fill(-10);
        for (let f = 0; f < count; f++) out[f * VOCAB + (first + f === 0 ? 1 : BLANK)] = 0;
        return out;
      },
      reset: () => {},
    };
    const tokens = await new RnntGreedyDecoder(model, BLANK, VOCAB, 3).decodeChunk(2);
    expect(tokens.map((t) => t.frame)).toEqual([0, 0, 0]);
  });

  it("carries the last token into the next chunk and forgets it on reset", async () => {
    const predicted: number[] = [];
    let offer = 2;
    const model: RnntStepModel = {
      predict: async (token) => void predicted.push(token),
      commit: () => {},
      join: async (_first, count) => {
        const out = new Float32Array(count * VOCAB).fill(-10);
        out[offer] = 0;
        offer = BLANK;
        for (let f = 1; f < count; f++) out[f * VOCAB + BLANK] = 0;
        return out;
      },
      reset: () => {},
    };
    const decoder = new RnntGreedyDecoder(model, BLANK, VOCAB, 10);
    await decoder.decodeChunk(1);
    await decoder.decodeChunk(1);
    decoder.reset();
    await decoder.decodeChunk(1);
    // First chunk predicts from blank, then from the emitted 2; the second
    // chunk reuses that prediction; after reset it starts from blank again.
    expect(predicted).toEqual([BLANK, 2, BLANK]);
  });
});

describe("argMax", () => {
  it("skips NaN and answers blank when nothing is a number", () => {
    expect(argMax(new Float32Array([NaN, 1, 3, 2]), 0, 4, 9)).toBe(2);
    expect(argMax(new Float32Array([NaN, NaN]), 0, 2, 9)).toBe(9);
  });
});

describe("LocalSpeechVocabulary", () => {
  const vocab = LocalSpeechVocabulary.parse(
    ["<unk>", "<en-US>", "▁Fix", "ed", ",", "▁", "it", "<blank>", ""].join("\n"),
    8
  );

  it("joins pieces, word markers as spaces, dropping tags and specials", () => {
    expect(vocab.decode([2, 3, 4, 1, 0, 5, 6, 7])).toBe(" Fixed, it");
  });

  it("knows which pieces start a word", () => {
    expect([2, 3, 4, 5, 6, 1].map((id) => vocab.startsWord(id))).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it("refuses a vocabulary of the wrong size", () => {
    expect(() => LocalSpeechVocabulary.parse("a\nb\n", 3)).toThrow();
  });
});
