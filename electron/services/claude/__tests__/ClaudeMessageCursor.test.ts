import { describe, expect, it } from "vitest";
import { cursorMatches, decodeMessageCursor, encodeMessageCursor } from "../ClaudeMessageCursor.js";

const encoded = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

describe("ClaudeMessageCursor", () => {
  it("round-trips the message it was minted from", () => {
    const text = "Opening. Middle. End.";
    const cursor = decodeMessageCursor(encodeMessageCursor("msg_1", text, 9));

    expect(cursor).toMatchObject({ id: "msg_1", end: 9 });
    expect(cursorMatches(cursor!, "msg_1", text)).toBe(true);
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
  });

  it("refuses anything it could not have minted", () => {
    const h = "A".repeat(16);
    for (const value of [
      "",
      "not a cursor!",
      "x".repeat(2000),
      encoded([1, 2]),
      encoded({ v: 2, id: "m", end: 1, h }),
      encoded({ v: 1, id: "", end: 1, h }),
      encoded({ v: 1, id: 7, end: 1, h }),
      encoded({ v: 1, id: "m".repeat(257), end: 1, h }),
      encoded({ v: 1, id: "m", end: 0, h }),
      encoded({ v: 1, id: "m", end: 1.5, h }),
      encoded({ v: 1, id: "m", end: "1", h }),
      encoded({ v: 1, id: "m", end: 1, h: "short" }),
      encoded({ v: 1, id: "m", end: 1, h: "!".repeat(16) }),
    ]) {
      expect(decodeMessageCursor(value)).toBeNull();
    }
  });
});
