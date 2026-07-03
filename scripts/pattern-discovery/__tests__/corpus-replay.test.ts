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

  describe("mistral corpus replay", () => {
    it("achieves >= 90% accuracy on mistral sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "mistral_sample.jsonl"), "mistral");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  // Amp ships with empty primary/fallback patterns until on-device PTY
  // capture lands. The corpus only exercises non-working states so the
  // accuracy gate stays meaningful — working samples will be added when
  // patterns are discovered.
  describe("amp corpus replay", () => {
    it("achieves >= 90% accuracy on amp sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "amp_sample.jsonl"), "amp");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("aider corpus replay", () => {
    it("achieves >= 90% accuracy on aider sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "aider_sample.jsonl"), "aider");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("crush corpus replay", () => {
    it("achieves >= 90% accuracy on crush sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "crush_sample.jsonl"), "crush");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("goose corpus replay", () => {
    it("achieves >= 90% accuracy on goose sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "goose_sample.jsonl"), "goose");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("qwen corpus replay", () => {
    it("achieves >= 90% accuracy on qwen sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "qwen_sample.jsonl"), "qwen");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("kimi corpus replay", () => {
    it("achieves >= 90% accuracy on kimi sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "kimi_sample.jsonl"), "kimi");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("opencode corpus replay", () => {
    it("achieves >= 90% accuracy on opencode sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "opencode_sample.jsonl"), "opencode");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("cursor corpus replay", () => {
    it("achieves >= 90% accuracy on cursor sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "cursor_sample.jsonl"), "cursor");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  describe("copilot corpus replay", () => {
    it("achieves >= 90% accuracy on copilot sample corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "copilot_sample.jsonl"), "copilot");
      expect(result.total).toBeGreaterThan(0);
      expect(result.accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
    });
  });

  // Unicode/ANSI adversarial cases: CJK/emoji status lines must detect, and
  // protocol noise (cursor-position reports, OSC titles with marker glyphs,
  // split escape sequences, erase-line redraw fragments) must NOT read as
  // working. 100% accuracy required — every row is deterministic.
  describe("claude unicode/ANSI-noise corpus replay", () => {
    it("achieves 100% accuracy on the unicode adversarial corpus", () => {
      const result = replayCorpus(path.join(CORPUS_DIR, "claude_unicode_sample.jsonl"), "claude");
      expect(result.total).toBeGreaterThan(0);
      expect(result.wrong.map((w) => ({ chunk: w.entry.chunk, got: w.actualState }))).toHaveLength(
        0
      );
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
