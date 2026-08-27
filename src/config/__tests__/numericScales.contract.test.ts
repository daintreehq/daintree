import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS = path.join(REPO_ROOT, "src/index.css");
const TAILWIND_THEME_CSS = path.join(REPO_ROOT, "node_modules/tailwindcss/theme.css");
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

/** Which scale a value is supposed to be following. */
type Scale = "type" | "radius";

/**
 * Whether a unit still tracks its scale. This is deliberately different per
 * scale, because the same unit can be honest for one and a disguise for the
 * other:
 *   - `em`/`%` resolve against the parent's font size, so they follow the TYPE
 *     scale. For radius they follow the type scale instead of the radius one,
 *     which is precisely a corner that moves for the wrong reason.
 *   - `%` on a radius is topology ("half the box"), not a step, so it is fine.
 *   - `rem` follows neither: it is an absolute step in disguise, which is how
 *     `text-[0.65rem]` (a 10.4px tier invented by eye) got in.
 *   - viewport and container units follow neither.
 */
const FOLLOWS_SCALE: Record<Scale, Set<string>> = {
  type: new Set(["em", "%"]),
  radius: new Set(["%"]),
};

const LENGTH = /^(?:length:)?\s*(-?\d*\.?\d+)\s*(%|[a-z]+)?$/i;

function isFixedLength(raw: string, scale: Scale): boolean {
  const m = LENGTH.exec(raw.trim());
  if (!m?.[1]) return false;
  const value = Number.parseFloat(m[1]);
  if (value === 0) return false; // zero is the same at every scale
  const unit = m[2]?.toLowerCase();
  if (unit && FOLLOWS_SCALE[scale].has(unit)) return false;
  // The "fully round" idiom is topology, not a step.
  if (unit === "px" && Math.abs(value) >= 9999) return false;
  return true;
}

/**
 * Any fixed length anywhere in a value — inside `calc()`, inside a `var()`
 * fallback, inside a shorthand. Splitting on separators is enough because a
 * length is always its own token.
 */
const containsFixedLength = (value: string, scale: Scale): boolean =>
  value
    .split(/[\s,()]+/)
    .filter(Boolean)
    .some((token) => isFixedLength(token, scale));

/**
 * Each matcher captures a payload, then classifies it. Classifying rather than
 * banning outright is what lets `text-[CanvasText]`, `text-[var(--x)]` and
 * `border-radius: 50%` through while still catching `text-[0.65rem]`,
 * `text-[length:11px]`, `rounded-[calc(4px)]` and `text-[var(--x, 11px)]`.
 */
const MATCHERS: { re: RegExp; scale: Scale }[] = [
  { re: /\btext-\[([^\]]+)\]/g, scale: "type" },
  // `-[a-z]{1,2}` covers every corner/side form: -t, -r, -tl, -ss, -ee …
  { re: /\brounded(?:-[a-z]{1,2})?-\[([^\]]+)\]/g, scale: "radius" },
  { re: /\[font-size\s*:\s*([^\]]+)\]/g, scale: "type" },
  { re: /\[border-[a-z-]*radius\s*:\s*([^\]]+)\]/g, scale: "radius" },
  { re: /(?:^|[^-\w])font-size\s*:\s*([^;}\n]+)/g, scale: "type" },
  { re: /(?:^|[^-\w])border-(?:[a-z-]+-)?radius\s*:\s*([^;}\n]+)/g, scale: "radius" },
  // A bare number in a style object is a fixed pixel size — React serialises it as px.
  { re: /\bfontSize\s*(?:=|:)\s*(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*'|`[^`]*`)/g, scale: "type" },
  {
    re: /\b(?:borderRadius|border[A-Z][a-zA-Z]*Radius)\s*(?:=|:)\s*(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*'|`[^`]*`)/g,
    scale: "radius",
  },
];

/**
 * A fixed length can hide one hop behind a custom property: `--_size: 10px`
 * consumed by `font-size: var(--_size)` never appears in a font-size declaration
 * at all. Resolve one hop per file so what actually lands on the element is what
 * gets classified — that indirection is how the toolbar chip stayed at 10px.
 */
function indirectHits(content: string): { token: string; line: number }[] {
  const consumed = new Map<string, Scale>();
  const consumers: { re: RegExp; scale: Scale }[] = [
    { re: /(?:^|[^-\w])font-size\s*:\s*([^;}\n]+)/g, scale: "type" },
    { re: /(?:^|[^-\w])border-(?:[a-z-]+-)?radius\s*:\s*([^;}\n]+)/g, scale: "radius" },
  ];

  for (const { re, scale } of consumers) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      for (const name of primaryVarRefs(m[1] ?? "")) consumed.set(name, scale);
    }
  }

  const hits: { token: string; line: number }[] = [];
  for (const [name, scale] of consumed) {
    // The scale's own steps are defined in terms of fixed offsets (`--radius-md:
    // calc(var(--radius) - 2px)`) — that IS the scale, not an escape from it.
    // Their correctness is the derivation and ladder tests' job, not this one's.
    if (/^--(radius|text)(-|$)/.test(name)) continue;
    const declaration = new RegExp(`^\\s*(${name})\\s*:\\s*([^;}\\n]+)`, "gm");
    for (const m of content.matchAll(declaration)) {
      const value = m[2];
      if (value === undefined || !isOffender(value, scale)) continue;
      hits.push({
        token: `${name}: ${value.trim()}`,
        line: content.slice(0, m.index ?? 0).split("\n").length,
      });
    }
  }
  return hits;
}

function isOffender(payload: string, scale: Scale): boolean {
  const unquoted = payload.replace(/^["'`]|["'`]$/g, "");
  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return Number.parseFloat(unquoted) !== 0;
  return containsFixedLength(unquoted, scale);
}

/**
 * Exact-count allowlist. Counting rather than just naming the file means a new
 * offender slipped into an already-listed file still fails, and an entry left
 * behind after its site is removed fails too — without pinning line numbers.
 */
/**
 * Exact-count allowlist. Counting rather than just naming the file means a new
 * offender slipped into an already-listed file still fails, and an entry left
 * behind after its site is removed fails too — without pinning line numbers.
 *
 * `match` is compared exactly by default so an entry cannot quietly cover a
 * different value in the same file; `prefix: true` opts into covering a whole
 * property, which only makes sense when the exemption is the file, not the value.
 */
const EXCEPTIONS: {
  file: string;
  match: string;
  count: number;
  reason: string;
  prefix?: boolean;
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
    prefix: true,
    count: 4,
    reason:
      "Paints the fatal-boot error screen, which is exactly the case where the app stylesheet may not have loaded — it cannot reference tokens that might not exist",
  },
  {
    file: "src/utils/renderBootstrapError.ts",
    match: "border-radius:",
    prefix: true,
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

/**
 * The variables a value actually depends on: the primary of each `var(--x, …)`,
 * skipping any `var()` nested inside another one's fallback. A fallback is inert
 * whenever its primary resolves, so `var(--fixed, var(--scale))` is a fixed value
 * wearing the scale as a disguise — counting it would let a detached token pass.
 */
function primaryVarRefs(value: string): string[] {
  const refs: string[] = [];
  const openIsVar: boolean[] = [];

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") {
      const isVar = /\bvar\s*$/.test(value.slice(0, i));
      if (isVar && !openIsVar.some(Boolean)) {
        const named = /^\(\s*(--[\w-]+)/.exec(value.slice(i))?.[1];
        if (named !== undefined) refs.push(named);
      }
      openIsVar.push(isVar);
    } else if (ch === ")") {
      openIsVar.pop();
    }
  }

  return refs;
}

/** The fallback of `var(--name, fallback)`, read by walking to its matching paren. */
function varFallback(source: string, name: string): string | null {
  const at = source.indexOf(name);
  if (at === -1) return null;

  let depth = 1; // `at` sits just inside the enclosing `var(`
  let comma = -1;
  for (let i = at; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return comma === -1 ? null : source.slice(comma + 1, i).trim();
    } else if (ch === "," && depth === 1 && comma === -1) {
      comma = i;
    }
  }
  return null;
}

/** Every `--name: value;` declaration in a stylesheet, last one wins. */
function readDeclarations(cssPath: string, prefix: string): Map<string, string> {
  const css = readCss(cssPath);
  const decls = new Map<string, string>();
  const re = new RegExp(String.raw`^\s*(${prefix}[\w-]*)\s*:\s*([^;]+);`, "gm");
  for (const m of css.matchAll(re)) {
    const [, name, value] = m;
    if (name !== undefined && value !== undefined) decls.set(name, value.trim());
  }
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
    type Hit = { file: string; token: string; lines: number[] };
    const hits = new Map<string, Hit>();
    const offenders: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      const rel = relative(file);

      for (const indirect of indirectHits(content)) {
        const key = `${rel}\u0000${indirect.token}`;
        const hit = hits.get(key) ?? { file: rel, token: indirect.token, lines: [] };
        hit.lines.push(indirect.line);
        hits.set(key, hit);
      }

      for (const { re, scale } of MATCHERS) {
        re.lastIndex = 0;
        for (const m of content.matchAll(re)) {
          const payload = m[1];
          if (payload === undefined || !isOffender(payload, scale)) continue;
          // The css-declaration matchers consume the delimiter before the
          // property (`;`, `{`, whitespace); drop it so the token reads as the
          // declaration itself.
          const token = m[0]
            .trim()
            .replace(/\s+/g, " ")
            .replace(/^[^\w[]+/, "");
          const key = `${rel}\u0000${token}`;
          const hit = hits.get(key) ?? { file: rel, token, lines: [] };
          hit.lines.push(content.slice(0, m.index ?? 0).split("\n").length);
          hits.set(key, hit);
        }
      }
    }

    const matches = (exception: (typeof EXCEPTIONS)[number], hit: Hit) =>
      exception.file === hit.file &&
      (exception.prefix ? hit.token.startsWith(exception.match) : hit.token === exception.match);

    const used = new Map<(typeof EXCEPTIONS)[number], number>();

    for (const hit of hits.values()) {
      const exception = EXCEPTIONS.find((e) => matches(e, hit));
      if (!exception) {
        offenders.push(
          `  ${hit.file}:${hit.lines.join(",")} — ${hit.token}\n` +
            `    Not on a scale. Use text-4xs/3xs/2xs/xs/sm (or var(--text-*)) for type and\n` +
            `    var(--radius-xs…4xl) / rounded-xs…4xl for radius. If it genuinely cannot follow\n` +
            `    the scale, add an EXCEPTIONS entry saying why — do not widen an existing one.`
        );
        continue;
      }
      used.set(exception, (used.get(exception) ?? 0) + hit.lines.length);
    }

    for (const exception of EXCEPTIONS) {
      const actual = used.get(exception) ?? 0;
      if (actual === exception.count) continue;
      offenders.push(
        actual === 0
          ? `  ${exception.file} — stale EXCEPTIONS entry for "${exception.match}" ` +
              `(expected ${exception.count}). It is gone, so drop the entry; if the file moved, update the path.`
          : `  ${exception.file} — "${exception.match}" appears ${actual}x, allowlisted for ${exception.count}.\n` +
              `    Existing reason: ${exception.reason}\n` +
              `    ${
                actual > exception.count
                  ? "Each NEW site must independently satisfy that reason — do not just raise the number."
                  : "Lower the count to match."
              }`
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
      return primaryVarRefs(value).some((ref) => ref === SCALE || reaches(ref, seen));
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
    const rem = (value: string | undefined) => {
      const m = value === undefined ? null : /^(-?\d*\.?\d+)rem$/.exec(value.trim());
      return m?.[1] === undefined ? Number.NaN : Number.parseFloat(m[1]);
    };
    const ours = readDeclarations(INDEX_CSS, "--text-");
    const ladder = [
      rem(readDeclarations(TAILWIND_THEME_CSS, "--text-xs").get("--text-xs")),
      ...["--text-2xs", "--text-3xs", "--text-4xs"].map((step) => rem(ours.get(step))),
    ];

    expect(ladder.filter(Number.isNaN)).toEqual([]);
    const gaps = ladder
      .slice(1)
      .map((value, i) => Number(((ladder[i] ?? Number.NaN) - value).toFixed(6)));
    expect(gaps.filter((gap) => !(gap > 0))).toEqual([]); // strictly descending
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
      const declared = /^\s*(--text-[\w-]+)\s*:/.exec(line)?.[1];
      if (declared !== undefined && inlineThemeDepth !== null) inlined.push(declared);
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
    const TOKEN = "--toolbar-pill-radius";

    // Discovered repo-wide, not from a fixed list: a fourth consumer added later
    // with a hardcoded fallback has to fail too.
    const references = files.flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return [...source.matchAll(new RegExp(`var\\(\\s*${TOKEN}`, "g"))].map((m) => ({
        file: relative(file),
        fallback: varFallback(source.slice(m.index ?? 0), TOKEN),
      }));
    });

    expect(references.length).toBeGreaterThan(0);

    // A fallback only tracks the scale if a radius token is its PRIMARY reference —
    // `var(--fixed, var(--radius-md))` is the same disguise reaches() rejects.
    const detached = references.filter(
      (ref) =>
        ref.fallback === null ||
        !primaryVarRefs(ref.fallback).some((name) => name.startsWith("--radius"))
    );
    expect(detached).toEqual([]);

    const pinned = fs
      .readdirSync(BUILT_IN_THEMES)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        [
          ...fs
            .readFileSync(path.join(BUILT_IN_THEMES, f), "utf8")
            .matchAll(new RegExp(`"${TOKEN.slice(2)}":\\s*"([^"]*)"`, "g")),
        ].map((m) => ({ theme: f, value: m[1] ?? "" }))
      )
      .filter((entry) => !primaryVarRefs(entry.value).some((n) => n.startsWith("--radius")));

    expect(pinned).toEqual([]);
  });
});
