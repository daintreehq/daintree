import { describe, it, expect } from "vitest";
import { applyDictationCommands, extractSendCommand } from "../voiceDictationCommands.js";

describe("applyDictationCommands", () => {
  describe("break commands at end of utterance", () => {
    it("replaces trailing 'new paragraph' with '\\n\\n'", () => {
      expect(applyDictationCommands("hello new paragraph")).toBe("hello\n\n");
    });

    it("replaces trailing 'new line' with '\\n'", () => {
      expect(applyDictationCommands("fix the bug new line")).toBe("fix the bug\n");
    });

    it("replaces a standalone 'new paragraph'", () => {
      expect(applyDictationCommands("new paragraph")).toBe("\n\n");
    });

    it("matches case-insensitively", () => {
      expect(applyDictationCommands("hello New Paragraph")).toBe("hello\n\n");
    });
  });

  describe("model punctuation around the command", () => {
    it("matches when the model adds a full stop after the command", () => {
      expect(applyDictationCommands("Hello, new paragraph.")).toBe("Hello,\n\n");
    });

    it("matches a standalone command with punctuation and capitals", () => {
      expect(applyDictationCommands("New line.")).toBe("\n");
    });

    it("matches a comma before the command", () => {
      expect(applyDictationCommands("Done, new line")).toBe("Done,\n");
    });
  });

  describe("spoken punctuation words are not commands", () => {
    it.each([
      "What's the retention period",
      "Separate them with a comma",
      "Hello comma",
      "Stop at the full stop",
      "Is it done question mark",
      "Great exclamation point",
      "Great exclamation mark",
      "period",
    ])("leaves %j literal", (input) => {
      expect(applyDictationCommands(input)).toBe(input);
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
  });

  describe("chained trailing commands", () => {
    it("replaces a chain of break commands", () => {
      expect(applyDictationCommands("hello new line new paragraph")).toBe("hello\n\n\n");
    });

    it("replaces only the trailing chain when literal text intervenes", () => {
      expect(applyDictationCommands("new line world new paragraph")).toBe("new line world\n\n");
    });
  });

  describe("whitespace and boundaries", () => {
    it("handles extra whitespace around the command", () => {
      expect(applyDictationCommands("hello   new line   ")).toBe("hello\n");
    });

    it("does not match a command embedded in a longer word", () => {
      expect(applyDictationCommands("a new lines")).toBe("a new lines");
    });
  });

  it("is idempotent", () => {
    const once = applyDictationCommands("hello new line");
    expect(applyDictationCommands(once)).toBe(once);
  });
});

describe("extractSendCommand", () => {
  it.each([
    ["fix the login bug send it", "fix the login bug"],
    ["Fix the login bug, send it.", "Fix the login bug"],
    ["Fix the login bug. Send it!", "Fix the login bug"],
    ["fix the login bug Send  It ", "fix the login bug"],
    ["Send it.", ""],
    ["send it", ""],
    ["Tie the knot send it", "Tie the knot"],
    ["Is it right or not? Send it.", "Is it right or not"],
  ])("strips the trailing command from %j", (input, text) => {
    expect(extractSendCommand(input)).toEqual({ text, send: true });
  });

  it.each([
    "then send it to the API",
    "send it to the API",
    "resend it",
    "we should send items later",
    "",
    "hello",
    "Fix the bug but don't send it.",
    "Fix the bug but don’t send it.",
    "fix the bug but dont send it",
    "Fix the bug but DON'T SEND IT",
    "Fix the bug, but do not send it.",
    "Not send it",
    "We never send it.",
    "It won't send it",
    "It won’t send it",
    "I can't send it",
    "I can’t send it",
    "I cannot send it",
    "You shouldn't send it.",
    "You shouldnt send it",
  ])("leaves %j literal", (input) => {
    expect(extractSendCommand(input)).toEqual({ text: input, send: false });
  });

  it("leaves break commands before it for applyDictationCommands", () => {
    const { text } = extractSendCommand("hello new line send it");
    expect(applyDictationCommands(text)).toBe("hello\n");
  });
});
