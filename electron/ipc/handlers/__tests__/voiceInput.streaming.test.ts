import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => "granted") },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: vi.fn(),
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getCurrentProject: vi.fn(() => null), getCurrentProjectId: vi.fn(() => null) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
}));

vi.mock("../../../services/voiceContextKeyterms.js", () => ({
  assembleKeyterms: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../channels.js", () => ({ CHANNELS: {} }));

import { TranscriptionBuffer, PromisePool } from "../voiceInput.js";

function makeWord(word: string, confidence: number) {
  return { word, confidence };
}

function highWords(text: string) {
  return text.split(/\s+/).map((w) => makeWord(w, 0.95));
}

function lowWord(word: string, confidence = 0.6) {
  return makeWord(word, confidence);
}

describe("TranscriptionBuffer", () => {
  it("returns no clusters when all words are high confidence", () => {
    const buffer = new TranscriptionBuffer();
    const clusters = buffer.append(highWords("hello world how are you"));
    expect(clusters).toHaveLength(0);
  });

  it("returns no clusters when low-confidence word lacks right-context", () => {
    const buffer = new TranscriptionBuffer();
    const clusters = buffer.append([lowWord("racked")]);
    expect(clusters).toHaveLength(0);
  });

  it("returns a cluster when right-context reaches 3 words", () => {
    const buffer = new TranscriptionBuffer();

    let clusters = buffer.append([lowWord("racked")]);
    expect(clusters).toHaveLength(0);

    clusters = buffer.append(highWords("is a great framework"));
    expect(clusters).toHaveLength(1);
    expect(clusters[0].words).toHaveLength(1);
    expect(clusters[0].words[0].word).toBe("racked");
    expect(clusters[0].rightContext.map((w) => w.word)).toEqual(["is", "a", "great"]);
  });

  it("groups adjacent low-confidence words into a single cluster", () => {
    const buffer = new TranscriptionBuffer();

    const clusters = buffer.append([
      lowWord("zoo"),
      lowWord("stand"),
      ...highWords("is a great library"),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].words.map((w) => w.word)).toEqual(["zoo", "stand"]);
    expect(clusters[0].rightContext.map((w) => w.word)).toEqual(["is", "a", "great"]);
  });

  it("includes left-context from preceding high-confidence words", () => {
    const buffer = new TranscriptionBuffer();

    const clusters = buffer.append([
      ...highWords("I love"),
      lowWord("racked"),
      ...highWords("it is great"),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].leftContext.map((w) => w.word)).toEqual(["I", "love"]);
  });

  it("flush returns pending clusters regardless of right-context", () => {
    const buffer = new TranscriptionBuffer();
    buffer.append([lowWord("racked")]);

    const clusters = buffer.flush();
    expect(clusters).toHaveLength(1);
    expect(clusters[0].words[0].word).toBe("racked");
    expect(clusters[0].rightContext).toHaveLength(0);
  });

  it("reset clears all state", () => {
    const buffer = new TranscriptionBuffer();
    buffer.append([lowWord("racked")]);
    buffer.reset();

    const clusters = buffer.flush();
    expect(clusters).toHaveLength(0);
  });

  it("handles multiple clusters in a single segment", () => {
    const buffer = new TranscriptionBuffer();

    const clusters = buffer.append([
      lowWord("racked"),
      ...highWords("is a great tool"),
      lowWord("zoo"),
      ...highWords("stand is nice today"),
    ]);

    expect(clusters).toHaveLength(2);
    // First cluster: "racked" with right-context "is a great"
    expect(clusters[0].words.map((w) => w.word)).toEqual(["racked"]);
    expect(clusters[0].rightContext.map((w) => w.word)).toEqual(["is", "a", "great"]);
    // Second cluster: "zoo" with right-context "stand is nice"
    expect(clusters[1].words.map((w) => w.word)).toEqual(["zoo"]);
    expect(clusters[1].rightContext.map((w) => w.word)).toEqual(["stand", "is", "nice"]);
    // Left-context of second cluster: up to 3 words before "zoo" (indices 2,3,4 → "a","great","tool")
    expect(clusters[1].leftContext.map((w) => w.word)).toEqual(["a", "great", "tool"]);
  });

  it("does not re-emit clusters that were already emitted", () => {
    const buffer = new TranscriptionBuffer();

    // First segment: low-confidence + right-context → cluster emitted
    buffer.append([lowWord("racked"), ...highWords("is a great")]);

    // Second segment: all high-confidence → no new cluster
    const clusters2 = buffer.append(highWords("framework indeed"));
    expect(clusters2).toHaveLength(0);
  });

  it("accumulates words across multiple append calls", () => {
    const buffer = new TranscriptionBuffer();

    // Append 1: low-confidence word, no right-context
    buffer.append([lowWord("racked")]);

    // Append 2: still not enough right-context
    buffer.append(highWords("is"));

    // Append 3: not enough yet
    let clusters = buffer.append(highWords("a"));
    expect(clusters).toHaveLength(0);

    // Append 4: now we have 3 right-context words
    clusters = buffer.append(highWords("great"));
    expect(clusters).toHaveLength(1);
    expect(clusters[0].words[0].word).toBe("racked");
  });
});

describe("PromisePool", () => {
  it("runs tasks up to the concurrency limit", async () => {
    const pool = new PromisePool(2);
    const order: number[] = [];
    let resolveA!: () => void;
    let resolveB!: () => void;

    pool.add(
      () =>
        new Promise<void>((r) => {
          resolveA = r;
          order.push(1);
        })
    );
    pool.add(
      () =>
        new Promise<void>((r) => {
          resolveB = r;
          order.push(2);
        })
    );
    pool.add(async () => {
      order.push(3);
    });

    // Tasks 1 and 2 should start immediately; task 3 is queued
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2]);

    // Complete task 1 → task 3 should start
    resolveA();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2, 3]);

    resolveB();
  });

  it("drain resolves when all tasks complete", async () => {
    const pool = new PromisePool(5);
    const results: string[] = [];

    pool.add(async () => {
      results.push("a");
    });
    pool.add(async () => {
      results.push("b");
    });

    await pool.drain();
    expect(results).toEqual(["a", "b"]);
  });

  it("drain resolves immediately when pool is empty", async () => {
    const pool = new PromisePool(5);
    await pool.drain();
  });

  it("handles task errors without breaking the pool", async () => {
    const pool = new PromisePool(2);
    const results: string[] = [];

    pool.add(async () => {
      throw new Error("fail");
    });
    pool.add(async () => {
      results.push("success");
    });

    await pool.drain();
    expect(results).toEqual(["success"]);
  });
});
