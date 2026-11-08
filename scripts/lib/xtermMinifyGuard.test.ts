import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rolldown, type OutputOptions } from "rolldown";
import { build } from "vite";
import {
  PROBE_STEPS,
  bundleXterm,
  checkXtermBuild,
  probeXtermParser,
  replayMinify,
  verifyXtermParser,
  xtermMinifyIdentifiersGuardPlugin,
} from "./xtermMinifyGuard.js";

const XTERM_FILE = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@xterm/xterm/package.json")),
  "lib",
  "xterm.mjs"
);
const REQUEST_MODE = /requestMode\(\w+,\w+\)\{/;

const scratch = mkdtempSync(path.join(tmpdir(), "xterm-minify-guard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function bundleWithGuard(
  input: string,
  minify: OutputOptions["minify"],
  extraPlugins: Parameters<typeof rolldown>[0]["plugins"] = []
) {
  const bundle = await rolldown({
    input,
    logLevel: "silent",
    plugins: [xtermMinifyIdentifiersGuardPlugin(), extraPlugins],
  });
  try {
    await bundle.generate({ format: "esm", minify });
  } finally {
    await bundle.close();
  }
}

/** The minify options a plugin hook sees for this output. */
async function normalizedMinify(minify: OutputOptions["minify"]) {
  let seen: unknown;
  const bundle = await rolldown({
    input: XTERM_FILE,
    logLevel: "silent",
    plugins: [{ name: "spy", renderStart: (options) => void (seen = options.minify) }],
  });
  try {
    await bundle.generate({ format: "esm", minify });
  } finally {
    await bundle.close();
  }
  return seen as OutputOptions["minify"];
}

function sabotage(code: string, pattern: RegExp | string, replace: (match: string) => string) {
  const broken = code.replace(pattern, replace);
  // A rewrite that no longer matches xterm's code would make the test pass vacuously.
  expect(broken).not.toBe(code);
  return broken;
}

function replyAfter(replies: string[], ...steps: string[]) {
  let from = 0;
  for (const step of steps) from = PROBE_STEPS.indexOf(step, from) + 1;
  return replies[from - 1];
}

describe("xterm's minifier guard", () => {
  it("refuses a Vite minifier it cannot check", async () => {
    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [xtermMinifyIdentifiersGuardPlugin()],
        build: { write: false, minify: "terser" },
      })
    ).rejects.toThrow("can only check Oxc output");
  });

  it.each([true, { mangle: true, compress: true }, { mangle: false }, false, "dce-only"] as const)(
    "accepts xterm minified with %j",
    async (minify) => {
      await expect(verifyXtermParser(XTERM_FILE, minify)).resolves.toBeUndefined();
    }
  );

  it.each([
    true,
    { mangle: false },
    { compress: false, mangle: true },
    { compress: false, mangle: false },
    { mangle: { toplevel: false } },
    "dce-only",
    false,
  ] as const)("replays the hook's view of %j as the same minifier", async (minify) => {
    const seen = await normalizedMinify(minify);
    expect(await normalizedMinify(replayMinify(seen))).toEqual(seen);
  });

  it("checks xterm in a Vite build with the build's target", async () => {
    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [xtermMinifyIdentifiersGuardPlugin()],
        build: {
          write: false,
          target: "chrome148",
          rolldownOptions: { input: XTERM_FILE },
        },
      })
    ).resolves.toBeDefined();
  });

  it("reads mode state through requestMode in the mangled build", async () => {
    const { replies, firstLine } = await probeXtermParser(await bundleXterm(XTERM_FILE, true));
    expect(firstLine).toBe("probe-complete");
    expect(replyAfter(replies, "\x1b[4h", "\x1b[4$p")).toBe("\x1b[4;1$y");
    expect(replyAfter(replies, "\x1b[4l", "\x1b[4$p")).toBe("\x1b[4;2$y");
    expect(replyAfter(replies, "\x1b[?2004h", "\x1b[?2004$p")).toBe("\x1b[?2004;1$y");
    expect(replyAfter(replies, "\x1b[?2004l", "\x1b[?2004$p")).toBe("\x1b[?2004;2$y");
    expect(replyAfter(replies, "\x1b[?1000h", "\x1b[?1000$p")).toBe("\x1b[?1000;1$y");
  });

  it("fails when the minified requestMode throws, as xterm 6.0's did", async () => {
    const shipped = sabotage(
      await bundleXterm(XTERM_FILE, true),
      REQUEST_MODE,
      (match) => `${match}throw new ReferenceError("i is not defined");`
    );
    await expect(checkXtermBuild(XTERM_FILE, shipped)).rejects.toThrow(
      /broke xterm's parser: its parser threw: ReferenceError: i is not defined/
    );
  });

  it("fails when the minified build answers a query differently", async () => {
    const shipped = sabotage(await bundleXterm(XTERM_FILE, true), "$y`", () => "$z`");
    await expect(checkXtermBuild(XTERM_FILE, shipped)).rejects.toThrow(
      /broke xterm's parser: it answers "\\u001b\[2\$p" with "\\u001b\[2;4\$z"/
    );
  });

  it("fails when the probe can no longer drive xterm's own build", async () => {
    const silentReference = path.join(scratch, "xterm.mjs");
    writeFileSync(
      silentReference,
      sabotage(readFileSync(XTERM_FILE, "utf8"), REQUEST_MODE, (match) => `${match}return !0;`)
    );
    await expect(
      checkXtermBuild(silentReference, await bundleXterm(XTERM_FILE, true))
    ).rejects.toThrow("no longer drives xterm's own build");
  });

  it("terminates a probe that never finishes", async () => {
    await expect(
      probeXtermParser("setInterval(() => {}, 1000); await new Promise(() => {});", 500)
    ).rejects.toThrow("did not finish within 500 ms");
  });

  it("checks the xterm module in a real bundle", async () => {
    await expect(bundleWithGuard(XTERM_FILE, true)).resolves.toBeUndefined();
  });

  it("fails a bundle without xterm rather than passing it unchecked", async () => {
    await expect(
      bundleWithGuard("fixture", true, [
        {
          name: "fixture",
          resolveId: (id) => (id === "fixture" ? "\0fixture" : null),
          load: (id) => (id === "\0fixture" ? "export const value = 1;" : null),
        },
      ])
    ).rejects.toThrow("expected one @xterm/xterm/lib/xterm.mjs module in the bundle, found 0");
  });
});
