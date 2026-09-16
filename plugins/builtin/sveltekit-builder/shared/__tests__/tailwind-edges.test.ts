import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findConflicts,
  isValidCandidate,
  loadTailwindDesignSystem,
  rangeContaining,
  readBreakpoints,
  resolveResponsiveRanges,
  type TailwindDesignSystem,
} from "../tailwind/index.js";

/** Breakpoint sets a real project can produce that the default one never does. */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const tempDirs: string[] = [];

async function loadCss(css: string): Promise<TailwindDesignSystem> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sveltekit-builder-tw-edge-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  await fs.writeFile(path.join(dir, "app.css"), css);
  const result = await loadTailwindDesignSystem({
    appRoot: dir,
    cssEntry: path.join(dir, "app.css"),
  });
  if (result.status !== "ok") throw new Error(result.reason);
  return result.system;
}

const load = (theme: string) => loadCss(`@import "tailwindcss";\n@theme {\n${theme}\n}\n`);

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("breakpoint edge cases", () => {
  it("survives a project with no breakpoints at all", async () => {
    const system = await load("--breakpoint-*: initial;");
    expect(readBreakpoints(system)).toEqual([]);
    const ranges = resolveResponsiveRanges(system);
    expect(ranges.map((range) => range.variant)).toEqual(["base"]);
    expect(rangeContaining(ranges, 390)?.variant).toBe("base");
  }, 30_000);

  it("produces no interval from a single breakpoint but still both edges", async () => {
    const system = await load("--breakpoint-*: initial;\n--breakpoint-big: 60rem;");
    const ranges = resolveResponsiveRanges(system);
    expect(ranges.map((range) => range.variant)).toEqual(["base", "big", "max-big"]);
    expect(rangeContaining(ranges, 500)?.variant).toBe("max-big");
    expect(rangeContaining(ranges, 1000)?.variant).toBe("big");
  }, 30_000);

  it("orders by resolved width, not by declaration order or name", async () => {
    const system = await load(
      "--breakpoint-*: initial;\n--breakpoint-zeta: 20rem;\n--breakpoint-alpha: 90rem;\n--breakpoint-mid: 700px;"
    );
    expect(readBreakpoints(system).map((breakpoint) => breakpoint.name)).toEqual([
      "zeta",
      "mid",
      "alpha",
    ]);
  }, 30_000);

  it("drops a breakpoint whose value is not a width it can bound", async () => {
    const system = await load(
      "--breakpoint-*: initial;\n--breakpoint-odd: 40vw;\n--breakpoint-ok: 50rem;"
    );
    expect(readBreakpoints(system).map((breakpoint) => breakpoint.name)).toEqual(["ok"]);
    expect(resolveResponsiveRanges(system).map((range) => range.variant)).not.toContain("odd");
  }, 30_000);
});

describe("breakpoints a project can name but this model cannot express", () => {
  it("keeps one name per width so no empty interval is offered", async () => {
    const system = await load(
      "--breakpoint-*: initial;\n--breakpoint-tablet: 40rem;\n--breakpoint-pad: 40rem;\n--breakpoint-wide: 80rem;"
    );
    const variants = resolveResponsiveRanges(system).map((range) => range.variant);
    const intervals = resolveResponsiveRanges(system).filter(
      (range) => range.minWidth !== undefined && range.maxWidthExclusive !== undefined
    );
    expect(intervals.every((range) => (range.minWidth ?? 0) < (range.maxWidthExclusive ?? 0))).toBe(
      true
    );
    expect(variants.filter((variant) => variant.startsWith("max-"))).toHaveLength(2);
  }, 30_000);

  it("drops a breakpoint whose name collides with the base range", async () => {
    const system = await load("--breakpoint-*: initial;\n--breakpoint-base: 40rem;");
    const variants = resolveResponsiveRanges(system).map((range) => range.variant);
    expect(variants).toEqual(["base"]);
    expect(new Set(variants).size).toBe(variants.length);
  }, 30_000);

  it("reports integer bounds for a fractional breakpoint", async () => {
    const system = await load("--breakpoint-*: initial;\n--breakpoint-odd: 40.01rem;");
    const minimum = resolveResponsiveRanges(system).find((range) => range.variant === "odd");
    if (!minimum) throw new Error("expected the odd breakpoint to be offered");
    expect(Number.isInteger(minimum.minWidth)).toBe(true);
    // The label keeps the value as the project authored it.
    expect(minimum.label).toContain("40.01rem");
  }, 30_000);

  it("refuses a breakpoint name a custom variant has taken over", async () => {
    const system = await loadCss(
      `@import "tailwindcss";\n@custom-variant md (&:hover);\n@theme { --breakpoint-*: initial; --breakpoint-md: 48rem; }\n`
    );
    // `md:block` compiles happily — as a hover rule with no width in it.
    expect(isValidCandidate(system, "md:block")).toBe(true);
    expect(resolveResponsiveRanges(system).map((range) => range.variant)).toEqual(["base"]);
  }, 30_000);
});

describe("scopes that only look alike", () => {
  it("keeps custom utilities targeting different descendants apart", async () => {
    const system = await loadCss(
      `@import "tailwindcss";\n@utility pad-a { & .pad-ab { padding: 1rem; } }\n@utility pad-b { & b { padding: 2rem; } }\n`
    );
    expect(isValidCandidate(system, "pad-a")).toBe(true);
    expect(isValidCandidate(system, "pad-b")).toBe(true);
    expect(findConflicts(system, ["pad-a"], "pad-b").conflicts).toEqual([]);
  }, 30_000);
});

describe("stylesheets that only resolve through the style condition", () => {
  it("loads a CSS-only package that exports no JavaScript", async () => {
    // `tw-animate-css` publishes `exports: { ".": { "style": … } }` and no
    // `./package.json` subpath, which defeats an ordinary require.resolve.
    const system = await loadCss(`@import "tailwindcss";\n@import "tw-animate-css";\n`);
    expect(isValidCandidate(system, "p-4")).toBe(true);
  }, 30_000);
});
