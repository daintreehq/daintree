import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { build, type Metafile } from "esbuild";
import { mainEsmConfig } from "../build-main.mjs";
import { collectClosure } from "../first-render-closure-lib.mjs";

// V8 keeps a script's source at one byte per character only while every
// character is at or below U+00FF, so one em dash makes a chunk cost twice its
// length in heap in every isolate that loads it (#16682). esbuild writes regex
// literals as they are, and a production build re-prints its two-byte chunks
// as ASCII (#17023), but a tagged template's raw text and a kept comment ship
// as written. This builds what a production scripts/build-main.mjs run builds
// and reads the chunks each process loads before anything is imported
// dynamically, and every large chunk.
const root = path.resolve(__dirname, "../..");

// Below this, a two-byte chunk Main loads once costs too little to be worth
// moving a tagged template's glyphs out of it; above it, the cost is at least
// 256 KB.
const GUARDED_LENGTH = 256 * 1024;
// Each process's entries: the app's (package.json "main"), the boot it loads
// once the compile cache is on and Main, which the boot loads, then each
// host's bootstrap and the module it imports. The hosts are guarded at any
// size: every terminal's analysis worker loads its closure again, and shares
// much of it with the pty host.
const STARTUP_CLOSURES = [
  {
    name: "Main",
    entries: ["electron/bootstrap.ts", "electron/boot/appBoot.ts", "electron/main.ts"],
    guardedLength: GUARDED_LENGTH,
  },
  {
    name: "the pty host",
    entries: ["electron/pty-host-bootstrap.ts", "electron/pty-host.ts"],
    guardedLength: 0,
  },
  {
    name: "each analysis worker",
    entries: ["electron/pty-host/analysisWorker.ts"],
    guardedLength: 0,
  },
  {
    name: "the workspace host",
    entries: ["electron/workspace-host-bootstrap.ts", "electron/workspace-host.ts"],
    guardedLength: 0,
  },
];
const HESITATIONS = "shared/utils/voiceHesitations.ts";
const HINT =
  "check that the production build's ASCII pass ran: it escapes every literal, so what it leaves sits in a tagged template's raw text or a legal comment; pass such a character in as a string the template substitutes, as electron/services/pty/ClaudeUsageWarnings.ts does, or move the comment out of the chunk";

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

/** Every wide character, tagged templates and comments included, in each of `outputs`. */
function wideOffenders(out: Output, outputs: string[]): string[] {
  return outputs.flatMap((output) => {
    const text = textOf(out, output);
    const offsets: number[] = [];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) offsets.push(i);
    return describeAt(out, output, offsets);
  });
}

const isLongEnough = (out: Output, output: string, guardedLength: number) =>
  output.endsWith(".js") && textOf(out, output).length >= guardedLength;

/** Wide characters in each chunk of at least `guardedLength` the entries load statically. */
function startupOffenders(out: Output, entries: string[], guardedLength: number) {
  const guarded = staticClosure(out, entries).filter((output) =>
    isLongEnough(out, output, guardedLength)
  );
  return { guarded, offenders: wideOffenders(out, guarded) };
}

/** Wide characters in each chunk of at least `guardedLength`, however it is loaded. */
function largeOffenders(out: Output, guardedLength: number) {
  const guarded = Object.keys(out.metafile.outputs).filter((output) =>
    isLongEnough(out, output, guardedLength)
  );
  return { guarded, offenders: wideOffenders(out, guarded) };
}

/** Wide characters in each output carrying `input`. */
function carrierOffenders(out: Output, input: string) {
  const carriers = Object.entries(out.metafile.outputs)
    .filter(([, meta]) =>
      Object.entries(meta.inputs).some(
        ([file, contribution]) => normalize(file) === input && contribution.bytesInOutput > 0
      )
    )
    .map(([output]) => output);
  return { carriers, offenders: wideOffenders(out, carriers) };
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
      "out/small.js": { code: "var a=/[ÿĀ]/u;", meta: {} },
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

  it("reports every wide character, a tagged template's included, only in a large chunk loaded statically", () => {
    const { guarded, offenders } = startupOffenders(fixture(), ["entry.ts"], 20);
    expect(guarded.sort()).toEqual(["out/carrier.js", "out/entry.js", "out/large.js"]);
    expect(offenders.sort()).toEqual([
      expect.stringMatching(/^out\/carrier\.js .*U\+2192 at 17 /),
      expect.stringMatching(/^out\/large\.js .*U\+2014 at 8 /),
      expect.stringMatching(/^out\/large\.js .*U\+2192 at 26 /),
    ]);
  });

  it("reports a small chunk loaded statically when every size is guarded", () => {
    const { guarded, offenders } = startupOffenders(fixture(), ["entry.ts"], 0);
    expect(guarded).toContain("out/small.js");
    expect(guarded).not.toContain("out/lazy.js");
    // U+00FF still fits a one-byte string; U+0100 does not.
    expect(offenders.filter((offender) => offender.startsWith("out/small.js"))).toEqual([
      expect.stringMatching(/U\+0100 at 9 /),
    ]);
  });

  it("reports a large chunk only imported dynamically among the large ones", () => {
    const { guarded, offenders } = largeOffenders(fixture(), 20);
    expect(guarded.sort()).toEqual([
      "out/carrier.js",
      "out/entry.js",
      "out/large.js",
      "out/lazy.js",
    ]);
    expect(offenders).toContainEqual(expect.stringMatching(/^out\/lazy\.js .*U\+2192 at 26 /));
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

  it.each(STARTUP_CLOSURES)(
    "keeps the chunks $name loads at startup one byte per character",
    ({ entries, guardedLength }) => {
      const { guarded, offenders } = startupOffenders(out, entries, guardedLength);
      // Not a vacuous pass: each host has its entry chunk, and Main's largest shared
      // chunk is several times the threshold.
      expect(guarded.length).toBeGreaterThan(0);
      expect(offenders, HINT).toEqual([]);
    }
  );

  it("keeps every large chunk one byte per character, however it is loaded", () => {
    const { guarded, offenders } = largeOffenders(out, GUARDED_LENGTH);
    expect(guarded.length).toBeGreaterThan(0);
    expect(offenders, HINT).toEqual([]);
  });

  it("keeps every chunk that carries the hesitation filter one byte per character", () => {
    const { carriers, offenders } = carrierOffenders(out, HESITATIONS);
    expect(carriers.length).toBeGreaterThan(0);
    expect(offenders, HINT).toEqual([]);
  });
});
