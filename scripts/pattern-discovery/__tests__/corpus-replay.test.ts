import { describe, it, expect } from "vitest";
import path from "node:path";
import { replayCorpus, readCorpus } from "../corpus-replay.js";

const CORPUS_DIR = path.resolve(import.meta.dirname, "../corpus");
const MIN_ACCURACY = 0.9;

describe("corpus-replay", () => {
  describe("readCorpus", () => {
    it("reads JSONL corpus entries", () => {
      const entries = readCorpus(path.join(CORPUS_DIR, "claude_sample.jsonl"));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]).toHaveProperty("time");
      expect(entries[0]).toHaveProperty("chunk");
      expect(entries[0]).toHaveProperty("detectedState");
      expect(entries[0]).toHaveProperty("agentId");
    });
  });

  describe("claude corpus replay", () => {
    it("achieves >= 90% accuracy on claude sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "claude_sample.jsonl"), "claude");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("gemini corpus replay", () => {
    it("achieves >= 90% accuracy on gemini sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "gemini_sample.jsonl"), "gemini");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("codex corpus replay", () => {
    it("achieves >= 90% accuracy on codex sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "codex_sample.jsonl"), "codex");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("replay result structure", () => {
    it("returns detailed wrong entries for debugging", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "claude_sample.jsonl"), "claude");
      for (const w of result.wrong) {
        expect(w).toHaveProperty("entry");
        expect(w).toHaveProperty("actualState");
        expect(w).toHaveProperty("actualConfidence");
      }
      expect(result.correct + result.wrong.length).toBe(result.total);
    });
  });
});
