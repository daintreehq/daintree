import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS = path.join(REPO_ROOT, "src/index.css");
const TAILWIND_THEME_CSS = path.join(REPO_ROOT, "node_modules/tailwindcss/theme.css");
const TOOLBAR_CSS = path.join(REPO_ROOT, "src/styles/components/toolbar.css");
const BUILT_IN_THEMES = path.join(REPO_ROOT, "shared/theme/builtInThemes");

/**
 * Two numeric scales — radius and type — are only worth having if the whole app
 * is on them. #12033 catalogued ~1400 sites that had invented their own values.
 *
 * The radius scale is the load-bearing one: every `--radius-*` step derives from
 * `--radius`, which multiplies by `--theme-radius-scale`, which built-in themes
 * set per-theme (Movile 0.6 … Hokkaido 1.05). A value that sits outside that
 * derivation chain stays put while its neighbours move, which is how you get a
 * half-scaled UI. The bug is invisible at the default scale of 1, so it needs a
 * test rather than an eye.
 */

const SOURCE_ROOTS = ["src", "plugins"];
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__mocks__"]);

/**
 * Fixed values that survive review. `9999px` is deliberately absent from the
 * patterns: it is a topology ("fully round"), not a step on the scale.
 */
const PATTERNS = {
  "text-[Npx]": /\btext-\[\d+(?:\.\d+)?px\]/g,
  "rounded-[Npx]": /\brounded(?:-[trblse])?-\[\d+(?:\.\d+)?px\]/g,
  "font-size px": /(?:\bfont-size:\s*|\bfontSize:\s*")(?!9999px)\d+(?:\.\d+)?px/g,
  "border-radius px": /(?:\bborder-radius:\s*|\bborderRadius:\s*")(?!9999px)\d+(?:\.\d+)?px/g,
} as const;

type PatternName = keyof typeof PATTERNS;

/**
 * Exact-count allowlist. Counting rather than just naming the file means a new
 * offender slipped into an already-listed file still fails, and an entry left
 * behind after its site is removed fails too — without pinning line numbers.
 */
const EXCEPTIONS: {
  file: string;
  pattern: PatternName;
  match: string;
  count: number;
  reason: string;
}[] = [
  {
    file: "src/components/Setup/AgentSetupWizard.tsx",
    pattern: "text-[Npx]",
    match: "text-[6px]",
    count: 3,
    reason:
      "Miniature of the app UI inside the setup wizard — the type is scenery at a fixed miniature ratio, not text anyone reads, so it must not track the real type scale",
  },
  {
    file: "src/components/Setup/AgentSetupWizard.tsx",
    pattern: "text-[Npx]",
    match: "text-[7px]",
    count: 2,
    reason: "Same miniature; the 7px rows are the mock terminal body against the 6px chrome",
  },
  {
    file: "src/components/Project/ProjectResourceBadge.tsx",
    pattern: "text-[Npx]",
    match: "text-[8px]",
    count: 1,
    reason:
      "A ▼/▶ disclosure glyph, sized to the caret rather than to text — putting it on the type scale would oversize the triangle",
  },
  {
    file: "src/components/Pulse/PulseHeatmap.tsx",
    pattern: "rounded-[Npx]",
    match: "rounded-[2px]",
    count: 1,
    reason:
      "Heat cells read as squares on purpose (#2645); pinned by pulseContrast.test.ts, and a theme radius would round them into dots",
  },
  {
    file: "src/components/Pulse/ProjectPulseCard.tsx",
    pattern: "rounded-[Npx]",
    match: "rounded-[2px]",
    count: 3,
    reason: "Same heat-cell geometry as PulseHeatmap, plus its loading skeleton",
  },
  {
    file: "src/components/Pulse/ProjectPulseStrip.tsx",
    pattern: "rounded-[Npx]",
    match: "rounded-[1px]",
    count: 1,
    reason: "Same heat-cell family at strip size, where 1px is already most of the cell",
  },
  {
    file: "src/components/Terminal/VoiceInputButton.tsx",
    pattern: "rounded-[Npx]",
    match: "rounded-[1.5px]",
    count: 1,
    reason:
      "An 8×8px status mark: rounded-full would make it a circle and any scale step would round it past recognition",
  },
  {
    file: "src/components/Worktree/NewWorktreeDialog.tsx",
    pattern: "rounded-[Npx]",
    match: "rounded-[4px]",
    count: 1,
    reason:
      "Deliberately off the scale — a 16px box at the theme radius reads as a radio button rather than a checkbox (see the comment at the call site)",
  },
  {
    file: "src/index.css",
    pattern: "border-radius px",
    match: "border-radius: 3px",
    count: 1,
    reason:
      "Scrollbar thumb: radius is half the thumb width, so it tracks the scrollbar, not the theme",
  },
  {
    file: "src/index.css",
    pattern: "border-radius px",
    match: "border-radius: 1px",
    count: 1,
    reason: "File-change recency rail is 2px wide; 1px is its half-width cap",
  },
  {
    file: "src/components/Worktree/DiffViewer.css",
    pattern: "border-radius px",
    match: "border-radius: 6px",
    count: 1,
    reason:
      "Diff horizontal scrollbar thumb — scrollbar geometry, same rationale as the global one",
  },
  {
    file: "src/styles/components/toolbar.css",
    pattern: "border-radius px",
    match: "border-radius: 2px",
    count: 1,
    reason:
      "WCAG 1.4.1 shape differentiator: the overflow badge encodes severity as square/slightly-rounded/pill, so its radius is semantic and must not move with the theme",
  },
];

function collectSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      result.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;
    if (/\.(test|spec)\./.test(entry.name)) continue;
    result.push(fullPath);
  }
  return result;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** Every `--name: value;` declaration in a stylesheet, last one wins. */
function readDeclarations(cssPath: string, prefix: string): Map<string, string> {
  const css = fs.readFileSync(cssPath, "utf8");
  const decls = new Map<string, string>();
  const re = new RegExp(String.raw`^\s*(${prefix}[\w-]*)\s*:\s*([^;]+);`, "gm");
  for (const m of css.matchAll(re)) decls.set(m[1], m[2].trim());
  return decls;
}

describe("numeric scales contract (#12033)", () => {
  const files = SOURCE_ROOTS.flatMap((root) => collectSourceFiles(path.join(REPO_ROOT, root)));

  it("scans a plausible slice of the app", () => {
    // Guards the guards: a broken root or an over-eager skip list would make
    // every assertion below pass by scanning nothing.
    expect(files.length).toBeGreaterThan(1000);
  });

  it("keeps type and radius sizes on the shared scales", () => {
    const seen = new Map<string, number>();
    const offenders: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const [name, re] of Object.entries(PATTERNS) as [PatternName, RegExp][]) {
        for (const match of content.match(re) ?? []) {
          const normalized = match.replace(/\s+/g, " ").replace(/"$/, "");
          const key = `${relative(file)}|${name}|${normalized}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
    }

    const allowed = new Map(
      EXCEPTIONS.map((e) => [`${e.file}|${e.pattern}|${e.match}`, e.count] as const)
    );

    for (const [key, count] of seen) {
      const [file, pattern, match] = key.split("|");
      const budget = allowed.get(key);
      if (budget === undefined) {
        offenders.push(
          `  ${file} — ${count}× ${match} (${pattern}) is not on the scale. ` +
            `Use text-4xs/3xs/2xs/xs/sm or var(--radius-xs…4xl); if the value is deliberately ` +
            `off-scale, add it to EXCEPTIONS with a reason.`
        );
      } else if (count !== budget) {
        offenders.push(
          `  ${file} — ${match} (${pattern}) appears ${count}×, allowlisted for ${budget}. ` +
            `Update the EXCEPTIONS entry if this is intended.`
        );
      }
    }

    for (const [key, budget] of allowed) {
      if (!seen.has(key)) {
        const [file, pattern, match] = key.split("|");
        offenders.push(
          `  ${file} — stale EXCEPTIONS entry for ${match} (${pattern}, expected ${budget}×); it is gone, so drop the entry.`
        );
      }
    }

    if (offenders.length > 0) throw new Error(`Off-scale sizes:\n${offenders.join("\n")}`);
    expect(offenders).toEqual([]);
  });

  it("overrides every radius step Tailwind ships", () => {
    // Tailwind's stock steps are fixed constants. Any step we leave un-overridden
    // silently stops tracking --theme-radius-scale the moment someone uses it —
    // which is exactly how --radius-4xl was missed.
    const stock = readDeclarations(TAILWIND_THEME_CSS, "--radius");
    const ours = readDeclarations(INDEX_CSS, "--radius");
    const missing = [...stock.keys()].filter((token) => !ours.has(token));
    expect({ missing, stockCount: stock.size }).toEqual({ missing: [], stockCount: stock.size });
    expect(stock.size).toBeGreaterThan(1);
  });

  it("derives every radius token from the theme radius scale", () => {
    const ours = readDeclarations(INDEX_CSS, "--radius");
    const SCALE = "--theme-radius-scale";

    const reaches = (token: string, seen = new Set<string>()): boolean => {
      if (seen.has(token)) return false;
      seen.add(token);
      const value = ours.get(token);
      if (value === undefined) return false;
      const refs = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
      return refs.some((ref) => ref === SCALE || reaches(ref, seen));
    };

    const detached = [...ours.keys()].filter((token) => !reaches(token));
    expect(detached).toEqual([]);
    expect(ours.size).toBeGreaterThan(1);
  });

  it("emits the sub-xs type steps as font-size only", () => {
    // A --text-<name>--line-height sibling makes the utility set line-height too.
    // These steps replace bare arbitrary values that only ever set font-size, so
    // a paired leading here would reflow hundreds of call sites that inherit it.
    const text = readDeclarations(INDEX_CSS, "--text-");
    const steps = ["--text-2xs", "--text-3xs", "--text-4xs"];
    expect(steps.filter((s) => !text.has(s))).toEqual([]);
    expect([...text.keys()].filter((token) => token.endsWith("--line-height"))).toEqual([]);
  });

  it("reaches the type steps from plain CSS", () => {
    // settings.css and the CodeMirror chip styles consume these as var(--text-*),
    // which only works if the tokens are declared in a plain @theme block rather
    // than an inlined one.
    const css = fs.readFileSync(INDEX_CSS, "utf8");
    let depth = 0;
    let inlineThemeDepth: number | null = null;
    const inlined: string[] = [];

    for (const line of css.split("\n")) {
      const declared = /^\s*(--text-[\w-]+)\s*:/.exec(line);
      if (declared && inlineThemeDepth !== null) inlined.push(declared[1]);
      if (/@theme\s+inline\s*\{/.test(line)) inlineThemeDepth = depth;
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (inlineThemeDepth !== null && depth <= inlineThemeDepth) inlineThemeDepth = null;
        }
      }
    }

    expect(inlined).toEqual([]);
  });

  it("keeps the toolbar pill radius on the scale", () => {
    // Every theme that set this token set it to the same 0.5rem literal, and the
    // fallback was that literal too — so the pill was the one piece of chrome that
    // never moved with the theme's radius. Both halves have to stay on the scale.
    const fallbacks = [TOOLBAR_CSS, ...SOURCE_ROOTS.map((r) => path.join(REPO_ROOT, r))]
      .flatMap((p) => (fs.statSync(p).isDirectory() ? collectSourceFiles(p) : [p]))
      .flatMap((file) =>
        [
          ...fs
            .readFileSync(file, "utf8")
            .matchAll(/--toolbar-pill-radius\s*,\s*([^)]*\)?[^),]*)/g),
        ].map((m) => ({ file: relative(file), fallback: m[1].trim() }))
      );

    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks.filter((f) => !f.fallback.includes("var(--radius"))).toEqual([]);

    const pinned = fs
      .readdirSync(BUILT_IN_THEMES)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        [
          ...fs
            .readFileSync(path.join(BUILT_IN_THEMES, f), "utf8")
            .matchAll(/"toolbar-pill-radius":\s*"([^"]*)"/g),
        ].map((m) => ({ theme: f, value: m[1] }))
      )
      .filter((entry) => !entry.value.includes("var(--radius"));

    expect(pinned).toEqual([]);
  });
});
