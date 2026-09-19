import { describe, expect, it } from "vitest";
import { parseLastMessageReadArgs } from "../lastMessageArgs.js";
import { encodeMessageCursor } from "../../claude/ClaudeMessageCursor.js";

const CURSOR = encodeMessageCursor("msg_1", "Some text before the page.", 10);

describe("parseLastMessageReadArgs (#12496)", () => {
  it("asks for nothing beyond the default when only the id was sent", () => {
    expect(parseLastMessageReadArgs({ terminalId: "t-1" })).toEqual({ ok: true, options: {} });
    expect(parseLastMessageReadArgs(undefined)).toEqual({ ok: true, options: {} });
  });

  it("carries the three read options and nothing else the caller sent", () => {
    expect(
      parseLastMessageReadArgs({
        terminalId: "t-1",
        maxBytes: 49152,
        messageIndex: 3,
        sessionId: "someone-elses",
        maxScanBytes: 1e9,
      })
    ).toEqual({ ok: true, options: { maxBytes: 49152, messageIndex: 3 } });
    expect(parseLastMessageReadArgs({ terminalId: "t-1", cursor: CURSOR })).toEqual({
      ok: true,
      options: { cursor: CURSOR },
    });
  });

  it("refuses a size outside the range rather than clamping it", () => {
    for (const maxBytes of [1023, 49153, 2048.5, "4096", null]) {
      const parsed = parseLastMessageReadArgs({ terminalId: "t-1", maxBytes });
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.message).toContain("maxBytes");
    }
  });

  it("refuses an index outside the range", () => {
    for (const messageIndex of [-1, 21, 0.5, "1"]) {
      expect(parseLastMessageReadArgs({ terminalId: "t-1", messageIndex }).ok).toBe(false);
    }
  });

  // Whatever id the transcript carried, a cursor the tool handed out has to
  // pass the tool's own check when it comes back unchanged.
  it("accepts every cursor the reader mints", () => {
    const text = "y".repeat(8_000_000);
    for (const id of [null, "msg_1", "漢".repeat(256), "\ud800".repeat(256)]) {
      const cursor = encodeMessageCursor(id, text, text.length - 1);

      expect(parseLastMessageReadArgs({ terminalId: "t-1", cursor })).toEqual({
        ok: true,
        options: { cursor },
      });
    }
  });

  it("refuses a cursor it did not mint", () => {
    for (const cursor of ["", "garbage", 42]) {
      const parsed = parseLastMessageReadArgs({ terminalId: "t-1", cursor });
      expect(parsed.ok ? "" : parsed.message).toContain("nextCursor");
    }
  });

  it("refuses a cursor and an index together", () => {
    const parsed = parseLastMessageReadArgs({ terminalId: "t-1", cursor: CURSOR, messageIndex: 0 });

    expect(parsed.ok ? "" : parsed.message).toContain("not both");
  });

  it("reads only the call's own properties", () => {
    const inherited = Object.create({ maxBytes: 1 }) as Record<string, unknown>;
    inherited.terminalId = "t-1";

    expect(parseLastMessageReadArgs(inherited)).toEqual({ ok: true, options: {} });
  });
});
