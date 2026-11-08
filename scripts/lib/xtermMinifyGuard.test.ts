import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { rolldown, type OutputOptions, type Plugin as RolldownPlugin } from "rolldown";
import { build } from "vite";
import {
  PROBE_STEPS,
  checkXtermBuild,
  moduleUrl,
  probeXtermParser,
  xtermMinifyIdentifiersGuardPlugin,
} from "./xtermMinifyGuard.js";

const XTERM_FILE = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@xterm/xterm/package.json")),
  "lib",
  "xterm.mjs"
);
const XTERM_SOURCE = readFileSync(XTERM_FILE, "utf8");
const REQUEST_MODE = /requestMode\(\w+,\w+\)\{/;
const THROW_LIKE_XTERM_6_0 = (match: string) =>
  `${match}throw new ReferenceError("i is not defined");`;

const scratch = mkdtempSync(path.join(tmpdir(), "xterm-minify-guard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let outputs = 0;

/** The renderer's shape: xterm loaded lazily from its own group chunk, modules wrapped in initializers. */
const lazyXtermEntry: RolldownPlugin = {
  name: "lazy-xterm-entry",
  resolveId: (id) => (id === "entry" ? "\0entry" : null),
  load: (id) => (id === "\0entry" ? 'export const load = () => import("@xterm/xterm");' : null),
};

/** Writes a bundle through the guard and returns the written xterm chunk's URL. */
async function writeWithGuard(
  minify: OutputOptions["minify"],
  plugins: RolldownPlugin[] = [lazyXtermEntry],
  input = "entry"
) {
  const dir = path.join(scratch, `out-${outputs++}`);
  const bundle = await rolldown({
    input,
    logLevel: "silent",
    plugins: [...plugins, xtermMinifyIdentifiersGuardPlugin() as RolldownPlugin],
  });
  try {
    const { output } = await bundle.write({
      dir,
      format: "esm",
      minify,
      strictExecutionOrder: true,
      codeSplitting: { groups: [{ name: "vendor-xterm", test: /@xterm[\\/]xterm[\\/]/ }] },
    });
    const chunk = output.find((entry) => entry.fileName.startsWith("vendor-xterm-"));
    return chunk ? pathToFileURL(path.join(dir, chunk.fileName)).href : null;
  } finally {
    await bundle.close();
  }
}

/** Rewrites the xterm chunk after the minifier, the way a later post-processor would. */
function rewriteXtermChunk(pattern: RegExp, replace: (match: string) => string): RolldownPlugin {
  return {
    name: "rewrite-xterm-chunk",
    generateBundle(_options, bundle) {
      const chunk = Object.values(bundle).find(
        (entry) => entry.type === "chunk" && entry.moduleIds.some((id) => id.endsWith("xterm.mjs"))
      );
      if (chunk?.type !== "chunk") throw new Error("no xterm chunk to rewrite");
      const rewritten = chunk.code.replace(pattern, replace);
      if (rewritten === chunk.code)
        throw new Error(`${pattern} matched nothing in the xterm chunk`);
      chunk.code = rewritten;
    },
  };
}

function sabotage(code: string, pattern: RegExp | string, replace: (match: string) => string) {
  const broken = code.replace(pattern, replace);
  // A rewrite that no longer matches xterm's code would make the test pass vacuously.
  expect(broken).not.toBe(code);
  return broken;
}

function replyAfter(replies: string[], ...steps: string[]) {
  let index = -1;
  for (const step of steps) {
    index = PROBE_STEPS.indexOf(step, index + 1);
    expect(index, `probe step ${JSON.stringify(step)}`).not.toBe(-1);
  }
  return replies[index];
}

describe("xterm's minifier guard", () => {
  it.each([true, { mangle: true, compress: true }, { mangle: false }, false, "dce-only"] as const)(
    "accepts the xterm chunk minified with %j",
    async (minify) => {
      await expect(writeWithGuard(minify)).resolves.toMatch(/vendor-xterm-/);
    }
  );

  it("fails the build when the written chunk's requestMode throws, as xterm 6.0's did", async () => {
    await expect(
      writeWithGuard(true, [lazyXtermEntry, rewriteXtermChunk(REQUEST_MODE, THROW_LIKE_XTERM_6_0)])
    ).rejects.toThrow(/broke xterm's parser: probing it threw ReferenceError: i is not defined/);
  });

  it("fails the build when the written chunk answers a query differently", async () => {
    await expect(
      writeWithGuard(true, [lazyXtermEntry, rewriteXtermChunk(/\$y`/, () => "$z`")])
    ).rejects.toThrow(/broke xterm's parser: it answers "\\u001b\[2\$p" with "\\u001b\[2;4\$z"/);
  });

  it("fails a bundle without xterm rather than passing it unchecked", async () => {
    const fixture: RolldownPlugin = {
      name: "fixture",
      resolveId: (id) => (id === "fixture" ? "\0fixture" : null),
      load: (id) => (id === "\0fixture" ? "export const value = 1;" : null),
    };
    await expect(writeWithGuard(true, [fixture], "fixture")).rejects.toThrow(
      "expected one written chunk holding @xterm/xterm/lib/xterm.mjs, found 0"
    );
  });

  it("checks the xterm chunk a Vite build writes", async () => {
    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [xtermMinifyIdentifiersGuardPlugin()],
        build: {
          outDir: path.join(scratch, "vite"),
          target: "chrome148",
          rolldownOptions: {
            input: XTERM_FILE,
            preserveEntrySignatures: "exports-only",
            plugins: [rewriteXtermChunk(REQUEST_MODE, THROW_LIKE_XTERM_6_0)],
          },
        },
      })
    ).rejects.toThrow(/broke xterm's parser: probing it threw ReferenceError/);
  });

  it("reads mode state through requestMode in the mangled chunk", async () => {
    const url = await writeWithGuard(true);
    const { replies, firstLine } = await probeXtermParser(url!);
    expect(firstLine).toBe("probe-complete");
    expect(replyAfter(replies, "\x1b[4h", "\x1b[4$p")).toBe("\x1b[4;1$y");
    expect(replyAfter(replies, "\x1b[4l", "\x1b[4$p")).toBe("\x1b[4;2$y");
    expect(replyAfter(replies, "\x1b[?2004h", "\x1b[?2004$p")).toBe("\x1b[?2004;1$y");
    expect(replyAfter(replies, "\x1b[?2004l", "\x1b[?2004$p")).toBe("\x1b[?2004;2$y");
    expect(replyAfter(replies, "\x1b[?1000h", "\x1b[?1000$p")).toBe("\x1b[?1000;1$y");
  });

  it("fails when the probe can no longer drive xterm's own build", async () => {
    const silentReference = path.join(scratch, "xterm.mjs");
    writeFileSync(
      silentReference,
      sabotage(XTERM_SOURCE, REQUEST_MODE, (match) => `${match}return !0;`)
    );
    await expect(checkXtermBuild(silentReference, moduleUrl(XTERM_SOURCE))).rejects.toThrow(
      "no longer drives xterm's own build"
    );
  });

  it("fails when the shipped build exposes no Terminal", async () => {
    await expect(checkXtermBuild(XTERM_FILE, moduleUrl("export const value = 1;"))).rejects.toThrow(
      "probing it threw Error: expected one xterm Terminal export, found 0"
    );
  });

  it("terminates a probe that never finishes", async () => {
    await expect(
      probeXtermParser(moduleUrl("setInterval(() => {}, 1000); await new Promise(() => {});"), 500)
    ).rejects.toThrow("did not finish within 500 ms");
  });
});
