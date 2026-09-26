import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { contentRevision, parseJsonl, stringifyJsonlLine } from "../data.js";

describe("parseJsonl", () => {
  it("parses records, skips blank lines and accepts CRLF", () => {
    const text = '{"a":1}\r\n\n  \n[2]\n"three"\n';
    expect(parseJsonl(text)).toEqual({ records: [{ a: 1 }, [2], "three"], errors: [] });
  });

  it("collects a bad line with its number and text instead of throwing", () => {
    const { records, errors } = parseJsonl('{"a":1}\n{oops}\n{"b":2}\n');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 2, text: "{oops}" });
    expect(errors[0].message).not.toMatch(/truncated/);
  });

  it("reports an unterminated, unparseable final line as truncated", () => {
    const { records, errors } = parseJsonl('{"a":1}\n{"b":');
    expect(records).toEqual([{ a: 1 }]);
    expect(errors).toEqual([
      expect.objectContaining({
        line: 2,
        text: '{"b":',
        message: expect.stringMatching(/^truncated/),
      }),
    ]);
  });

  it("accepts a complete final record without a line break", () => {
    expect(parseJsonl('{"a":1}\n{"b":2}')).toEqual({ records: [{ a: 1 }, { b: 2 }], errors: [] });
  });

  it("ignores a leading byte order mark", () => {
    expect(parseJsonl('\uFEFF{"a":1}\n').records).toEqual([{ a: 1 }]);
  });
});

describe("stringifyJsonlLine", () => {
  it("writes one line even when a string holds line breaks", () => {
    const line = stringifyJsonlLine({ note: "two\nlines" });
    expect(line).toBe('{"note":"two\\nlines"}\n');
    expect(parseJsonl(line + line).records).toEqual([
      { note: "two\nlines" },
      { note: "two\nlines" },
    ]);
  });

  it("refuses a value JSON cannot represent", () => {
    expect(() => stringifyJsonlLine(undefined)).toThrow(TypeError);
  });
});

describe("contentRevision", () => {
  // The host's `sha256Hex` in PluginHostFactory: node:crypto over the bytes
  // written, with the text encoded as UTF-8.
  const hostRevision = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  it("matches the host's revision for text, as its UTF-8 bytes", async () => {
    const text = "---\nname: Zoë 🚀\n---\n";
    expect(await contentRevision(text)).toBe(hostRevision(Buffer.from(text, "utf-8")));
  });

  it("hashes raw bytes exactly, including ones UTF-8 decoding would change", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x0a]);
    expect(await contentRevision(bytes)).toBe(hostRevision(bytes));
  });

  it("hashes a view into a larger buffer by its own bytes only", async () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = backing.subarray(2, 4);
    expect(await contentRevision(view)).toBe(hostRevision(new Uint8Array([3, 4])));
  });

  it("is the lowercase 64-character hex writeFile accepts as expectedRevision", async () => {
    expect(await contentRevision("")).toMatch(/^[0-9a-f]{64}$/);
  });
});
