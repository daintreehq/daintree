import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  PASTE_THRESHOLD_CHARS,
  containsFullBracketedPaste,
  formatForTerminalPaste,
  formatWithBracketedPaste,
  neutralizeControlCharacters,
  getSoftNewlineSequence,
  shouldUseBracketedPaste,
} from "../terminalInputProtocol.js";
import { setUserRegistry } from "../../config/agentRegistry.js";
import type { AgentConfig } from "../../config/agentRegistry.js";

describe("terminalInputProtocol", () => {
  it("returns expected soft newline sequence for registered agents", () => {
    expect(getSoftNewlineSequence("codex")).toBe("\n");
    expect(getSoftNewlineSequence("claude")).toBe("\x1b\r");
    expect(getSoftNewlineSequence("gemini")).toBe("\x1b\r");
    expect(getSoftNewlineSequence("opencode")).toBe("\n");
  });

  it("falls back to LF for normal terminal types", () => {
    expect(getSoftNewlineSequence("terminal")).toBe("\n");
    expect(getSoftNewlineSequence(undefined)).toBe("\n");
  });

  it("defaults to ESC+CR for unknown agent types", () => {
    expect(getSoftNewlineSequence("unknown-agent")).toBe("\x1b\r");
    expect(getSoftNewlineSequence("custom-cli")).toBe("\x1b\r");
  });

  it("uses ESC+CR default for registered agent with missing softNewlineSequence capability", () => {
    const customAgent: AgentConfig = {
      id: "test-agent",
      name: "Test Agent",
      command: "test-agent",
      color: "#ffffff",
      iconId: "custom",
      supportsContextInjection: false,
      capabilities: {
        scrollback: 1000,
      },
    };
    setUserRegistry({ "test-agent": customAgent });
    expect(getSoftNewlineSequence("test-agent")).toBe("\x1b\r");
    setUserRegistry({});
  });

  it("detects full bracketed paste sequences only when complete", () => {
    const full = `${BRACKETED_PASTE_START}hello${BRACKETED_PASTE_END}`;
    const missingEnd = `${BRACKETED_PASTE_START}hello`;
    const missingStart = `hello${BRACKETED_PASTE_END}`;

    expect(containsFullBracketedPaste(full)).toBe(true);
    expect(containsFullBracketedPaste(missingEnd)).toBe(false);
    expect(containsFullBracketedPaste(missingStart)).toBe(false);
  });

  it("requires sequence to start with bracketed-paste start token", () => {
    const prefixed = `x${BRACKETED_PASTE_START}hello${BRACKETED_PASTE_END}`;
    expect(containsFullBracketedPaste(prefixed)).toBe(false);
  });

  it("uses bracketed paste for multiline input", () => {
    expect(shouldUseBracketedPaste("line1\nline2")).toBe(true);
  });

  it("uses bracketed paste for large single-line input over threshold", () => {
    const overThreshold = "x".repeat(PASTE_THRESHOLD_CHARS + 1);
    expect(shouldUseBracketedPaste(overThreshold)).toBe(true);
  });

  it("does not use bracketed paste at threshold without newline", () => {
    const atThreshold = "x".repeat(PASTE_THRESHOLD_CHARS);
    expect(shouldUseBracketedPaste(atThreshold)).toBe(false);
  });

  it("formats text with bracketed paste tokens", () => {
    expect(formatWithBracketedPaste("abc")).toBe(
      `${BRACKETED_PASTE_START}abc${BRACKETED_PASTE_END}`
    );
  });

  it("neutralizes an embedded terminator so the wrapper cannot be escaped", () => {
    // Text carrying its own END sequence would otherwise close the paste early
    // and hand the remainder to the program as ordinary input.
    const wrapped = formatWithBracketedPaste(`before${BRACKETED_PASTE_END}after`);

    expect(wrapped.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(wrapped.endsWith(BRACKETED_PASTE_END)).toBe(true);
    expect(wrapped.split(BRACKETED_PASTE_END).length - 1).toBe(1);

    const body = wrapped.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
    expect(body).not.toContain(String.fromCharCode(27));
    // The text is still readable — only the ESC byte is swapped for its glyph.
    expect(body).toContain("before");
    expect(body).toContain("after");
  });

  it("leaves text without escape sequences untouched", () => {
    const plain = "@/Users/test/src/App.tsx ";
    expect(formatWithBracketedPaste(plain)).toBe(
      `${BRACKETED_PASTE_START}${plain}${BRACKETED_PASTE_END}`
    );
  });
});

describe("neutralizeControlCharacters", () => {
  const ESC = String.fromCharCode(0x1b);
  const ETX = String.fromCharCode(0x03);

  it("turns every C0 action character into its picture", () => {
    // The pair the audit reproduced reaching a pty intact: a cursor-movement
    // sequence and an interrupt, both carried in a DOM-derived label.
    const payload = `button#x${ESC}[D${ETX}`;
    const safe = neutralizeControlCharacters(payload);

    expect(safe).toBe("button#x\u241b[D\u2403");
    expect(safe).not.toContain(ESC);
    expect(safe).not.toContain(ETX);
    // Still legible: the text around the controls is untouched.
    expect(safe).toContain("button#x");
  });

  it("neutralizes DEL and the rest of the C0 block", () => {
    for (let code = 0; code < 0x20; code++) {
      if (code === 0x09 || code === 0x0a) continue;
      const safe = neutralizeControlCharacters(String.fromCharCode(code));
      expect(safe, `code ${code}`).toBe(String.fromCharCode(0x2400 + code));
    }
    expect(neutralizeControlCharacters(String.fromCharCode(0x7f))).toBe("\u2421");
  });

  it("keeps tabs and newlines, which are structure rather than action", () => {
    expect(neutralizeControlCharacters("a\tb\nc")).toBe("a\tb\nc");
  });

  it("neutralizes a bare carriage return but keeps it inside a paste", () => {
    // Bare, it submits the line. Between paste delimiters it is the line
    // separator the program reads as data.
    expect(neutralizeControlCharacters("a\rb")).toBe("a\u240db");
    expect(neutralizeControlCharacters("a\rb", { insideBracketedPaste: true })).toBe("a\rb");
  });

  it("returns the same string when there is nothing to neutralize", () => {
    const plain = "select the pricing card";
    expect(neutralizeControlCharacters(plain)).toBe(plain);
  });

  it("carries multi-line paste bodies through the wrapper unbroken", () => {
    // `performSubmit` converts newlines to `\r` before wrapping; neutralisation
    // must not eat the separators that conversion exists to produce.
    const wrapped = formatWithBracketedPaste("one\rtwo\rthree");
    const body = wrapped.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
    expect(body).toBe("one\rtwo\rthree");
  });
});

describe("formatForTerminalPaste", () => {
  const ESC = String.fromCharCode(0x1b);
  const ETX = String.fromCharCode(0x03);
  const DEL = String.fromCharCode(0x7f);
  const unwrapped = { bracketedPasteMode: false };
  const wrapped = { bracketedPasteMode: true };

  describe("unwrapped", () => {
    it("passes through text with nothing to fold or neutralize", () => {
      expect(formatForTerminalPaste("", unwrapped)).toBe("");
      expect(formatForTerminalPaste("npm run dev", unwrapped)).toBe("npm run dev");
    });

    it("keeps a tab, which is indentation rather than an action", () => {
      expect(formatForTerminalPaste("a\tb", unwrapped)).toBe("a\tb");
    });

    it("submits each line for every line ending in use", () => {
      // The reason the fold runs before neutralisation: a bare CR is a line
      // ending here, not an action character, so it has to survive as one.
      expect(formatForTerminalPaste("one\ntwo", unwrapped)).toBe("one\rtwo");
      expect(formatForTerminalPaste("one\r\ntwo", unwrapped)).toBe("one\rtwo");
      expect(formatForTerminalPaste("one\rtwo", unwrapped)).toBe("one\rtwo");
    });

    it("folds a mixture of line endings to one CR each", () => {
      expect(formatForTerminalPaste("one\r\ntwo\rthree\nfour", unwrapped)).toBe(
        "one\rtwo\rthree\rfour"
      );
    });

    it("preserves blank lines and edge newlines rather than trimming them", () => {
      // A dropped trailing newline is a command that does not run; an added one
      // is a command that runs twice.
      expect(formatForTerminalPaste("\na\n\nb\n", unwrapped)).toBe("\ra\r\rb\r");
    });

    it("neutralizes the control characters around the line structure", () => {
      const safe = formatForTerminalPaste(`ls${ESC}[201~${ETX}\nrm${DEL}`, unwrapped);

      expect(safe).toBe("ls␛[201~␃\rrm␡");
      expect(safe).not.toContain(ESC);
      expect(safe).not.toContain(ETX);
    });

    it("adds no wrapper, whatever the length", () => {
      const long = "x".repeat(PASTE_THRESHOLD_CHARS + 1);

      expect(formatForTerminalPaste(long, unwrapped)).toBe(long);
      expect(formatForTerminalPaste(long, unwrapped)).not.toContain(ESC);
    });
  });

  describe("wrapped", () => {
    it("produces the same bytes as the wrapper it delegates to", () => {
      expect(formatForTerminalPaste("hello", wrapped)).toBe(formatWithBracketedPaste("hello"));
      expect(formatForTerminalPaste("", wrapped)).toBe(
        `${BRACKETED_PASTE_START}${BRACKETED_PASTE_END}`
      );
    });

    it("leaves the caller's line endings alone inside the wrapper", () => {
      // Unwrapped, these become submits. Wrapped, `\r` is the separator the
      // program reads as data, so the mode has to decide and not the caller.
      const out = formatForTerminalPaste("one\r\ntwo\rthree\nfour", wrapped);
      const body = out.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);

      expect(body).toBe("one\r\ntwo\rthree\nfour");
    });

    it("neutralizes an embedded terminator so the wrapper cannot be escaped", () => {
      const out = formatForTerminalPaste(`before${BRACKETED_PASTE_END}${ETX}after`, wrapped);

      expect(out.split(BRACKETED_PASTE_END).length - 1).toBe(1);
      expect(out.endsWith(BRACKETED_PASTE_END)).toBe(true);
      const body = out.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
      expect(body).not.toContain(ESC);
      expect(body).not.toContain(ETX);
      expect(body).toContain("before");
      expect(body).toContain("after");
    });
  });
});
