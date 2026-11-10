import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { build, type Metafile } from "esbuild";
import { mainEsmConfig } from "../build-main.mjs";
import { collectClosure } from "../first-render-closure-lib.mjs";
import { findEscapableTwoByteCharacters } from "../lib/ascii-only-chunks.mjs";

// V8 keeps a script's source at one byte per character only while every
// character is at or below U+00FF. esbuild escapes string literals but writes
// regex literals as they are, so one em dash in a regex makes a chunk Main
// loads at startup cost twice its length in heap for the life of the process
// (#16682). This builds what a production scripts/build-main.mjs run builds and
// reads the chunks Main loads before anything is imported dynamically.
const root = path.resolve(__dirname, "../..");

// The app's entry (package.json "main") and the module it loads Main from.
const MAIN_ENTRIES = ["electron/bootstrap.ts", "electron/main.ts"];
// Below this, a two-byte chunk costs too little to be worth unreadable escapes
// in terminal glyph matchers; above it, the cost is at least 256 KB.
const GUARDED_LENGTH = 256 * 1024;
const HESITATIONS = "shared/utils/voiceHesitations.ts";
const HINT =
  "write each character above U+00FF in a regex literal as a \\u escape in its source, as shared/utils/voiceHesitations.ts does; one in a kept /*! */ comment has to go";

const normalize = (file: string) => file.split(path.sep).join("/");

interface Output {
  metafile: Metafile;
  code: Map<string, string>;
}

function textOf({ code }: Output, output: string): string {
  const text = code.get(normalize(output));
  if (text === undefined) throw new Error(`The build emitted no text for ${output}`);
  return text;
}

/** Every output the entries load through static imports alone. */
function staticClosure({ metafile }: Output, entries: string[]): string[] {
  const wanted = new Set(entries);
  const seeds = Object.entries(metafile.outputs)
    .filter(([, meta]) => meta.entryPoint && wanted.has(normalize(meta.entryPoint)))
    .map(([output]) => output);
  if (seeds.length !== entries.length) {
    throw new Error(`Expected an output for each of ${entries.join(", ")}`);
  }
  return [
    ...collectClosure(seeds, {
      getNode: (output: string) => {
        const meta = metafile.outputs[output];
        if (!meta) throw new Error(`An import names ${output}, which the build did not emit`);
        return meta;
      },
      getStaticImports: (meta: Metafile["outputs"][string]) =>
        meta.imports
          .filter((edge) => !edge.external && edge.kind === "import-statement")
          .map((edge) => edge.path),
      getDynamicImports: () => [],
    }),
  ];
}

/** One line per wide character, with enough of the chunk around it to find its source. */
function describeAt(out: Output, output: string, offsets: number[]): string[] {
  const text = textOf(out, output);
  return offsets.map((offset) => {
    const unit = text.charCodeAt(offset).toString(16).toUpperCase().padStart(4, "0");
    const context = text.slice(Math.max(0, offset - 40), offset + 20);
    return `${output} (${text.length} chars): U+${unit} at ${offset} in ${JSON.stringify(context)}`;
  });
}

/** Escapable wide characters in each chunk of at least `guardedLength` the entries load statically. */
function largeChunkOffenders(out: Output, entries: string[], guardedLength: number) {
  const guarded = staticClosure(out, entries).filter(
    (output) => output.endsWith(".js") && textOf(out, output).length >= guardedLength
  );
  const offenders = guarded.flatMap((output) =>
    describeAt(out, output, findEscapableTwoByteCharacters(output, textOf(out, output)))
  );
  return { guarded, offenders };
}

/** Every wide character, tagged templates included, in each output carrying `input`. */
function carrierOffenders(out: Output, input: string) {
  const carriers = Object.entries(out.metafile.outputs)
    .filter(([, meta]) =>
      Object.entries(meta.inputs).some(
        ([file, contribution]) => normalize(file) === input && contribution.bytesInOutput > 0
      )
    )
    .map(([output]) => output);
  const offenders = carriers.flatMap((output) => {
    const text = textOf(out, output);
    const offsets: number[] = [];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) offsets.push(i);
    return describeAt(out, output, offsets);
  });
  return { carriers, offenders };
}

describe("the startup chunk checks", () => {
  // A hand-made build: an entry that statically imports a large chunk, a small
  // one and a carrier of the hesitation filter, and dynamically imports another.
  const fixture = (): Output => {
    const outputs: Record<string, { code: string; meta: Partial<Metafile["outputs"][string]> }> = {
      "out/entry.js": {
        code: "import'./large.js';import'./small.js';import'./carrier.js';import('./lazy.js');",
        meta: {
          entryPoint: "entry.ts",
          imports: [
            { path: "out/large.js", kind: "import-statement" },
            { path: "out/small.js", kind: "import-statement" },
            { path: "out/carrier.js", kind: "import-statement" },
            { path: "out/lazy.js", kind: "dynamic-import" },
          ],
        },
      },
      "out/large.js": { code: "var a=/[—]/u,b=String.raw`→`;", meta: {} },
      "out/small.js": { code: "var a=/[—]/u;", meta: {} },
      "out/lazy.js": { code: "var a=/[—]/u,b=String.raw`→`;", meta: {} },
      "out/carrier.js": {
        code: "var a=String.raw`→`;",
        meta: { inputs: { [HESITATIONS]: { bytesInOutput: 20 } } },
      },
    };
    const metafile = {
      inputs: {},
      outputs: Object.fromEntries(
        Object.entries(outputs).map(([output, { meta }]) => [
          output,
          { bytes: 0, inputs: {}, imports: [], exports: [], ...meta },
        ])
      ),
    } as unknown as Metafile;
    const code = new Map(Object.entries(outputs).map(([output, { code }]) => [output, code]));
    return { metafile, code };
  };

  it("reports an escapable wide character only in a large chunk loaded statically", () => {
    const { guarded, offenders } = largeChunkOffenders(fixture(), ["entry.ts"], 20);
    expect(guarded.sort()).toEqual(["out/carrier.js", "out/entry.js", "out/large.js"]);
    expect(offenders).toEqual([expect.stringMatching(/^out\/large\.js .*U\+2014 at 8 /)]);
  });

  it("reports even a tagged template's wide character in the carrier of an input", () => {
    const { carriers, offenders } = carrierOffenders(fixture(), HESITATIONS);
    expect(carriers).toEqual(["out/carrier.js"]);
    expect(offenders).toEqual([expect.stringMatching(/^out\/carrier\.js .*U\+2192 at 17 /)]);
  });
});

describe("the production main build's startup chunks", () => {
  let out: Output;

  beforeAll(async () => {
    // Vitest runs with NODE_ENV=development, so production is named here.
    const result = await build({
      ...mainEsmConfig({ production: true }),
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    out = {
      metafile: result.metafile,
      code: new Map(
        result.outputFiles.map((file) => [normalize(path.relative(root, file.path)), file.text])
      ),
    };
  }, 180_000);

  it("leaves no escapable character above U+00FF in a large chunk", () => {
    const { guarded, offenders } = largeChunkOffenders(out, MAIN_ENTRIES, GUARDED_LENGTH);
    // Not a vacuous pass: Main's largest shared chunk is several times the threshold.
    expect(guarded.length).toBeGreaterThan(0);
    expect(offenders, HINT).toEqual([]);
  });

  it("keeps every chunk that carries the hesitation filter one byte per character", () => {
    const { carriers, offenders } = carrierOffenders(out, HESITATIONS);
    expect(carriers.length).toBeGreaterThan(0);
    expect(offenders, HINT).toEqual([]);
  });
});
