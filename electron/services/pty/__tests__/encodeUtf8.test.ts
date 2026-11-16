import { describe, it, expect } from "vitest";
import { encodeUtf8 } from "../encodeUtf8.js";

describe("encodeUtf8", () => {
  it.each([
    ["empty", ""],
    ["ascii", "plain \x1b[0m text\r\n"],
    ["two- and three-byte", "héllo │ ─ ⠋"],
    ["surrogate pair", "done 😀"],
    ["lone high surrogate", "a\ud83db"],
    ["lone low surrogate", "a\ude00b"],
    ["BOM", "﻿start"],
    ["growing the reusable buffer", "─".repeat(6_000)],
    ["growing it again", "😀".repeat(30_000)],
    ["at the largest it keeps", "─".repeat((256 * 1024) / 3 - 1)],
    ["past the reusable buffer", "─".repeat(100_000)],
  ])("encodes %s exactly as Buffer does", (_name, text) => {
    const encoded = encodeUtf8(text);
    expect(Buffer.from(encoded).equals(Buffer.from(text, "utf8"))).toBe(true);
    expect(encoded.byteLength).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("returns a standalone buffer that a later call does not overwrite", () => {
    const first = encodeUtf8("first chunk");
    const second = encodeUtf8("SECOND CHUNK, LONGER");

    expect(first.byteOffset).toBe(0);
    expect(first.byteLength).toBe(first.buffer.byteLength);
    expect(first.buffer).not.toBe(second.buffer);
    expect(new TextDecoder().decode(first)).toBe("first chunk");
  });
});
