import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { rolldown, type OutputOptions } from "rolldown";
import type { Plugin } from "vite";
import { escapeChunkToAscii, hasTwoByteCharacters } from "./ascii-only-chunks.mjs";

type Minify = OutputOptions["minify"];

export interface XtermProbeResult {
  replies: string[];
  firstLine: string;
}

const XTERM_MODULE = /[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.mjs$/;
const PROBE_WORKER = fileURLToPath(new URL("./xterm-parser-probe.mjs", import.meta.url));
const PROBE_TIMEOUT_MS = 30_000;
const DECRPM_REPLY = /^\x1b\[\??\d+;[0-4]\$y$/;

/**
 * DECRQM queries, with mode changes between them so `requestMode` reads state
 * through its closures: xterm 6.0's pre-minified code lost one of those
 * bindings when esbuild mangled it again (ed318075f3).
 */
export const PROBE_STEPS: readonly string[] = [
  ...[2, 4, 12, 20, 99].map((mode) => `\x1b[${mode}$p`),
  ...[
    1, 3, 6, 7, 8, 9, 12, 25, 45, 47, 66, 67, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047,
    1048, 1049, 2004, 2026, 9001, 9999,
  ].map((mode) => `\x1b[?${mode}$p`),
  "\x1b[4h",
  "\x1b[4$p",
  "\x1b[4l",
  "\x1b[4$p",
  "\x1b[?2004h",
  "\x1b[?2004$p",
  "\x1b[?2004l",
  "\x1b[?2004$p",
  "\x1b[?1h",
  "\x1b[?1$p",
  "\x1b[?1000h",
  "\x1b[?1000$p",
  "\x1b[?1000l",
  "\x1b[?1l",
];

/** Printed after every step; a parser that crashed mid-stream drops it. */
export const PROBE_TRAILER = "probe-complete";

/**
 * Output options as a hook sees them, made fit to pass to `generate()` again.
 * Normalizing drops a disabled `mangle` or `compress`, which an options object
 * would otherwise turn back on, and folds a suffix into the compress target that
 * `generate()` refuses, so the build's own target replaces it.
 */
export function replayMinify(minify: Minify, target?: string | string[] | false): Minify {
  if (typeof minify !== "object") return minify;
  const { compress = false, mangle = false, ...rest } = minify;
  if (typeof compress !== "object") return { ...rest, compress, mangle };
  const { target: _normalizedTarget, ...compressOptions } = compress;
  return { ...rest, mangle, compress: target ? { ...compressOptions, target } : compressOptions };
}

/** xterm's own ESM build, minified as one output chunk would be. */
export async function bundleXterm(xtermFile: string, minify: Minify): Promise<string> {
  const bundle = await rolldown({ input: xtermFile, logLevel: "silent" });
  try {
    const { output } = await bundle.generate({ format: "esm", minify });
    const code = output[0].code;
    return hasTwoByteCharacters(code) ? escapeChunkToAscii("xterm.mjs", code) : code;
  } finally {
    await bundle.close();
  }
}

/** Runs the probe steps against one build of xterm, in a worker it always terminates. */
export function probeXtermParser(
  code: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<XtermProbeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PROBE_WORKER, {
      workerData: { code, steps: PROBE_STEPS, trailer: PROBE_TRAILER },
    });
    let settled = false;
    const settle = (error: Error | null, result?: XtermProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const finish = () => (error ? reject(error) : resolve(result!));
      void worker.terminate().then(finish, finish);
    };
    const timer = setTimeout(
      () => settle(new Error(`the probe did not finish within ${timeoutMs} ms`)),
      timeoutMs
    );
    worker.once("message", (result: XtermProbeResult) => settle(null, result));
    worker.once("error", (error) => settle(error));
    worker.once("exit", (exitCode) => settle(new Error(`the probe exited with ${exitCode}`)));
  });
}

function describeDivergence(reference: XtermProbeResult, shipped: XtermProbeResult): string | null {
  if (shipped.firstLine !== PROBE_TRAILER) {
    return `its parser stopped before the text after the queries (line 0 reads ${JSON.stringify(shipped.firstLine)})`;
  }
  for (const [index, step] of PROBE_STEPS.entries()) {
    if (shipped.replies[index] !== reference.replies[index]) {
      return `it answers ${JSON.stringify(step)} with ${JSON.stringify(shipped.replies[index])}; xterm's own build answers ${JSON.stringify(reference.replies[index])}`;
    }
  }
  return null;
}

/** Fails when xterm minified with these options parses differently from its own build. */
export async function verifyXtermParser(xtermFile: string, minify: Minify): Promise<void> {
  await checkXtermBuild(xtermFile, await bundleXterm(xtermFile, minify));
}

/**
 * Fails when the shipped build answers any probe step differently from the
 * build xterm publishes, or stops parsing. The reference must answer every
 * query, so a probe that can no longer drive xterm fails instead of passing.
 */
export async function checkXtermBuild(xtermFile: string, shippedCode: string): Promise<void> {
  const [reference, shipped] = await Promise.allSettled([
    probeXtermParser(readFileSync(xtermFile, "utf8")),
    probeXtermParser(shippedCode),
  ]);
  if (reference.status === "rejected") {
    throw new Error(`The xterm parser probe could not run xterm's own build: ${reference.reason}`);
  }
  const unanswered = PROBE_STEPS.findIndex(
    (step, index) => step.endsWith("$p") && !DECRPM_REPLY.test(reference.value.replies[index])
  );
  if (unanswered !== -1 || reference.value.firstLine !== PROBE_TRAILER) {
    throw new Error(
      "The xterm parser probe no longer drives xterm's own build, so it cannot check the minified one."
    );
  }
  const divergence =
    shipped.status === "rejected"
      ? `its parser threw: ${shipped.reason}`
      : describeDivergence(reference.value, shipped.value);
  if (divergence) {
    throw new Error(
      `The minifier broke xterm's parser: ${divergence}. Keep its identifiers unmangled until the minifier is fixed.`
    );
  }
}

/**
 * Fails the build when the output minifier changes how xterm's parser answers
 * DECRQM. It re-minifies xterm's own module with the output's resolved minify
 * options and compares both builds, so it can vouch for Oxc output only.
 */
export function xtermMinifyIdentifiersGuardPlugin(): Plugin {
  let target: string | string[] | false | undefined;
  return {
    name: "xterm-minify-identifiers-guard",
    apply: "build",
    configResolved(config) {
      if (config.build.minify !== "oxc" && config.build.minify !== false) {
        throw new Error("The xterm parser guard can only check Oxc output or an unminified build.");
      }
      target = config.build.target;
    },
    async generateBundle(options, bundle) {
      const xtermFiles = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of output.moduleIds) if (XTERM_MODULE.test(id)) xtermFiles.add(id);
      }
      if (xtermFiles.size !== 1) {
        throw new Error(
          `The xterm parser guard expected one @xterm/xterm/lib/xterm.mjs module in the bundle, found ${xtermFiles.size}.`
        );
      }
      await verifyXtermParser([...xtermFiles][0], replayMinify(options.minify, target));
    },
  };
}
