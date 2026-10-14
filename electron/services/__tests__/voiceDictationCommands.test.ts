import { describe, it, expect } from "vitest";
import { applyDictationCommands } from "../voiceDictationCommands.js";

describe("applyDictationCommands", () => {
  describe("individual commands at end of utterance", () => {
    it("replaces trailing 'period' with '.'", () => {
      expect(applyDictationCommands("hello period")).toBe("hello.");
    });

    it("replaces trailing 'full stop' with '.'", () => {
      expect(applyDictationCommands("hello full stop")).toBe("hello.");
    });

    it("replaces trailing 'comma' with ','", () => {
      expect(applyDictationCommands("hello comma")).toBe("hello,");
    });

    it("replaces trailing 'question mark' with '?'", () => {
      expect(applyDictationCommands("are you there question mark")).toBe("are you there?");
    });

    it("replaces trailing 'exclamation point' with '!'", () => {
      expect(applyDictationCommands("watch out exclamation point")).toBe("watch out!");
    });

    it("replaces trailing 'exclamation mark' with '!'", () => {
      expect(applyDictationCommands("watch out exclamation mark")).toBe("watch out!");
    });

    it("replaces trailing 'new paragraph' with '\\n\\n'", () => {
      expect(applyDictationCommands("hello new paragraph")).toBe("hello\n\n");
    });

    it("replaces trailing 'new line' with '\\n'", () => {
      expect(applyDictationCommands("hello new line")).toBe("hello\n");
    });
  });

  describe("command-only utterances", () => {
    it("replaces a standalone 'period'", () => {
      expect(applyDictationCommands("period")).toBe(".");
    });

    it("replaces a standalone 'new paragraph'", () => {
      expect(applyDictationCommands("new paragraph")).toBe("\n\n");
    });
  });

  describe("case insensitivity", () => {
    it("replaces uppercase commands", () => {
      expect(applyDictationCommands("hello PERIOD")).toBe("hello.");
    });

    it("replaces mixed-case commands", () => {
      expect(applyDictationCommands("hello New Paragraph")).toBe("hello\n\n");
    });
  });

  describe("false-positive safety (mid-sentence)", () => {
    it("leaves 'I'll add a new paragraph here' literal", () => {
      const input = "I'll add a new paragraph here";
      expect(applyDictationCommands(input)).toBe(input);
    });

    it("leaves empty string unchanged", () => {
      expect(applyDictationCommands("")).toBe("");
    });

    it("leaves text without any commands unchanged", () => {
      const input = "the quick brown fox";
      expect(applyDictationCommands(input)).toBe(input);
    });
  });

  describe("chained trailing commands", () => {
    it("replaces 'hello comma new paragraph' as a chain", () => {
      expect(applyDictationCommands("hello comma new paragraph")).toBe("hello,\n\n");
    });

    it("replaces the trailing chain only when literal text intervenes", () => {
      // "world" interrupts the chain, so only "period" at the tail fires.
      expect(applyDictationCommands("hello comma world period")).toBe("hello comma world.");
    });

    it("preserves a chain that ends in a formatting command followed by punctuation", () => {
      // Chain produces a paragraph break followed by a literal comma — the
      // downstream split-on-\\n\\n yields ["hello", ","] which the handler
      // emits as two paragraphs.
      expect(applyDictationCommands("hello new paragraph comma")).toBe("hello\n\n,");
    });
  });

  describe("whitespace handling", () => {
    it("handles multiple spaces between text and command", () => {
      expect(applyDictationCommands("hello   period")).toBe("hello.");
    });

    it("handles trailing whitespace after command", () => {
      expect(applyDictationCommands("hello period   ")).toBe("hello.");
    });

    it("preserves leading whitespace before the literal portion", () => {
      // Leading whitespace before "hello" is preserved; only the trailing chain replaces.
      expect(applyDictationCommands("  hello period")).toBe("  hello.");
    });
  });

  describe("idempotence", () => {
    it("running twice produces the same result", () => {
      const once = applyDictationCommands("hello period");
      const twice = applyDictationCommands(once);
      expect(twice).toBe(once);
    });
  });

  describe("word-boundary safety", () => {
    it("does not match 'period' inside 'periodic'", () => {
      expect(applyDictationCommands("periodic")).toBe("periodic");
    });

    it("matches a trailing command after a word that starts with the same prefix", () => {
      // "periodic" is preserved; the trailing standalone "period" still fires.
      expect(applyDictationCommands("periodic period")).toBe("periodic.");
    });
  });

  describe("documented limitations", () => {
    // The trailing-anchor design is end-of-utterance only. Legitimate trailing
    // nouns that happen to be command words will convert. This is the same
    // tradeoff the legacy Deepgram dictation mode made — kept for parity. If a
    // user dislikes it, the manual paragraphing strategy disables the post-processor.
    it("converts a trailing noun that happens to spell a command (known tradeoff)", () => {
      expect(applyDictationCommands("I studied the Jurassic period")).toBe(
        "I studied the Jurassic."
      );
    });
  });
});
