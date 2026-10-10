import { describe, expect, it } from "vitest";
import { isTerminalSubmission, terminalAnswerOf } from "../terminalSubmission.js";

describe("isTerminalSubmission", () => {
  it("is Return pressed at the end of what was typed", () => {
    expect(isTerminalSubmission("\r")).toBe(true);
    expect(isTerminalSubmission("yes\r")).toBe(true);
  });

  it("is never a newline inside pasted text, however it ends", () => {
    expect(isTerminalSubmission("\x1b[200~line one\rline two\r\x1b[201~")).toBe(false);
    expect(isTerminalSubmission("\x1b[200~one\r\x1b[201~\r")).toBe(false);
  });

  it("is not a keystroke that leaves the line open", () => {
    expect(isTerminalSubmission("y")).toBe(false);
    expect(isTerminalSubmission("one\rtwo")).toBe(false);
  });
});

describe("terminalAnswerOf", () => {
  it("is a submission for Return, alone or ending a typed line", () => {
    expect(terminalAnswerOf("\r")).toBe("submit");
    expect(terminalAnswerOf("blue\r")).toBe("submit");
  });

  it("is not a submission for the soft newlines agents take for Shift+Enter", () => {
    expect(terminalAnswerOf("\n")).toBeNull();
    expect(terminalAnswerOf("\x1b\r")).toBeNull();
  });

  it("is a key for the single keys that answer an approval menu", () => {
    for (const key of ["1", "9", "y", "N", "a", "\x1b"]) expect(terminalAnswerOf(key)).toBe("key");
  });

  it("is nothing for menu movement, typing, pastes and terminal reports", () => {
    for (const data of ["\x1b[A", "\t", "x", "ok", "\x1b[200~1\x1b[201~", "\x1b_Gi=1;OK\x1b\\"]) {
      expect(terminalAnswerOf(data)).toBeNull();
    }
  });
});
