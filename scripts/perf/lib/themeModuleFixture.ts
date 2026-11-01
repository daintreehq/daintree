import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPerfTempRoot } from "./tempRoots";

/**
 * Theme module evaluation fixture (PERF-306). Main and every project renderer
 * evaluate `@shared/theme` cold at boot, and that evaluation derives all 15
 * built-in schemes plus the internal light fallback from their palettes. This
 * fixture evaluates the real module the same way: one esbuild bundle of
 * `shared/theme/index.ts`, run in a fresh Node process per evaluation, so no
 * JIT feedback, inline cache or module state carries over between readings.
 *
 * SCOPE LIMITS:
 *
 * - **Node, not Electron.** No Vite chunking, no renderer scheduling, no paint.
 *   The bundle is unminified and carries zod (pulled in by the import
 *   validator), which a renderer shares with other chunks, so `parseMs` prices
 *   this bundle's parse, not the renderer entry chunk's.
 * - **Process start is outside the bracket.** The child times its own
 *   `new Function` (parse) and the module body (execute); spawn, IPC and
 *   grading are not measured.
 * - **The work count comes from a second, instrumented bundle**, evaluated in
 *   its own child, so the counter never runs inside the timed evaluation.
 *
 * The oracle is the engine's recorded output, the file snapshot that
 * `shared/theme/__tests__/builtInSchemeOutput.test.ts` owns and regenerates.
 * A theme module that evaluated quickly by deriving less, or differently, scores
 * against it, and so does one whose exports are anything but plain data: a
 * getter could defer the derivation past the timed bracket and run it during
 * serialisation, where neither the clock nor the counter sees it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(HERE, "../../..");
const THEME_ENTRY = join(REPO_ROOT, "shared/theme/index.ts");
// Under scripts/perf so the oracle is part of the apparatus both harness
// hashes cover: regenerating it around changed output changes the hash.
export const BUILT_IN_SCHEME_SNAPSHOT_PATH = join(HERE, "../fixtures/builtInSchemeOutput.json");

const COUNTER = "__daintreePerfLinearisations";
const FALLBACK_EXPORT = "__perfLightFallbackScheme";

/**
 * The sRGB channel linearisation every luminance and OKLab conversion makes,
 * once per channel: the shared one in contrast.ts (oklch.ts imports it) and the
 * private copy themes.ts keeps for its own contrast helpers. Counting here
 * rather than at a luminance function keeps the count comparable across a
 * change that reroutes which luminance helper a search calls.
 */
const LINEARISATION_ANCHORS: ReadonlyArray<{ file: RegExp; anchor: RegExp }> = [
  {
    file: /shared[\\/]theme[\\/]contrast\.ts$/,
    anchor: /^export function hexToLinear\(channel: number\): number \{$/m,
  },
  {
    file: /shared[\\/]theme[\\/]themes\.ts$/,
    anchor: /^function hexToLinear\(channel: number\): number \{$/m,
  },
];
const THEMES_FILE = /shared[\\/]theme[\\/]themes\.ts$/;
const FALLBACK_DECLARATION = /^const INTERNAL_LIGHT_FALLBACK_SCHEME = /m;

export interface ThemeModuleBundles {
  /** The module as shipped, plus the fallback export the oracle needs. */
  plainPath: string;
  plainBytes: number;
  /** The same module with a counter in every channel linearisation. */
  countedPath: string;
}

export interface ThemeModuleOutput {
  schemes: unknown[];
  fallback: unknown;
}

export interface ThemeModuleEvaluation {
  parseMs: number;
  executeMs: number;
  /** Accessors, functions, undefined, non-finite or non-plain values in the raw exports. */
  shapeViolations: number;
  /** Linearisations the module body made while evaluating. */
  linearisations: number;
  /** Linearisations one `relativeLuminance` call made, after the module loaded. */
  probeLinearisations: number;
  output: ThemeModuleOutput;
}

function countMatches(source: string, pattern: RegExp): number {
  return (
    source.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))?.length ?? 0
  );
}

/**
 * Splice the fallback export, and in the counted bundle the counters, into the
 * real sources. Each anchor must match exactly once: a renamed or duplicated
 * function fails the build loudly instead of counting nothing.
 */
export function instrumentThemeSource(path: string, source: string, counted: boolean): string {
  let next = source;
  if (THEMES_FILE.test(path)) {
    if (countMatches(next, FALLBACK_DECLARATION) !== 1) {
      throw new Error(
        "PERF-306: themes.ts no longer declares INTERNAL_LIGHT_FALLBACK_SCHEME once; the fallback cannot be graded"
      );
    }
    next += `\nexport { INTERNAL_LIGHT_FALLBACK_SCHEME as ${FALLBACK_EXPORT} };\n`;
  }
  if (!counted) return next;
  for (const { file, anchor } of LINEARISATION_ANCHORS) {
    if (!file.test(path)) continue;
    const found = countMatches(next, anchor);
    if (found !== 1) {
      throw new Error(
        `PERF-306: expected one hexToLinear in ${path}, found ${found}; the work count would be wrong`
      );
    }
    next = next.replace(anchor, (line) => `${line}\n  globalThis.${COUNTER} += 1;`);
  }
  return next;
}

async function buildBundle(counted: boolean): Promise<string> {
  const esbuild = await import("esbuild");
  const instrumented = new Set<string>();
  const result = await esbuild.build({
    entryPoints: [THEME_ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "daintree-perf-theme-module",
        setup(build) {
          build.onLoad({ filter: /shared[\\/]theme[\\/](contrast|themes)\.ts$/ }, (args) => {
            instrumented.add(args.path);
            return {
              contents: instrumentThemeSource(args.path, readFileSync(args.path, "utf8"), counted),
              loader: "ts",
            };
          });
        },
      },
    ],
  });
  if (instrumented.size !== 2) {
    throw new Error("PERF-306: the theme bundle did not load both contrast.ts and themes.ts");
  }
  return result.outputFiles[0]!.text;
}

let bundlesPromise: Promise<ThemeModuleBundles> | null = null;

/**
 * Lazy, so importing the scenario matrix bundles nothing. The bundles go to
 * files the child is pointed at: piping a megabyte through a synchronous
 * child's stdin left the occasional child waiting on an EOF that never came.
 */
export function loadThemeModuleBundles(): Promise<ThemeModuleBundles> {
  if (!bundlesPromise) {
    bundlesPromise = Promise.all([buildBundle(false), buildBundle(true)]).then(
      ([plain, counted]) => {
        const root = createPerfTempRoot("daintree-perf-theme-module-");
        const plainPath = join(root, "theme.cjs");
        const countedPath = join(root, "theme.counted.cjs");
        writeFileSync(plainPath, plain);
        writeFileSync(countedPath, counted);
        return { plainPath, plainBytes: Buffer.byteLength(plain), countedPath };
      }
    );
  }
  return bundlesPromise;
}

/**
 * Plain JavaScript, because it runs in the child against the raw exports before
 * JSON transport would invoke getters and proxy traps, drop undefined, holes and
 * stray array properties, and call toJSON. Counts every value JSON could not
 * carry faithfully, without reading through an accessor or a proxy.
 */
export const PLAIN_DATA_VIOLATIONS_SOURCE = `function plainDataViolations(root, isProxy) {
  let violations = 0;
  const seen = new Set();
  const visit = (node) => {
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) violations += 1;
      return;
    }
    if (typeof node !== "object" || isProxy(node)) {
      violations += 1;
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    const proto = Object.getPrototypeOf(node);
    const array = Array.isArray(node);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      violations += 1;
    }
    let indices = 0;
    for (const key of Reflect.ownKeys(node)) {
      if (array) {
        if (key === "length") continue;
        // JSON keeps an array's indices and nothing else. An own index is a
        // canonical integer below length; anything else is a stray property.
        const index = typeof key === "string" ? Number(key) : Number.NaN;
        if (!(String(index) === key && Number.isInteger(index) && index >= 0 && index < node.length)) {
          violations += 1;
          continue;
        }
        indices += 1;
      }
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (typeof key === "symbol" || !descriptor.enumerable || !("value" in descriptor)) {
        violations += 1;
        continue;
      }
      visit(descriptor.value);
    }
    // Holes, which JSON fills with null.
    if (array) violations += node.length - indices;
  };
  visit(root);
  return violations;
}`;

// Runs in the child: reads the bundle it is pointed at, evaluates it as a
// CommonJS module, and writes the readings and the derived schemes to stdout.
const CHILD_SCRIPT = `
${PLAIN_DATA_VIOLATIONS_SOURCE}
const { performance } = require("node:perf_hooks");
const code = require("node:fs").readFileSync(process.argv[1], "utf8");
globalThis.${COUNTER} = 0;
const mod = { exports: {} };
const t0 = performance.now();
const evaluate = new Function("module", "exports", "require", code);
const t1 = performance.now();
evaluate(mod, mod.exports, require);
const t2 = performance.now();
const linearisations = globalThis.${COUNTER};
const output = { schemes: mod.exports.BUILT_IN_APP_SCHEMES, fallback: mod.exports.${FALLBACK_EXPORT} };
const shapeViolations = plainDataViolations(output, require("node:util").types.isProxy);
mod.exports.relativeLuminance("#808080");
const probeLinearisations = globalThis.${COUNTER} - linearisations;
process.stdout.write(JSON.stringify({
  parseMs: t1 - t0,
  executeMs: t2 - t1,
  shapeViolations,
  linearisations,
  probeLinearisations,
  output,
}));
`;

// Far above any real evaluation (tens of milliseconds) and below the liveness
// guard's per-scenario limit, so a hung child fails this run with its arm named
// instead of outliving the driver.
const CHILD_TIMEOUT_MS = 60_000;

/** Evaluate one bundle file in a fresh Node process. */
export function evaluateThemeModule(bundlePath: string): ThemeModuleEvaluation {
  const env = { ...process.env };
  // A plain Node child: no loader inherited from the tsx process driving the
  // run. Windows reads the variable case-insensitively, so every spelling goes.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "NODE_OPTIONS") delete env[key];
  }
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, ["-e", CHILD_SCRIPT, bundlePath], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    throw new Error(`PERF-306: evaluating ${bundlePath} failed`, { cause: error });
  }
  return JSON.parse(stdout) as ThemeModuleEvaluation;
}

let snapshot: ThemeModuleOutput | null = null;

export function loadBuiltInSchemeSnapshot(): ThemeModuleOutput {
  if (!snapshot) {
    snapshot = JSON.parse(readFileSync(BUILT_IN_SCHEME_SNAPSHOT_PATH, "utf8")) as ThemeModuleOutput;
  }
  return snapshot;
}

/**
 * Schemes that differ from the recorded engine output, the fallback counted as
 * one more, plus any scheme missing or extra, plus every value the child found
 * that isn't plain data. Compared after a JSON round trip on both sides, which
 * is the form the snapshot records; the shape check is what JSON can't see.
 */
export function themeModuleOutputMisses(
  evaluation: Pick<ThemeModuleEvaluation, "output" | "shapeViolations">,
  recorded: ThemeModuleOutput
): number {
  const { output } = evaluation;
  const schemes = Array.isArray(output.schemes) ? output.schemes : [];
  let misses = Math.abs(schemes.length - recorded.schemes.length);
  const shared = Math.min(schemes.length, recorded.schemes.length);
  for (let i = 0; i < shared; i += 1) {
    if (!isDeepStrictEqual(schemes[i], recorded.schemes[i])) misses += 1;
  }
  if (!isDeepStrictEqual(output.fallback, recorded.fallback)) misses += 1;
  return misses + evaluation.shapeViolations;
}

/**
 * The counter is wired to the real conversions: the counted module made some,
 * one luminance call after load made exactly one per channel, and the timed
 * module carried no counter at all.
 */
export function instrumentationMisses(
  plain: ThemeModuleEvaluation,
  counted: ThemeModuleEvaluation
): number {
  let misses = 0;
  if (!(counted.linearisations > 0)) misses += 1;
  if (counted.probeLinearisations !== 3) misses += 1;
  if (plain.linearisations !== 0 || plain.probeLinearisations !== 0) misses += 1;
  return misses;
}
