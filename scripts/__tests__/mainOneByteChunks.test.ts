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
  "write each character above U+00FF in a regex literal as a \\u escape in its source, as shared/utils/voiceHesitations.ts does";

const normalize = (file: string) => file.split(path.sep).join("/");

describe("the production main build's startup chunks", () => {
  let metafile: Metafile;
  const code = new Map<string, string>();

  beforeAll(async () => {
    // Vitest runs with NODE_ENV=development, so production is named here.
    const result = await build({
      ...mainEsmConfig({ production: true }),
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    metafile = result.metafile;
    for (const file of result.outputFiles) {
      code.set(normalize(path.relative(root, file.path)), file.text);
    }
  }, 180_000);

  function textOf(output: string): string {
    const text = code.get(normalize(output));
    if (text === undefined) throw new Error(`The build emitted no text for ${output}`);
    return text;
  }

  /** Every output the Main entries load through static imports alone. */
  function staticClosure(): string[] {
    const entries = new Set(MAIN_ENTRIES);
    const seeds = Object.entries(metafile.outputs)
      .filter(([, meta]) => meta.entryPoint && entries.has(normalize(meta.entryPoint)))
      .map(([output]) => output);
    expect(seeds).toHaveLength(MAIN_ENTRIES.length);

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
  function describeAt(output: string, offsets: number[]): string[] {
    const text = textOf(output);
    return offsets.map((offset) => {
      const unit = text.charCodeAt(offset).toString(16).toUpperCase().padStart(4, "0");
      const context = text.slice(Math.max(0, offset - 40), offset + 20);
      return `${output} (${text.length} chars): U+${unit} at ${offset} in ${JSON.stringify(context)}`;
    });
  }

  it("leaves no escapable character above U+00FF in a large chunk", () => {
    const guarded = staticClosure().filter(
      (output) => output.endsWith(".js") && textOf(output).length >= GUARDED_LENGTH
    );
    // Not a vacuous pass: Main's largest shared chunk is several times the threshold.
    expect(guarded.length).toBeGreaterThan(0);

    const offenders = guarded.flatMap((output) =>
      describeAt(output, findEscapableTwoByteCharacters(output, textOf(output)))
    );
    expect(offenders, HINT).toEqual([]);
  });

  it("keeps every chunk that carries the hesitation filter one byte per character", () => {
    const carriers = Object.entries(metafile.outputs)
      .filter(([, meta]) =>
        Object.entries(meta.inputs).some(
          ([input, contribution]) =>
            normalize(input) === HESITATIONS && contribution.bytesInOutput > 0
        )
      )
      .map(([output]) => output);
    expect(carriers.length).toBeGreaterThan(0);

    const offenders = carriers.flatMap((output) => {
      const text = textOf(output);
      const offsets: number[] = [];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) offsets.push(i);
      return describeAt(output, offsets);
    });
    expect(offenders, HINT).toEqual([]);
  });
});
