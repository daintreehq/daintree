import { describe, expect, it } from "vitest";
import { cursorMatches, decodeMessageCursor, encodeMessageCursor } from "../ClaudeMessageCursor.js";
import { LAST_MESSAGE_CURSOR_MAX_CHARS } from "../../../../shared/types/agentLastMessage.js";

const encoded = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

describe("ClaudeMessageCursor", () => {
  it("round-trips the message it was minted from", () => {
    const text = "Opening. Middle. End.";
    const cursor = decodeMessageCursor(encodeMessageCursor("msg_1", text, 9));

    expect(cursor?.end).toBe(9);
    expect(cursorMatches(cursor!, "msg_1", text)).toBe(true);
  });

  // An id escapes to up to six bytes a character, so a cursor carrying it
  // verbatim could outgrow the length the tool's own argument check accepts.
  it("stays short however long or oddly encoded the id is", () => {
    // Longer than anything within the reader's 8 MiB ceiling, for the most digits `end` can have.
    const text = "x".repeat(9_999_999);
    for (const id of ["漢".repeat(256), "\ud800".repeat(256), "\u0001".repeat(256), "m"]) {
      const value = encodeMessageCursor(id, text, text.length);
      const cursor = decodeMessageCursor(value);

      expect(value.length).toBeLessThanOrEqual(LAST_MESSAGE_CURSOR_MAX_CHARS);
      expect(cursorMatches(cursor!, id, text)).toBe(true);
    }
  });

  it("still matches once more of the message has been written after the boundary", () => {
    const cursor = decodeMessageCursor(encodeMessageCursor("msg_1", "Opening. Middle.", 9))!;

    expect(cursorMatches(cursor, "msg_1", "Opening. Middle. And a later block.")).toBe(true);
  });

  it("matches neither another id nor text that differs before the boundary", () => {
    const cursor = decodeMessageCursor(encodeMessageCursor("msg_1", "Opening. Middle.", 9))!;

    expect(cursorMatches(cursor, "msg_2", "Opening. Middle.")).toBe(false);
    expect(cursorMatches(cursor, "msg_1", "Openinh. Middle.")).toBe(false);
    expect(cursorMatches(cursor, "msg_1", "Open")).toBe(false);
  });

  // UTF-8 would turn both lone surrogates into the same replacement character.
  it("tells lone surrogates apart", () => {
    const cursor = decodeMessageCursor(encodeMessageCursor(null, "a\ud800b", 3))!;

    expect(cursor.id).toBeNull();
    expect(cursorMatches(cursor, null, "a\ud800b")).toBe(true);
    expect(cursorMatches(cursor, null, "a\ud801b")).toBe(false);
    expect(cursorMatches(cursor, "msg_1", "a\ud800b")).toBe(false);
    const named = decodeMessageCursor(encodeMessageCursor("msg_1", "a\ud800b", 3))!;
    expect(cursorMatches(named, null, "a\ud800b")).toBe(false);
  });

  it("refuses anything it could not have minted", () => {
    const h = "A".repeat(16);
    const id = "B".repeat(16);
    expect(decodeMessageCursor(encoded({ v: 1, id, end: 1, h }))).toEqual({
      id,
      end: 1,
      digest: h,
    });
    const minted = encodeMessageCursor("msg_1", "Opening. Middle.", 9);
    for (const value of [
      "",
      "not a cursor!",
      `${minted}A`,
      encoded({ v: 1, id, end: 1, h, extra: true }),
      encoded({ id, v: 1, end: 1, h }),
      "x".repeat(LAST_MESSAGE_CURSOR_MAX_CHARS + 1),
      encoded([1, 2]),
      encoded({ v: 2, id, end: 1, h }),
      encoded({ v: 1, id: "msg_1", end: 1, h }),
      encoded({ v: 1, id: 7, end: 1, h }),
      encoded({ v: 1, id, end: 0, h }),
      encoded({ v: 1, id, end: 1.5, h }),
      encoded({ v: 1, id, end: "1", h }),
      encoded({ v: 1, id, end: 1, h: "short" }),
      encoded({ v: 1, id, end: 1, h: "!".repeat(16) }),
    ]) {
      expect(decodeMessageCursor(value)).toBeNull();
    }
  });
});
