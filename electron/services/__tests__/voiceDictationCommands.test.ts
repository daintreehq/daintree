import { describe, it, expect } from "vitest";
import {
  applyDictationCommands,
  extractSendCommand,
  pendingCommandStart,
  trailingDictationCommands,
} from "../voiceDictationCommands.js";

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
    ["Fix the login bug. Send it!", "Fix the login bug"],
    ["fix the login bug Send  It ", "fix the login bug"],
    ["Send it.", ""],
    ["send it", ""],
    ["Tie the knot send it", "Tie the knot"],
    ["Is it right or not? Send it.", "Is it right or not"],
    ["Looks good, just send it.", "Looks good, just"],
    ["Don't wait, just send it.", "Don't wait, just"],
    ["Fix the login bug, send it.", "Fix the login bug"],
    ["Fix the login bug. Send it.", "Fix the login bug"],
    ["Fix it send it", "Fix it"],
    ["Where should I put the handler? Send it.", "Where should I put the handler"],
    ["Don't forget the tests. Send it.", "Don't forget the tests"],
    ["Fix the bug and send it", "Fix the bug and"],
    ["When ready send it", "When ready"],
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
    "I didn't send it.",
    "I didn’t send it",
    "It doesn't send it",
    "It doesnt send it",
    "I wouldn't send it.",
    "We couldn't send it",
    "This isn't send it",
    "Remember not to send it.",
    "Don't just send it.",
    "Please don’t just send it",
    "Do not yet send it",
    "Draft the reply to the client but don't actually send it.",
    "Write the migration email but do not ever send it.",
    "Draft the Slack update and let me review it before you send it.",
    "Log the payload right before we send it.",
    "Where should the webhook handler send it?",
    "Where should the webhook handler send it",
    "How do we send it",
    "Fix the bug, send it?",
    "Maybe I'll send it",
    "I’ll send it.",
    "They send it",
    "You should send it",
    "I want to send it",
    "The bot will send it.",
    "Never actually send it",
    "I have no plans to send it",
    "When should the webhook handler send it",
    "How should the webhook handler send it",
    "No service should ever send it",
    "I’ll eventually send it",
    "We actually send it",
  ])("leaves %j literal", (input) => {
    expect(extractSendCommand(input)).toEqual({ text: input, send: false });
  });

  it("leaves break commands before it for applyDictationCommands", () => {
    const { text } = extractSendCommand("hello new line send it");
    expect(applyDictationCommands(text)).toBe("hello\n");
  });
});

describe("trailingDictationCommands", () => {
  it("says where a trailing chain starts and the breaks it stands for", () => {
    const text = "Fix it, new line new paragraph.";
    const chain = trailingDictationCommands(text);
    expect(chain).toEqual({ start: text.indexOf(" new"), replacement: "\n\n\n" });
  });

  it("finds nothing when the commands don't end the text", () => {
    expect(trailingDictationCommands("a new line inside quoted strings")).toBeNull();
  });
});

describe("pendingCommandStart", () => {
  it.each([
    ["fix the bug, send", "send"],
    ["fix the bug, send it.", "send it."],
    ["accept a new line", "new line"],
    ["add a New", "New"],
    ["hello new line new", "new line new"],
    ["hello new line send", "new line send"],
    ["send it new paragraph", "new paragraph"],
  ])("finds where %j could still end in commands", (text, tail) => {
    expect(text.slice(pendingCommandStart(text))).toBe(tail);
  });

  it.each(["fix the bug", "send it to the API", "a new line here", "line", "it", ""])(
    "finds nothing pending in %j",
    (text) => {
      expect(pendingCommandStart(text)).toBe(-1);
    }
  );
});
