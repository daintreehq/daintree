import { describe, expect, it } from "vitest";
import vm from "node:vm";
import {
  asciiOnlyChunksPlugin,
  escapeChunkToAscii,
  hasTwoByteCharacters,
} from "./ascii-only-chunks.mjs";

// A minified-looking script that exercises every place a non-ASCII character
// can sit: strings, untagged and tagged templates, regex literals with and
// without the u flag, an astral character, and Latin-1 that must stay as is.
const SOURCE = [
  'var a="Run an action first — there\'s nothing to repeat",',
  "b=`Write a note…`,",
  "c=/[─│]/.test(`│`),",
  "d=/^\\p{L}é😀$/u.test(`é😀`.replace(/^/,`x`).slice(1)),",
  "e=String.raw`→${1}`,",
  'f="café",',
  "g=`😀`.length,",
  "h=/[\\p{L}--[a-z]]/v.test(`é`)&&!/[\\p{L}--[a-z]]/v.test(`a`),",
  "i=/^[😀-😂]$/u.test(`😁`);",
  "globalThis.__out=[a,b,c,d,e,f,g,h,i];",
].join("");

function run(code) {
  const context = vm.createContext({});
  vm.runInContext(code.replace("globalThis.__out", "this.__out"), context);
  return context.__out;
}

describe("hasTwoByteCharacters", () => {
  it("is false for ASCII and Latin-1, true above U+00FF", () => {
    expect(hasTwoByteCharacters("plain ascii")).toBe(false);
    expect(hasTwoByteCharacters("café ñ")).toBe(false);
    expect(hasTwoByteCharacters("a — b")).toBe(true);
  });
});

describe("escapeChunkToAscii", () => {
  const escaped = escapeChunkToAscii("chunk.js", SOURCE);

  it("produces the same runtime values as the original", () => {
    const original = run(SOURCE);
    // The regex cases must actually match, or equal outputs prove nothing.
    expect(original.slice(-2)).toEqual([true, true]);
    expect(run(escaped)).toEqual(original);
  });

  it("leaves no two-byte character outside tagged template quasis", () => {
    const withoutRawQuasi = escaped.replace(/String\.raw`[^`]*`/, "");
    expect(hasTwoByteCharacters(withoutRawQuasi)).toBe(false);
  });

  it("keeps a tagged template's raw text as written", () => {
    expect(escaped).toContain("String.raw`→${1}`");
  });

  it("reports a chunk it cannot parse instead of emitting it", () => {
    expect(() => escapeChunkToAscii("broken.js", "var a = `—")).toThrow(/broken\.js/);
  });
});

describe("asciiOnlyChunksPlugin", () => {
  it("re-prints only chunks that would load as two-byte", () => {
    const bundle = {
      "wide.js": { type: "chunk", fileName: "wide.js", code: 'export const a="—";' },
      "narrow.js": { type: "chunk", fileName: "narrow.js", code: 'export const a = "café";' },
      "style.css": { type: "asset", fileName: "style.css", source: "a{content:'—'}" },
    };
    asciiOnlyChunksPlugin().generateBundle.handler({}, bundle);
    expect(bundle["wide.js"].code).toContain("\\u2014");
    expect(hasTwoByteCharacters(bundle["wide.js"].code)).toBe(false);
    expect(bundle["narrow.js"].code).toBe('export const a = "café";');
    expect(bundle["style.css"].source).toBe("a{content:'—'}");
  });
});
