import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildTerminalSendPayload,
} from "../terminalInput";

describe("buildTerminalSendPayload", () => {
  it("sends single-line input with CR", () => {
    const payload = buildTerminalSendPayload("echo hi");
    expect(payload.usedBracketedPaste).toBe(false);
    expect(payload.data).toBe("echo hi\r");
    expect(payload.trackerData).toBe("echo hi\r");
  });

  it("normalizes CRLF and uses bracketed paste for multiline", () => {
    const payload = buildTerminalSendPayload("line1\r\nline2");
    expect(payload.usedBracketedPaste).toBe(true);
    expect(payload.data).toBe(`${BRACKETED_PASTE_START}line1\nline2${BRACKETED_PASTE_END}\r`);
    expect(payload.trackerData).toBe("line1\nline2\r");
  });

  it("uses bracketed paste for large single-line sends", () => {
    const payload = buildTerminalSendPayload("a".repeat(201), { pasteThresholdChars: 200 });
    expect(payload.usedBracketedPaste).toBe(true);
    expect(payload.data.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(payload.data.endsWith(`${BRACKETED_PASTE_END}\r`)).toBe(true);
  });
});
