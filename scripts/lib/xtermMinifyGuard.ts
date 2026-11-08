import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { Plugin } from "vite";

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

export function moduleUrl(code: string): string {
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

/**
 * Runs the probe steps against the build of xterm a module URL exports, in a
 * worker it always terminates. A code-split chunk resolves its imports from
 * disk, so it is probed by file URL from the written bundle.
 */
export function probeXtermParser(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<XtermProbeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PROBE_WORKER, {
      workerData: { url, steps: PROBE_STEPS, trailer: PROBE_TRAILER },
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

/**
 * Fails when the shipped build answers any probe step differently from the
 * build xterm publishes, or stops parsing. The reference must answer every
 * query, so a probe that can no longer drive xterm fails instead of passing.
 */
export async function checkXtermBuild(xtermFile: string, shippedUrl: string): Promise<void> {
  const [reference, shipped] = await Promise.allSettled([
    probeXtermParser(moduleUrl(readFileSync(xtermFile, "utf8"))),
    probeXtermParser(shippedUrl),
  ]);
  if (reference.status === "rejected") {
    throw new Error(`The xterm parser probe could not run xterm's own build: ${reference.reason}`);
  }
  const unanswered = PROBE_STEPS.findIndex(
    (step, index) => step.endsWith("$p") && !DECRPM_REPLY.test(reference.value.replies[index])
  );
  if (unanswered !== -1 || reference.value.firstLine !== PROBE_TRAILER) {
    throw new Error(
      "The xterm parser probe no longer drives xterm's own build, so it cannot check the shipped one."
    );
  }
  const divergence =
    shipped.status === "rejected"
      ? `probing it threw ${shipped.reason}`
      : describeDivergence(reference.value, shipped.value);
  if (divergence) {
    throw new Error(
      `The build broke xterm's parser: ${divergence}. If mangling did it, keep xterm's identifiers unmangled.`
    );
  }
}

/**
 * Fails the build when the xterm chunk it wrote answers DECRQM differently from
 * the build xterm publishes. It probes the written file, after every chunk
 * rewrite, so whatever minified or re-printed the chunk is what gets checked.
 */
export function xtermMinifyIdentifiersGuardPlugin(): Plugin {
  return {
    name: "xterm-minify-identifiers-guard",
    apply: "build",
    writeBundle: {
      order: "post",
      async handler(options, bundle) {
        const chunks = Object.values(bundle).flatMap((output) =>
          output.type === "chunk" && output.moduleIds.some((id) => XTERM_MODULE.test(id))
            ? [output]
            : []
        );
        if (chunks.length !== 1 || !options.dir) {
          throw new Error(
            `The xterm parser guard expected one written chunk holding @xterm/xterm/lib/xterm.mjs, found ${chunks.length}.`
          );
        }
        const [chunk] = chunks;
        const xtermFile = chunk.moduleIds.find((id) => XTERM_MODULE.test(id))!;
        await checkXtermBuild(
          xtermFile,
          pathToFileURL(path.join(options.dir, chunk.fileName)).href
        );
      },
    },
  };
}
