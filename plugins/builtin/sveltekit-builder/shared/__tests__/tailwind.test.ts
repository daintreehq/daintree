import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appearsAsLiteralToken,
  composeCandidate,
  describeCandidate,
  findConflicts,
  isValidCandidate,
  loadTailwindDesignSystem,
  proposeCandidate,
  rangeContaining,
  readAuthoredValue,
  readBreakpoints,
  resolveResponsiveRanges,
  variantChainOf,
  type TailwindDesignSystem,
} from "../tailwind/index.js";

/**
 * Every assertion here runs against a throwaway project with a theme that is
 * deliberately not Tailwind's default — the defaults are deleted and replaced —
 * so a result that happens to match stock Tailwind proves nothing and a result
 * that matches the fixture proves the project's own CSS was read.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const sharedModules = path.join(repoRoot, "node_modules");

const CUSTOM_THEME = `@import "tailwindcss";
@theme {
  --breakpoint-*: initial;
  --breakpoint-sm: 30rem;
  --breakpoint-wide: 1400px;
  --color-brand: oklch(0.7 0.18 250);
}
`;

const tempDirs: string[] = [];

async function makeProject(css: string | null, modules: "shared" | "none" = "shared") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sveltekit-builder-tw-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  if (modules === "shared") await fs.symlink(sharedModules, path.join(dir, "node_modules"), "dir");
  if (css !== null) await fs.writeFile(path.join(dir, "app.css"), css);
  return { appRoot: dir, cssEntry: path.join(dir, "app.css") };
}

async function loadProject(css: string): Promise<TailwindDesignSystem> {
  const result = await loadTailwindDesignSystem(await makeProject(css));
  if (result.status !== "ok") throw new Error(`fixture failed to load: ${result.reason}`);
  return result.system;
}

let custom: TailwindDesignSystem;
let stock: TailwindDesignSystem;

beforeAll(async () => {
  custom = await loadProject(CUSTOM_THEME);
  stock = await loadProject(`@import "tailwindcss";\n`);
}, 60_000);

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("candidate validity", () => {
  it("rejects a candidate Tailwind cannot generate", () => {
    expect(isValidCandidate(custom, "p-4")).toBe(true);
    expect(isValidCandidate(custom, "not-a-class")).toBe(false);
  });

  it("answers about the project's theme, not Tailwind's defaults", () => {
    expect(isValidCandidate(custom, "bg-brand")).toBe(true);
    expect(isValidCandidate(stock, "bg-brand")).toBe(false);
    // `md` is a default breakpoint the fixture deletes.
    expect(isValidCandidate(stock, "md:p-4")).toBe(true);
    expect(isValidCandidate(custom, "md:p-4")).toBe(false);
  });

  it("describes a candidate by the CSS it generates", () => {
    const described = describeCandidate(custom, "bg-brand");
    expect(described?.properties).toEqual(["background-color"]);
    expect(described?.css).toContain("--color-brand");
    expect(describeCandidate(custom, "not-a-class")).toBeNull();
  });

  it("excludes @property registers from a candidate's own properties", () => {
    const described = describeCandidate(custom, "shadow-md");
    // `syntax`/`inherits`/`initial-value` live in @property blocks.
    expect(described?.properties).not.toContain("syntax");
    expect(described?.properties).toContain("--tw-shadow");
  });
});

describe("responsive ranges", () => {
  it("reads breakpoints from the project and resolves them to pixels", () => {
    const breakpoints = readBreakpoints(custom);
    expect(breakpoints.map((breakpoint) => breakpoint.name)).toEqual(["sm", "wide"]);
    const [first, second] = breakpoints;
    // 30rem against the 16px CSS initial root size.
    expect(first?.px).toBe(480);
    expect(second?.px).toBe(1400);
  });

  it("orders ranges base, minimums, maximums, then bounded intervals", () => {
    const variants = resolveResponsiveRanges(custom).map((range) => range.variant);
    expect(variants).toEqual(["base", "sm", "wide", "max-sm", "max-wide", "sm:max-wide"]);
  });

  it("carries the real bounds of each range", () => {
    const ranges = resolveResponsiveRanges(custom);
    const interval = ranges.find((range) => range.variant === "sm:max-wide");
    if (!interval) throw new Error("expected a bounded sm-to-wide interval");
    expect(interval.minWidth).toBe(480);
    expect(interval.maxWidthExclusive).toBe(1400);
    expect(interval.label).toContain("1400px");

    const minimum = ranges.find((range) => range.variant === "wide");
    if (!minimum) throw new Error("expected a wide minimum range");
    expect(minimum.minWidth).toBe(1400);
    expect(minimum.maxWidthExclusive).toBeUndefined();

    const maximum = ranges.find((range) => range.variant === "max-sm");
    if (!maximum) throw new Error("expected a max-sm range");
    expect(maximum.maxWidthExclusive).toBe(480);
    expect(maximum.minWidth).toBeUndefined();
  });

  it("offers only variant chains the project can actually compile", () => {
    const ranges = resolveResponsiveRanges(custom);
    expect(ranges.length).toBeGreaterThan(1);
    for (const range of ranges) {
      if (range.variant === "base") continue;
      expect(isValidCandidate(custom, `${range.variant}:p-4`)).toBe(true);
    }
  });

  it("derives a different range set for a project with default breakpoints", () => {
    const stockVariants = resolveResponsiveRanges(stock).map((range) => range.variant);
    expect(stockVariants).toContain("md:max-lg");
    expect(stockVariants).not.toContain("sm:max-wide");
  });

  it("maps a measured viewport width onto a range without assuming 768", () => {
    const ranges = resolveResponsiveRanges(custom);
    expect(rangeContaining(ranges, 390)?.variant).toBe("max-sm");
    expect(rangeContaining(ranges, 800)?.variant).toBe("sm:max-wide");
    expect(rangeContaining(ranges, 1600)?.variant).toBe("wide");
    // 768 is inside the fixture's sm–wide interval, not a boundary.
    expect(rangeContaining(ranges, 768)?.variant).toBe("sm:max-wide");
  });
});

describe("conflict detection", () => {
  const conflictingTokens = (system: TailwindDesignSystem, tokens: string[], candidate: string) =>
    findConflicts(system, tokens, candidate).conflicts.map((conflict) => conflict.token);

  it("finds shorthand overlaps without a utility-group table", () => {
    expect(conflictingTokens(custom, ["px-4", "pt-4", "mt-4", "flex"], "p-8").sort()).toEqual([
      "pt-4",
      "px-4",
    ]);
    expect(conflictingTokens(custom, ["pt-4", "pb-4"], "px-8")).toEqual([]);
    expect(conflictingTokens(custom, ["gap-x-2", "gap-y-2"], "gap-4").sort()).toEqual([
      "gap-x-2",
      "gap-y-2",
    ]);
    expect(conflictingTokens(custom, ["mx-2"], "ms-4")).toEqual(["mx-2"]);
  });

  it("reports the shared slots, not the declared property names", () => {
    const [conflict] = findConflicts(custom, ["px-4"], "p-8").conflicts;
    expect(conflict?.properties).toEqual(["padding-left", "padding-right"]);
  });

  it("keeps utilities in different variant scopes apart", () => {
    expect(conflictingTokens(custom, ["px-4"], "wide:px-8")).toEqual([]);
    expect(conflictingTokens(custom, ["wide:p-4"], "wide:px-8")).toEqual(["wide:p-4"]);
    expect(conflictingTokens(custom, ["px-4"], "hover:px-8")).toEqual([]);
  });

  it("treats equivalent variant chains written in either order as one scope", () => {
    expect(conflictingTokens(custom, ["sm:max-wide:p-4"], "max-wide:sm:px-8")).toEqual([
      "sm:max-wide:p-4",
    ]);
  });

  it("does not confuse utilities that compose through --tw-* registers", () => {
    expect(conflictingTokens(custom, ["shadow-md"], "ring-2")).toEqual([]);
    expect(conflictingTokens(custom, ["shadow-md"], "shadow-lg")).toEqual(["shadow-md"]);
    expect(conflictingTokens(custom, ["text-lg"], "leading-7")).toEqual([]);
    expect(conflictingTokens(custom, ["text-lg"], "text-xl")).toEqual(["text-lg"]);
    expect(conflictingTokens(custom, ["text-brand"], "text-xl")).toEqual([]);
  });

  it("does not pit a child-targeting utility against a self-targeting one", () => {
    expect(conflictingTokens(custom, ["mx-4"], "space-x-4")).toEqual([]);
  });

  it("handles escaped class names in arbitrary and digit-leading candidates", () => {
    expect(conflictingTokens(custom, ["p-[1.5rem]"], "p-4")).toEqual(["p-[1.5rem]"]);
    expect(conflictingTokens(stock, ["2xl:p-4"], "2xl:px-8")).toEqual(["2xl:p-4"]);
    expect(conflictingTokens(stock, ["2xl:p-4"], "px-8")).toEqual([]);
  });

  it("reports unrecognised tokens instead of silently dropping them", () => {
    const report = findConflicts(custom, ["site-hero", "px-4"], "p-8");
    expect(report.unresolved).toEqual(["site-hero"]);
    expect(report.conflicts.map((conflict) => conflict.token)).toEqual(["px-4"]);
  });
});

describe("property to utility mapping", () => {
  it("proposes a candidate and verifies it declares the property asked for", () => {
    expect(proposeCandidate(custom, "padding-inline", "6")).toEqual({
      status: "ok",
      candidate: "px-6",
    });
    expect(proposeCandidate(custom, "margin-top", "-4")).toEqual({
      status: "ok",
      candidate: "-mt-4",
    });
    expect(proposeCandidate(custom, "padding", "[3px]")).toEqual({
      status: "ok",
      candidate: "p-[3px]",
    });
  });

  it("proposes into a variant scope the project defines", () => {
    expect(proposeCandidate(custom, "padding-inline", "6", "wide")).toEqual({
      status: "ok",
      candidate: "wide:px-6",
    });
    expect(proposeCandidate(custom, "padding-inline", "6", "md").status).toBe("invalid-value");
  });

  it("uses the project's own tokens", () => {
    expect(proposeCandidate(custom, "color", "brand")).toEqual({
      status: "ok",
      candidate: "text-brand",
    });
    expect(proposeCandidate(stock, "color", "brand").status).toBe("invalid-value");
  });

  it("rejects a valid candidate that sets a different property", () => {
    // `text-brand` compiles, but it is a colour, not a font size.
    expect(proposeCandidate(custom, "font-size", "brand")).toEqual({
      status: "invalid-value",
      property: "font-size",
      attempted: "text-brand",
    });
  });

  it("reports an unmapped property as a gap", () => {
    expect(proposeCandidate(custom, "backdrop-filter", "blur")).toEqual({
      status: "unsupported-property",
      property: "backdrop-filter",
    });
    expect(readAuthoredValue(custom, [], "backdrop-filter").status).toBe("unsupported-property");
  });

  it("reads the authored value back per variant scope", () => {
    const tokens = ["px-6", "wide:px-10", "pt-2", "text-brand"];
    const base = readAuthoredValue(custom, tokens, "padding-inline");
    expect(base.status === "ok" && base.tokens.map((entry) => entry.token)).toEqual(["px-6"]);
    const wide = readAuthoredValue(custom, tokens, "padding-inline", "wide");
    expect(wide.status === "ok" && wide.tokens.map((entry) => entry.token)).toEqual(["wide:px-10"]);
  });

  it("round-trips an authored value back into the same candidate", () => {
    const authored = readAuthoredValue(custom, ["wide:px-10"], "padding-inline", "wide");
    if (authored.status !== "ok") throw new Error("expected a supported property");
    const entry = authored.tokens[0];
    expect(entry?.declared).toContain("var(--spacing)");
    expect(proposeCandidate(custom, "padding-inline", entry?.value ?? "", "wide")).toEqual({
      status: "ok",
      candidate: "wide:px-10",
    });
  });

  it("surfaces an already self-conflicting scope as more than one token", () => {
    const authored = readAuthoredValue(custom, ["p-4", "px-8"], "padding-inline");
    expect(authored.status === "ok" && authored.tokens.length).toBe(2);
  });
});

describe("loader guard", () => {
  it("degrades instead of throwing when Tailwind is absent", async () => {
    const result = await loadTailwindDesignSystem(
      await makeProject("@import 'tailwindcss';", "none")
    );
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.reason).toContain("not installed");
  });

  it("degrades when the CSS entry cannot be read", async () => {
    const result = await loadTailwindDesignSystem(await makeProject(null));
    expect(result.status).toBe("unavailable");
  });

  it("refuses a Tailwind outside the supported major, naming the version", async () => {
    const project = await makeProject("@import 'tailwindcss';", "none");
    await writeStubTailwind(project.appRoot, "3.4.17", "export const noop = true;\n");
    const result = await loadTailwindDesignSystem(project);
    expect(result.status === "unavailable" && result.reason).toContain("3.4.17");
    expect(result.status === "unavailable" && result.reason).toContain(
      "outside the supported major"
    );
  });

  it("degrades rather than rejecting on a nonsense project reference", async () => {
    const result = await loadTailwindDesignSystem({ appRoot: "not/absolute", cssEntry: "app.css" });
    expect(result.status).toBe("unavailable");
  });

  it("survives a v4 build whose design system has the wrong shape", async () => {
    const project = await makeProject("@import 'tailwindcss';", "none");
    await writeStubTailwind(
      project.appRoot,
      "4.99.0",
      `export async function __unstable__loadDesignSystem() {
         return { theme: { values: new Map(), prefix: null } };
       }\n`
    );
    const result = await loadTailwindDesignSystem(project);
    expect(result.status === "unavailable" && result.reason).toContain("unrecognised shape");
  });

  it("refuses a design system whose methods survive but whose results do not", async () => {
    const project = await makeProject("@import 'tailwindcss';", "none");
    await writeStubTailwind(
      project.appRoot,
      "4.99.0",
      `export async function __unstable__loadDesignSystem() {
         return {
           theme: { values: new Map(), prefix: null },
           candidatesToCss: (candidates) => candidates.map(() => ".x { color: red }"),
           candidatesToAst: () => "not an ast",
           getClassList: () => [],
         };
       }\n`
    );
    const result = await loadTailwindDesignSystem(project);
    // Answering "valid, and conflicts with nothing" would be an unavailable
    // analysis dressed as a successful one.
    expect(result.status === "unavailable" && result.reason).toContain("no readable declarations");
  });

  it("follows nested conditional exports to the compiler entry point", async () => {
    const project = await makeProject("@import 'tailwindcss';", "none");
    const dir = path.join(project.appRoot, "node_modules", "tailwindcss");
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "tailwindcss",
        version: "4.99.0",
        type: "module",
        exports: {
          ".": { node: { import: "./nested/compiler.mjs" } },
          "./package.json": "./package.json",
        },
      })
    );
    // Only reachable through the nested condition; the dist fallback is absent.
    await fs.writeFile(
      path.join(dir, "nested", "compiler.mjs"),
      "export const __unstable__loadDesignSystem = null;\n"
    );
    const result = await loadTailwindDesignSystem(project);
    expect(result.status === "unavailable" && result.reason).toContain(
      "__unstable__loadDesignSystem"
    );
  });

  it("refuses a v4 build that no longer exposes the unstable loader", async () => {
    const project = await makeProject("@import 'tailwindcss';", "none");
    await writeStubTailwind(project.appRoot, "4.99.0", "export const noop = true;\n");
    const result = await loadTailwindDesignSystem(project);
    expect(result.status === "unavailable" && result.reason).toContain(
      "__unstable__loadDesignSystem"
    );
  });
});

async function writeStubTailwind(appRoot: string, version: string, source: string) {
  const dir = path.join(appRoot, "node_modules", "tailwindcss");
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "tailwindcss",
      version,
      type: "module",
      exports: { ".": { import: "./dist/lib.mjs" }, "./package.json": "./package.json" },
    })
  );
  await fs.writeFile(path.join(dir, "dist", "lib.mjs"), source);
}

describe("variant scopes the project does not define", () => {
  it("reads nothing rather than falling back to the base scope", () => {
    const authored = readAuthoredValue(custom, ["px-6"], "padding-inline", "md");
    expect(authored.status === "ok" && authored.tokens).toEqual([]);
  });
});

describe("projects with a utility prefix", () => {
  let prefixed: TailwindDesignSystem;

  beforeAll(async () => {
    prefixed = await loadProject(
      `@import "tailwindcss" prefix(tw);\n@theme { --color-brand: oklch(0.7 0.18 250); }\n`
    );
  }, 60_000);

  it("only recognises candidates carrying the prefix", () => {
    expect(prefixed.prefix).toBe("tw");
    expect(isValidCandidate(prefixed, "p-4")).toBe(false);
    expect(isValidCandidate(prefixed, "tw:p-4")).toBe(true);
  });

  it("composes proposals and probes with the prefix ahead of the variant chain", () => {
    expect(proposeCandidate(prefixed, "padding-inline", "6", "md")).toEqual({
      status: "ok",
      candidate: "tw:md:px-6",
    });
    const authored = readAuthoredValue(prefixed, ["tw:md:px-6"], "padding-inline", "md");
    expect(authored.status === "ok" && authored.tokens.map((entry) => entry.value)).toEqual(["6"]);
  });

  it("offers range variants that compile once the prefix is applied", () => {
    for (const range of resolveResponsiveRanges(prefixed)) {
      const candidate = composeCandidate(prefixed, variantChainOf(range), "p-4");
      expect(isValidCandidate(prefixed, candidate)).toBe(true);
    }
  });

  it("still tells a theme variable apart from a --tw-* register", () => {
    // Under a prefix `tw:text-brand` reads `var(--tw-color-brand)`, which looks
    // exactly like Tailwind's own registers by name alone.
    const conflicts = findConflicts(prefixed, ["tw:text-red-500"], "tw:text-brand");
    expect(conflicts.conflicts.map((conflict) => conflict.token)).toEqual(["tw:text-red-500"]);
    expect(findConflicts(prefixed, ["tw:shadow-md"], "tw:ring-2").conflicts).toEqual([]);
  });
});

describe("composition versus conflict", () => {
  const tokens = (system: TailwindDesignSystem, existing: string[], candidate: string) =>
    findConflicts(system, existing, candidate).conflicts.map((conflict) => conflict.token);

  it("leaves utilities that co-author one composed property alone", () => {
    // Both gradient stops write an identical `--tw-gradient-stops` assembly;
    // only `--tw-gradient-from`/`-to` carry what the user chose.
    expect(tokens(custom, ["from-red-500"], "to-blue-500")).toEqual([]);
    expect(tokens(custom, ["from-red-500"], "via-green-500")).toEqual([]);
    expect(tokens(custom, ["from-red-500"], "from-blue-500")).toEqual(["from-red-500"]);
  });

  it("ignores a register write that only restates its own initial value", () => {
    // `space-x-4` initialises `--tw-space-x-reverse` to its registered initial;
    // `space-x-reverse` exists to flip it.
    expect(tokens(custom, ["space-x-4"], "space-x-reverse")).toEqual([]);
    expect(tokens(custom, ["space-x-4"], "space-x-8")).toEqual(["space-x-4"]);
  });

  it("still sees a direct override of a composed property", () => {
    expect(tokens(custom, ["shadow-md"], "[box-shadow:none]")).toEqual(["shadow-md"]);
    expect(tokens(custom, ["blur-sm"], "filter-none")).toEqual(["blur-sm"]);
  });

  it("sees shorthand overrides of longhand utilities", () => {
    expect(tokens(custom, ["bg-red-500"], "[background:none]")).toEqual(["bg-red-500"]);
    expect(tokens(custom, ["border-2"], "[border:0]")).toEqual(["border-2"]);
    expect(tokens(custom, ["outline-2"], "[outline:none]")).toEqual(["outline-2"]);
    expect(tokens(custom, ["duration-200"], "[transition:none]")).toEqual(["duration-200"]);
    expect(tokens(custom, ["w-4"], "[inline-size:8rem]")).toEqual(["w-4"]);
  });

  it("resolves logical sides against the direction the scope actually sets", () => {
    expect(tokens(custom, ["ms-4"], "ml-8")).toEqual(["ms-4"]);
    expect(tokens(custom, ["ms-4"], "mr-8")).toEqual([]);
    // Under `rtl:` the same logical side is the other physical one.
    expect(tokens(custom, ["rtl:ms-4"], "rtl:mr-8")).toEqual(["rtl:ms-4"]);
    expect(tokens(custom, ["rtl:ms-4"], "rtl:ml-8")).toEqual([]);
    expect(tokens(custom, ["ps-4"], "pe-8")).toEqual([]);
  });

  it("compares pseudo-class chains as a set, not in written order", () => {
    expect(tokens(custom, ["hover:focus:p-4"], "focus:hover:px-8")).toEqual(["hover:focus:p-4"]);
  });
});

describe("source-text reality", () => {
  it("only accepts a class that appears as an unbroken literal token", () => {
    expect(appearsAsLiteralToken('<div class="p-4 bg-brand">', "bg-brand")).toBe(true);
    expect(appearsAsLiteralToken('<div class="bg-brand-500">', "bg-brand")).toBe(false);
    expect(appearsAsLiteralToken("<div class={`bg-${color}-500`}>", "bg-red-500")).toBe(false);
    expect(appearsAsLiteralToken('class="md:p-4"', "md:p-4")).toBe(true);
  });

  it("is a separate question from whether the candidate is valid", () => {
    const source = '<div class="p-4">';
    expect(isValidCandidate(custom, "bg-brand")).toBe(true);
    expect(appearsAsLiteralToken(source, "bg-brand")).toBe(false);
  });
});

describe("authored values that a control cannot re-propose", () => {
  it("does not invent a value segment from another utility's stem", () => {
    const authored = readAuthoredValue(custom, ["p-4"], "padding-inline");
    if (authored.status !== "ok") throw new Error("expected a supported property");
    expect(authored.tokens.map((entry) => entry.token)).toEqual(["p-4"]);
    expect(authored.tokens[0]?.value).toBeNull();
  });

  it("splits the variant chain outside brackets", () => {
    const authored = readAuthoredValue(custom, ["text-[length:2rem]"], "font-size");
    if (authored.status !== "ok") throw new Error("expected a supported property");
    expect(authored.tokens[0]?.value).toBe("[length:2rem]");
    const proposal = proposeCandidate(custom, "font-size", authored.tokens[0]?.value ?? "");
    expect(proposal).toEqual({ status: "ok", candidate: "text-[length:2rem]" });
  });

  it("does not report a composition wire-up as the authored value", () => {
    // `text-lg` emits a line-height that only reads `--tw-leading`.
    const authored = readAuthoredValue(custom, ["text-lg", "leading-7"], "line-height");
    if (authored.status !== "ok") throw new Error("expected a supported property");
    expect(authored.tokens.map((entry) => entry.token)).toEqual(["leading-7"]);
  });
});
