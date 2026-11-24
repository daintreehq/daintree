import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  asciiOnlyChunksPlugin,
  asciiOnlyOutputPlugin,
  escapeChunkToAscii,
  hasTwoByteCharacters,
} from "./ascii-only-chunks.mjs";

// A minified-looking script that exercises every place a non-ASCII character
// can sit: strings, untagged and tagged templates, regex literals with and
// without the u flag or an identity escape, an astral character, and Latin-1
// that must stay as is.
const SOURCE = [
  'var a="Run an action first — there\'s nothing to repeat",',
  "b=`Write a note…`,",
  "c=/[─│]/.test(`│`),",
  "d=/^\\p{L}é😀$/u.test(`xé😀`),",
  "e=String.raw`→${1}`,",
  'f="café",',
  "g=`😀`.length,",
  "h=/[\\p{L}--[a-z]]/v.test(`é`)&&!/[\\p{L}--[a-z]]/v.test(`a`),",
  "i=/^[😀-😂]$/u.test(`😁`),",
  "j=/^\\—[\\—x]$/.test(`——`);",
  "globalThis.__out=[a,b,c,d,e,f,g,h,i,j];",
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

  it("draws the line between U+00FF and U+0100", () => {
    expect(hasTwoByteCharacters("\u00ff")).toBe(false);
    expect(hasTwoByteCharacters("\u0100")).toBe(true);
  });
});

describe("escapeChunkToAscii", () => {
  const escaped = escapeChunkToAscii("chunk.js", SOURCE);

  it("produces the same runtime values as the original", () => {
    const original = run(SOURCE);
    // The regex cases must actually match, or equal outputs prove nothing.
    const [, , c, d, , , , h, i, j] = original;
    expect([c, d, h, i, j]).toEqual([true, true, true, true, true]);
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

  it("keeps legal comments, as written, only when asked to", () => {
    const code = 'var a="—";\n/*! @license MIT — Example */\n';
    expect(escapeChunkToAscii("chunk.js", code)).not.toContain("@license");
    const kept = escapeChunkToAscii("chunk.js", code, { legalComments: "inline" });
    expect(kept).toContain("/*! @license MIT — Example */");
    expect(kept).toContain("\\u2014");
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

describe("asciiOnlyOutputPlugin", () => {
  let dir;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ascii-only-output-")));
    fs.writeFileSync(
      path.join(dir, "wide.js"),
      [
        'import note from "./note.txt";',
        'export const dash = /^[—–]$/u.test("—"), raw = String.raw`→`, latin = "café", file = note;',
        "/*! @license MIT (c) Example */",
      ].join("\n")
    );
    fs.writeFileSync(path.join(dir, "narrow.js"), 'export const latin = /^[é]$/u.test("é");\n');
    fs.writeFileSync(path.join(dir, "note.txt"), "a — b");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const options = (extra) => ({
    absWorkingDir: dir,
    entryPoints: ["wide.js", "narrow.js"],
    outdir: "out",
    bundle: true,
    format: "esm",
    minify: true,
    loader: { ".txt": "file" },
    metafile: true,
    logLevel: "silent",
    ...extra,
  });
  const byName = (result) =>
    new Map(
      result.outputFiles.map((file) => [
        path.relative(dir, file.path).split(path.sep).join("/"),
        file,
      ])
    );
  const run = (code) =>
    import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

  it("re-prints only the JS outputs that would load as two-byte, keeping what they do", async () => {
    const plain = byName(await build(options({ write: false })));
    const result = await build(options({ write: false, plugins: [asciiOnlyOutputPlugin()] }));
    const escaped = byName(result);

    // esbuild alone leaves the regex literal's glyphs as written.
    expect(hasTwoByteCharacters(plain.get("out/wide.js").text.replace("String.raw`→`", ""))).toBe(
      true
    );
    const wide = escaped.get("out/wide.js");
    expect(wide.text).toContain("String.raw`→`");
    expect(wide.text).toContain("/*! @license MIT (c) Example */");
    expect(hasTwoByteCharacters(wide.text.replace("String.raw`→`", ""))).toBe(false);
    expect(await run(wide.text)).toEqual(await run(plain.get("out/wide.js").text));

    // What a caller reads agrees with the metafile.
    expect(wide.hash).not.toBe(plain.get("out/wide.js").hash);
    expect(result.metafile.outputs["out/wide.js"].bytes).toBe(wide.contents.byteLength);

    for (const [name, file] of plain) {
      if (name === "out/wide.js") continue;
      expect(escaped.get(name).contents, name).toEqual(file.contents);
    }
    expect([...escaped.keys()].some((name) => name.endsWith(".txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
  });

  it("writes the escaped outputs when the build writes", async () => {
    const result = await build(options({ plugins: [asciiOnlyOutputPlugin()] }));

    for (const file of result.outputFiles) {
      expect(fs.readFileSync(file.path), file.path).toEqual(Buffer.from(file.contents));
    }
    const wide = fs.readFileSync(path.join(dir, "out/wide.js"), "utf8");
    expect(wide).toContain("String.raw`→`");
    expect(hasTwoByteCharacters(wide.replace("String.raw`→`", ""))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "out/narrow.js"), "utf8")).toContain("é");
  });

  it("updates metadata when the working directory is a symbolic link", async () => {
    const source = path.join(dir, "source");
    const linked = path.join(dir, "linked");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "wide.js"), 'export const dash = /—/.test("—");');
    fs.symlinkSync(source, linked, process.platform === "win32" ? "junction" : "dir");

    const result = await build(
      options({
        absWorkingDir: linked,
        entryPoints: ["wide.js"],
        write: false,
        plugins: [asciiOnlyOutputPlugin()],
      })
    );
    const wide = result.outputFiles.find((file) => file.path.endsWith("wide.js"));
    expect(hasTwoByteCharacters(wide.text)).toBe(false);
    expect(result.metafile.outputs["out/wide.js"].bytes).toBe(wide.contents.byteLength);
  });

  it("fails the build, writing nothing, when a chunk cannot be re-printed", async () => {
    // Runs before the pass and hands it a chunk the printer rejects.
    const corrupt = {
      name: "corrupt",
      setup(build) {
        build.onEnd((result) => {
          const wide = result.outputFiles?.find((file) => file.path.endsWith("wide.js"));
          if (wide) wide.contents = new TextEncoder().encode("var a = `—");
        });
      },
    };

    await expect(build(options({ plugins: [corrupt, asciiOnlyOutputPlugin()] }))).rejects.toThrow(
      /wide\.js/
    );
    expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
  });
});
