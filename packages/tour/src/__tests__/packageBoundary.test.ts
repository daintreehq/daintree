import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "../index.js";
import * as react from "../react.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function importsOf(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  // `from "x"`, a bare `import "x"`, and `import("x")` — every way a module can load another.
  const specifiers = /\sfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm;
  return [...source.matchAll(specifiers)].map((match) => (match[1] ?? match[2] ?? match[3])!);
}

describe("package boundary", () => {
  // A Node CLI or a plugin build imports the core, so it can reach neither
  // React nor anything of the host's.
  it("keeps every core module to relative imports", () => {
    const coreFiles = readdirSync(SRC).filter(
      (file) => file.endsWith(".ts") && file !== "react.ts"
    );
    for (const file of coreFiles) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/[^/]+\.js$/);
      }
    }
  });

  it("lets the React bindings reach only React and the core", () => {
    for (const specifier of importsOf("react.ts")) {
      expect(specifier).toMatch(/^(react|\.\/[^/]+\.js)$/);
    }
  });

  // `export type` on a runtime binding erases it to undefined without a compile error.
  it("exports the engine's runtime values", () => {
    for (const name of [
      "TourPlayer",
      "alignWordStarts",
      "buildCaptions",
      "buildTiming",
      "estimateTiming",
      "estimateWordStarts",
      "narrationFingerprint",
      "parseNarration",
      "stripDirectionTags",
      "resolveChapterTiming",
      "resolveTourTimings",
      "tourMinutes",
    ]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("exports the scene bindings from the react subpath", () => {
    expect(react.TourPlayerContext).toBeDefined();
    for (const name of [
      "useTourPlayer",
      "useTourPlayerState",
      "useTourTime",
      "useCue",
      "useSecondsSinceCue",
      "useTimelineIndex",
    ]) {
      expect(typeof (react as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
