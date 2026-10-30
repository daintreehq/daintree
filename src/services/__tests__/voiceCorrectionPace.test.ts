import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCorrectionPace } from "@shared/types/ipc/api";

type PaceModule = typeof import("../voiceCorrectionPace");

const RETIRED_KEY = "daintree-voice-correction-pace";

function memoryStorage(): Storage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

function haiku(firstTextMs: number, outputMs: number, effort = "medium"): VoiceCorrectionPace {
  return { model: "claude-haiku-5-5", effort, firstTextMs, outputMs } as VoiceCorrectionPace;
}

describe("voiceCorrectionPace", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let pace: PaceModule;

  beforeEach(async () => {
    storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    vi.resetModules();
    pace = await import("../voiceCorrectionPace");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Cleanups of passages 50 to 400 long: the first text after `firstText(chars)`, the text at `msPerChar`. */
  function teach(
    sample: (chars: number) => VoiceCorrectionPace,
    rounds = 6,
    lengths = [50, 120, 250, 400]
  ) {
    for (let i = 0; i < rounds; i++) {
      for (const chars of lengths) pace.recordCorrectionPace(chars, sample(chars));
    }
  }

  it("learns the wait for the first text and the text apart, each against the passage's length", () => {
    teach((chars) => haiku(1_500 + 4 * chars, chars));

    for (const chars of [80, 300]) {
      expect(pace.estimateCorrectionMs("claude-haiku-5-5", "medium", chars)).toBeCloseTo(
        1_500 + 5 * chars,
        -1
      );
    }
  });

  it("keeps each model and effort's pace to itself", () => {
    const at = (model: "claude-haiku-5-5" | "gpt-6.1-terra", effort: "none" | "low" | "medium") =>
      pace.estimateCorrectionMs(model, effort, 200);
    const terraBefore = at("gpt-6.1-terra", "low");
    const mediumBefore = at("claude-haiku-5-5", "medium");
    const noneBefore = at("claude-haiku-5-5", "none");

    // Haiku at the same effort Terra runs at learns nothing for Terra, nor for its other efforts.
    teach((chars) => haiku(6_000, 3 * chars, "low"));
    const haikuLearned = at("claude-haiku-5-5", "low");
    expect(haikuLearned).toBeGreaterThan(terraBefore);
    expect(at("gpt-6.1-terra", "low")).toBe(terraBefore);
    expect(at("claude-haiku-5-5", "medium")).toBe(mediumBefore);
    expect(at("claude-haiku-5-5", "none")).toBe(noneBefore);

    // Moving to Terra and back finds Haiku's own pace still there.
    teach((chars) => ({
      model: "gpt-6.1-terra",
      effort: "low",
      firstTextMs: 400,
      outputMs: chars,
    }));
    expect(at("claude-haiku-5-5", "low")).toBe(haikuLearned);
    expect(at("gpt-6.1-terra", "low")).toBeLessThan(terraBefore);
  });

  it("lands a long run of equal lengths where they took, at that length", () => {
    teach(() => haiku(1_000, 500), 151, [600]);
    expect(pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 600)).toBeCloseTo(1_500, 0);
  });

  it("starts a cleanup without reasoning with no thinking time", () => {
    for (const chars of [60, 400]) {
      const none = pace.estimateCorrectionMs("claude-haiku-5-5", "none", chars);
      const medium = pace.estimateCorrectionMs("claude-haiku-5-5", "medium", chars);
      const low = pace.estimateCorrectionMs("gpt-6.1-terra", "low", chars);
      expect(none).toBeLessThan(medium);
      expect(medium).toBe(low);
    }
    // The thinking grows with the passage, so the gap does too.
    const gap = (chars: number) =>
      pace.estimateCorrectionMs("claude-haiku-5-5", "medium", chars) -
      pace.estimateCorrectionMs("claude-haiku-5-5", "none", chars);
    expect(gap(400)).toBeGreaterThan(gap(60));
  });

  it("ignores samples it can't trust", () => {
    const before = pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 200);
    pace.recordCorrectionPace(200, haiku(Number.NaN, 100));
    pace.recordCorrectionPace(200, haiku(-5, 100));
    pace.recordCorrectionPace(200, haiku(2_000, Number.POSITIVE_INFINITY));
    pace.recordCorrectionPace(200, haiku(2_000, -1));
    pace.recordCorrectionPace(200, haiku(40_000, 100));
    pace.recordCorrectionPace(0, haiku(2_000, 100));
    pace.recordCorrectionPace(200, haiku(2_000, 100, "extreme"));
    pace.recordCorrectionPace(200, { ...haiku(2_000, 100), model: "gpt-9" } as never);

    expect(pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 200)).toBe(before);
    expect(storage.length).toBe(0);
  });

  it("shares the stored pace across live views and drops the retired single fit", async () => {
    storage.setItem(RETIRED_KEY, JSON.stringify({ w: 1, x: 1, y: 1, xx: 1, xy: 1 }));
    vi.resetModules();
    const otherView: PaceModule = await import("../voiceCorrectionPace");
    const at = (view: PaceModule) => view.estimateCorrectionMs("claude-haiku-5-5", "medium", 200);

    pace.recordCorrectionPace(200, haiku(5_000, 200));
    expect(storage.getItem(RETIRED_KEY)).toBeNull();
    expect(at(otherView)).toBe(at(pace));
    const afterFirst = at(pace);

    otherView.recordCorrectionPace(200, haiku(9_000, 200));
    expect(at(pace)).toBe(at(otherView));
    expect(at(pace)).toBeGreaterThan(afterFirst);
  });

  it("reads a corrupt store as the prior, and keeps learning in memory when storage is blocked", () => {
    const prior = pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 200);
    const key = "daintree-voice-cleanup-pace:claude-haiku-5-5:medium";
    storage.setItem(key, "{not json");
    expect(pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 200)).toBe(prior);
    // Finite sums no cleanup could have left behind.
    const vanishing = { w: 1e-320, x: 0, y: 1, xx: 0, xy: 0 };
    storage.setItem(key, JSON.stringify({ firstText: vanishing, output: vanishing }));
    expect(pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 200)).toBe(prior);

    const blocked = () => {
      throw new Error("blocked");
    };
    storage.getItem = blocked;
    storage.setItem = blocked;
    teach((chars) => haiku(5_000, chars));
    expect(pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 200)).toBeGreaterThan(prior);
  });

  it("keeps learning past a stored fit it can no longer write over", () => {
    teach((chars) => haiku(2_000, chars));
    const stored = pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 200);
    storage.setItem = () => {
      throw new Error("quota");
    };
    teach((chars) => haiku(8_000, chars));
    expect(pace.estimateCorrectionMs("claude-haiku-5-5", "medium", 200)).toBeGreaterThan(
      stored + 4_000
    );
  });
});
