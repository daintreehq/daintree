import { describe, expect, it } from "vitest";
import {
  assembleDocument,
  decodeDocument,
  detectEol,
  encodeDocument,
  hasUtf8Bom,
  sha256Hex,
} from "../documentCodec.js";

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "utf-8"));
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const withBom = (text: string) => new Uint8Array([...BOM, ...bytes(text)]);

/** Decode then re-encode unchanged: the round trip the unedited save relies on. */
function roundTrip(input: Uint8Array): Uint8Array {
  const decoded = decodeDocument(input);
  if (!decoded.ok) throw new Error(decoded.reason);
  return encodeDocument(decoded.document.text, decoded.document);
}

describe("documentCodec (#12323)", () => {
  describe("byte round trip", () => {
    it.each([
      ["LF", "# Title\n\nBody\n"],
      ["CRLF", "# Title\r\n\r\nBody\r\n"],
      ["no final newline", "# Title\n\nBody"],
      ["empty file", ""],
      ["single line without newline", "x"],
      ["unicode", "Δoc — naïve café 🌲\n"],
      ["trailing blank lines", "a\n\n\n"],
    ])("%s round-trips byte-identically", (_label, text) => {
      const input = bytes(text);
      expect(Buffer.from(roundTrip(input)).equals(Buffer.from(input))).toBe(true);
    });

    it("preserves a UTF-8 BOM and strips it from the editor text", () => {
      const input = withBom("# Hi\n");
      const decoded = decodeDocument(input);
      expect(decoded.ok && decoded.document.hasBom).toBe(true);
      expect(decoded.ok && decoded.document.text).toBe("# Hi\n");
      expect(Buffer.from(roundTrip(input)).equals(Buffer.from(input))).toBe(true);
    });

    it("stores CRLF files as \\n lines and re-applies CRLF on encode", () => {
      const decoded = decodeDocument(bytes("a\r\nb\r\n"));
      expect(decoded.ok && decoded.document.text).toBe("a\nb\n");
      expect(decoded.ok && decoded.document.eol).toBe("\r\n");
      expect(assembleDocument("a\nb\nc\n", { hasBom: false, eol: "\r\n" })).toBe("a\r\nb\r\nc\r\n");
    });

    it("a one-word edit changes exactly the edited line's bytes", () => {
      const original = "line one\nline two\nline three\n";
      const decoded = decodeDocument(bytes(original));
      if (!decoded.ok) throw new Error("decode failed");
      const edited = encodeDocument("line one\nline 2\nline three\n", decoded.document);
      const before = Buffer.from(edited).toString("utf-8").split("\n");
      expect(before).toEqual(["line one", "line 2", "line three", ""]);
    });
  });

  describe("line endings", () => {
    it("detects the dominant ending and flags a mix", () => {
      expect(detectEol("a\nb\nc\r\n")).toEqual({ eol: "\n", mixedEol: true });
      expect(detectEol("a\r\nb\r\nc\n")).toEqual({ eol: "\r\n", mixedEol: true });
      expect(detectEol("a\r\nb\r\n")).toEqual({ eol: "\r\n", mixedEol: false });
      expect(detectEol("no newline")).toEqual({ eol: "\n", mixedEol: false });
    });

    it("a tie falls to LF", () => {
      expect(detectEol("a\r\nb\n")).toEqual({ eol: "\n", mixedEol: true });
    });

    it("normalises a mixed file to its dominant ending only when re-encoded", () => {
      const mixed = bytes("a\r\nb\r\nc\n");
      const decoded = decodeDocument(mixed);
      if (!decoded.ok) throw new Error("decode failed");
      expect(decoded.document.mixedEol).toBe(true);
      // Re-encoding the unchanged text is NOT byte-identical for a mixed
      // file — which is exactly why the unedited-save short circuit compares
      // text, never assembled bytes.
      const reencoded = Buffer.from(encodeDocument(decoded.document.text, decoded.document));
      expect(reencoded.toString("utf-8")).toBe("a\r\nb\r\nc\r\n");
    });
  });

  describe("decoding", () => {
    it("refuses bytes that are not strict UTF-8 rather than replacing them", () => {
      const invalid = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]);
      expect(decodeDocument(invalid)).toEqual({ ok: false, reason: "NOT_UTF8" });
    });

    it("hashes the bytes as read, BOM included", () => {
      const input = withBom("x\n");
      const decoded = decodeDocument(input);
      expect(decoded.ok && decoded.document.revision).toBe(sha256Hex(input));
      expect(decoded.ok && decoded.document.size).toBe(input.length);
    });

    it("hasUtf8Bom only matches the full three-byte mark", () => {
      expect(hasUtf8Bom(BOM)).toBe(true);
      expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb]))).toBe(false);
      expect(hasUtf8Bom(bytes("plain"))).toBe(false);
    });
  });
});
