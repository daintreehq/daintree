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
 * A fixed step is one that cannot follow the scale. `em` and `%` are deliberately
 * absent: they resolve against an ancestor that IS on the scale, so they track it.
 * `rem` is not — it is an absolute step in disguise, which is how `text-[0.65rem]`
 * (a 10.4px tier invented by eye) got in. Zero and the `9999px` "fully round"
 * idiom are topology, not steps.
 */
const FIXED_LENGTH = /^(?:length:)?\s*(-?\d*\.?\d+)(px|rem|pt|pc|in|cm|mm|q|ex|ch)?\s*$/i;

function isFixedLength(raw: string): boolean {
  const m = FIXED_LENGTH.exec(raw.trim());
  if (!m) return false;
  const value = Number.parseFloat(m[1]);
  if (value === 0) return false;
  if (m[2]?.toLowerCase() === "px" && Math.abs(value) >= 9999) return false;
  return true;
}

/** Any fixed length inside a value, including one hiding in a `var()` fallback. */
const hasFixedLength = (value: string): boolean => value.split(/[\s,()]+/).some(isFixedLength);

/**
 * Each matcher captures the payload, then classifies it. Classifying rather than
 * banning outright is what lets `text-[CanvasText]` and `text-[var(--x)]` through
 * while still catching `text-[0.65rem]` and `text-[length:11px]`.
 */
const MATCHERS: { name: string; re: RegExp; isOffender: (payload: string) => boolean }[] = [
  { name: "text-[…]", re: /\btext-\[([^\]]+)\]/g, isOffender: isFixedLength },
  // `-[a-z]{1,2}` covers every corner/side form: -t, -r, -tl, -ss, -ee …
  { name: "rounded-[…]", re: /\brounded(?:-[a-z]{1,2})?-\[([^\]]+)\]/g, isOffender: isFixedLength },
  {
    name: "[font-size:…] / [border-radius:…]",
    re: /\[(?:font-size|border-radius)\s*:\s*([^\]]+)\]/g,
    isOffender: isFixedLength,
  },
  {
    name: "css declaration",
    re: /(?:^|[^-\w])(?:font-size|border-radius|border-[a-z-]+-radius)\s*:\s*([^;}\n]+)/g,
    isOffender: hasFixedLength,
  },
  {
    // A bare number here is a fixed pixel size — React serialises it as px.
    name: "style object",
    re: /\b(?:fontSize|borderRadius)\s*:\s*(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*'|`[^`]*`)/g,
    isOffender: (payload) =>
      /^-?\d+(?:\.\d+)?$/.test(payload)
        ? Number.parseFloat(payload) !== 0
        : hasFixedLength(payload.replace(/^["\'`]|["\'`]$/g, "")),
  },
];

/**
 * Exact-count allowlist. Counting rather than just naming the file means a new
 * offender slipped into an already-listed file still fails, and an entry left
 * behind after its site is removed fails too — without pinning line numbers.
 */
const EXCEPTIONS: {
  file: string;
  match: string;
  count: number;
  reason: string;
}[] = [
  {
    file: "src/components/Setup/AgentSetupWizard.tsx",
    match: "text-[6px]",
    count: 3,
    reason:
      "Miniature of the app UI inside the setup wizard — the type is scenery at a fixed miniature ratio, not text anyone reads, so it must not track the real type scale",
  },
  {
    file: "src/components/Setup/AgentSetupWizard.tsx",
    match: "text-[7px]",
    count: 2,
    reason: "Same miniature; the 7px rows are the mock terminal body against the 6px chrome",
  },
  {
    file: "src/components/Project/ProjectResourceBadge.tsx",
    match: "text-[8px]",
    count: 1,
    reason:
      "A disclosure caret glyph, sized to the triangle rather than to text — putting it on the type scale would oversize it",
  },
  {
    file: "src/components/Pulse/PulseHeatmap.tsx",
    match: "rounded-[2px]",
    count: 1,
    reason:
      "Heat cells read as squares on purpose (#2645); pinned by pulseContrast.test.ts, and a theme radius would round them into dots",
  },
  {
    file: "src/components/Pulse/ProjectPulseCard.tsx",
    match: "rounded-[2px]",
    count: 3,
    reason: "Same heat-cell geometry as PulseHeatmap, plus its loading skeleton",
  },
  {
    file: "src/components/Pulse/ProjectPulseStrip.tsx",
    match: "rounded-[1px]",
    count: 1,
    reason: "Same heat-cell family at strip size, where 1px is already most of the cell",
  },
  {
    file: "src/components/Terminal/VoiceInputButton.tsx",
    match: "rounded-[1.5px]",
    count: 1,
    reason:
      "An 8x8px status mark: rounded-full would make it a circle and any scale step would round it past recognition",
  },
  {
    file: "src/components/Worktree/NewWorktreeDialog.tsx",
    match: "rounded-[4px]",
    count: 1,
    reason:
      "Deliberately off the scale — a 16px box at the theme radius reads as a radio button rather than a checkbox (see the comment at the call site)",
  },
  {
    file: "src/index.css",
    match: "border-radius: 3px",
    count: 1,
    reason:
      "Scrollbar thumb: radius is half the thumb width, so it tracks the scrollbar, not the theme",
  },
  {
    file: "src/index.css",
    match: "border-radius: 1px",
    count: 1,
    reason: "File-change recency rail is 2px wide; 1px is its half-width cap",
  },
  {
    file: "src/components/Worktree/DiffViewer.css",
    match: "border-radius: 6px",
    count: 1,
    reason:
      "Diff horizontal scrollbar thumb — scrollbar geometry, same rationale as the global one",
  },
  {
    file: "src/styles/components/toolbar.css",
    match: "border-radius: 2px",
    count: 1,
    reason:
      "WCAG 1.4.1 shape differentiator: the overflow badge encodes severity as square/slightly-rounded/pill, so its radius is semantic and must not move with the theme",
  },
  {
    file: "src/utils/renderBootstrapError.ts",
    match: "font-size:",
    count: 4,
    reason:
      "Paints the fatal-boot error screen, which is exactly the case where the app stylesheet may not have loaded — it cannot reference tokens that might not exist",
  },
  {
    file: "src/utils/renderBootstrapError.ts",
    match: "border-radius:",
    count: 2,
    reason: "Same fatal-boot screen; see above",
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

/** CSS with comments blanked out, so a commented-out rule can never satisfy a check. */
function readCss(cssPath: string): string {
  return fs.readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every `--name: value;` declaration in a stylesheet, last one wins. */
function readDeclarations(cssPath: string, prefix: string): Map<string, string> {
  const css = readCss(cssPath);
  const decls = new Map<string, string>();
  const re = new RegExp(String.raw`^\s*(${prefix}[\w-]*)\s*:\s*([^;]+);`, "gm");
  for (const m of css.matchAll(re)) decls.set(m[1], m[2].trim());
  return decls;
}

describe("numeric scales contract (#12033)", () => {
  const files = SOURCE_ROOTS.flatMap((root) => collectSourceFiles(path.join(REPO_ROOT, root)));

  it("scans a plausible slice of the app", () => {
    // Guards the guards: a broken root or an over-eager skip list would make every
    // assertion below pass by scanning nothing. A total alone is too coarse — src/
    // dwarfs plugins/, so losing the plugin walk or every .css file still clears it.
    expect(files.length).toBeGreaterThan(1000);
    for (const root of SOURCE_ROOTS) {
      expect({ root, scanned: files.some((f) => relative(f).startsWith(`${root}/`)) }).toEqual({
        root,
        scanned: true,
      });
    }
    for (const ext of [".ts", ".tsx", ".css"]) {
      expect({ ext, scanned: files.some((f) => f.endsWith(ext)) }).toEqual({ ext, scanned: true });
    }
  });

  it("keeps type and radius sizes on the shared scales", () => {
    const seen = new Map<string, { count: number; lines: number[] }>();
    const offenders: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      const lineStarts = [...content.matchAll(/\n/g)].map((m) => m.index ?? 0);
      const lineOf = (index: number) => lineStarts.filter((start) => start < index).length + 1;

      for (const { re, isOffender } of MATCHERS) {
        re.lastIndex = 0;
        for (const m of content.matchAll(re)) {
          if (!isOffender(m[1])) continue;
          // The css-declaration matcher consumes the delimiter before the property
          // (`;`, `{`, whitespace); drop it so a token reads as the declaration itself.
          const token = m[0]
            .trim()
            .replace(/\s+/g, " ")
            .replace(/^[^\w[]+/, "");
          const key = `${relative(file)}|${token}`;
          const entry = seen.get(key) ?? { count: 0, lines: [] };
          entry.count += 1;
          entry.lines.push(lineOf(m.index ?? 0));
          seen.set(key, entry);
        }
      }
    }

    // An exception is keyed by a token PREFIX so a whole-declaration match
    // (`font-size: 0.875rem`) can be allowlisted by its property alone.
    const findException = (file: string, token: string) =>
      EXCEPTIONS.find((e) => e.file === file && token.startsWith(e.match));

    const used = new Map<(typeof EXCEPTIONS)[number], number>();

    for (const [key, { count, lines }] of seen) {
      const [file, token] = key.split("|");
      const exception = findException(file, token);
      if (!exception) {
        offenders.push(
          `  ${file}:${lines.join(",")} — ${token}\n` +
            `    Not on a scale. Use text-4xs/3xs/2xs/xs/sm (or var(--text-*)) for type and\n` +
            `    var(--radius-xs…4xl) / rounded-xs…4xl for radius. If it genuinely cannot follow\n` +
            `    the scale, add an EXCEPTIONS entry saying why — do not widen an existing one.`
        );
        continue;
      }
      used.set(exception, (used.get(exception) ?? 0) + count);
    }

    for (const exception of EXCEPTIONS) {
      const actual = used.get(exception) ?? 0;
      if (actual === exception.count) continue;
      offenders.push(
        actual === 0
          ? `  ${exception.file} — stale EXCEPTIONS entry for "${exception.match}" (expected ${exception.count}). ` +
              `It is gone, so drop the entry; if the file moved, update the path.`
          : `  ${exception.file} — "${exception.match}" appears ${actual}×, allowlisted for ${exception.count}.\n` +
              `    Existing reason: ${exception.reason}\n` +
              `    ${actual > exception.count ? "Each NEW site must independently satisfy that reason — do not just raise the number." : "Lower the count to match."}`
      );
    }

    if (offenders.length > 0) throw new Error(`Off-scale sizes:\n${offenders.join("\n")}`);
  });

  it("overrides every radius step Tailwind ships", () => {
    // Tailwind's stock steps are fixed constants. Any step we leave un-overridden
    // silently stops tracking --theme-radius-scale the moment someone uses it —
    // which is exactly how --radius-4xl was missed.
    const stock = readDeclarations(TAILWIND_THEME_CSS, "--radius");
    const ours = readDeclarations(INDEX_CSS, "--radius");
    const missing = [...stock.keys()].filter((token) => !ours.has(token));
    expect(missing).toEqual([]);
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
      // Only the PRIMARY of each `var(--primary, fallback)` counts. A fallback is
      // inert whenever the primary resolves, so `var(--fixed, var(--scale))` is a
      // fixed value wearing the scale as a disguise.
      const refs = [...value.matchAll(/var\(\s*(--[\w-]+)/g)]
        .filter((m) => {
          const before = value.slice(0, m.index ?? 0);
          const opens = (before.match(/var\(/g) ?? []).length;
          const closes = (before.match(/\)/g) ?? []).length;
          return opens === closes; // not nested inside another var()'s fallback
        })
        .map((m) => m[1]);
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
    expect(steps.filter((step) => !text.has(step))).toEqual([]);
    expect(steps.filter((step) => text.has(`${step}--line-height`))).toEqual([]);
  });

  it("keeps the sub-xs steps a descending scale under text-xs", () => {
    // Names alone would let the three steps be equal, reversed, or arbitrary.
    // Comparing them to each other and to Tailwind's own floor tests the shape of
    // the scale without copying any of its values into the test.
    const rem = (value: string) => {
      const m = /^(-?\d*\.?\d+)rem$/.exec(value.trim());
      return m ? Number.parseFloat(m[1]) : Number.NaN;
    };
    const ladder = [
      rem(readDeclarations(TAILWIND_THEME_CSS, "--text-xs").get("--text-xs") ?? ""),
      ...["--text-2xs", "--text-3xs", "--text-4xs"].map((step) =>
        rem(readDeclarations(INDEX_CSS, "--text-").get(step) ?? "")
      ),
    ];

    expect(ladder.filter(Number.isNaN)).toEqual([]);
    const gaps = ladder.slice(1).map((value, i) => Number((ladder[i] - value).toFixed(6)));
    expect(gaps.filter((gap) => gap <= 0)).toEqual([]); // strictly descending
    expect(new Set(gaps).size).toBe(1); // evenly spaced
  });

  it("reaches the type steps from plain CSS", () => {
    // settings.css, the diff viewer and the CodeMirror chip styles consume these
    // as var(--text-*), which only works if the tokens are declared in a plain
    // @theme block rather than an inlined one.
    const css = readCss(INDEX_CSS); // comments stripped: a `/* } */` must not close a block
    let depth = 0;
    let inlineThemeDepth: number | null = null;
    const inlined: string[] = [];

    for (const line of css.split("\n")) {
      // Opening detection runs first so a same-line `@theme inline { --text-x: … }`
      // is still attributed to the inline block.
      if (/@theme\s+inline\s*\{/.test(line)) inlineThemeDepth = depth;
      const declared = /^\s*(--text-[\w-]+)\s*:/.exec(line);
      if (declared && inlineThemeDepth !== null) inlined.push(declared[1]);
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
    //
    // Each consumer is checked by name: a global "at least one is fine" count would
    // still pass if one call site quietly dropped its fallback.
    const CONSUMERS = [
      "src/styles/components/toolbar.css",
      "src/components/Layout/Toolbar.tsx",
      "src/components/Layout/ForgeStatsToolbarButton.tsx",
    ];

    const fallbacks = CONSUMERS.map((file) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      const at = source.indexOf("--toolbar-pill-radius");
      if (at === -1) return { file, fallback: null };
      // Walk the balanced var(...) so a calc() or nested var() fallback stays intact.
      const rest = source.slice(at);
      let depth = 1;
      let end = rest.indexOf("(");
      for (let i = rest.indexOf(",") + 1; i < rest.length && depth > 0; i++) {
        if (rest[i] === "(") depth++;
        else if (rest[i] === ")") depth--;
        if (depth === 0) end = i;
      }
      const comma = rest.indexOf(",");
      return {
        file,
        fallback: comma === -1 || comma > end ? null : rest.slice(comma + 1, end).trim(),
      };
    });

    expect(fallbacks.filter((f) => !f.fallback?.includes("var(--radius"))).toEqual([]);

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
