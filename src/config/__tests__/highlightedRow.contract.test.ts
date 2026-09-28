import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";

/**
 * The highlighted-row language (docs/themes/interaction-state-recipes.md,
 * "Highlighted Row"): one row is lit, by a fill, and the pointer and the arrow
 * keys move that same row. Two ways to break it that no single component test
 * sees — a cursor list that paints its own hover fill beside the cursor, and a
 * leading rail creeping back onto a highlighted row — so both are scanned for
 * across the renderer and the builtin plugin renderers.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins/builtin")];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The argument text of every `cn(...)` call that composes `PALETTE_ROW_CLASS`. */
function paletteRowCnCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("cn(", from);
    if (start === -1) break;
    let depth = 0;
    let end = start + 2;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    // Comments mention the class by name in rows that deliberately do not use it.
    const body = source
      .slice(start, end + 1)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    if (/\bPALETTE_ROW_CLASS\b/.test(body)) calls.push(body);
    from = start + 3;
  }
  return calls;
}

/**
 * List-detail browsers, where a click picks the record the detail pane shows.
 * There hover and selection really are two states, so a lighter hover step is
 * the design — see "List Row Hover" in the recipes.
 */
const LIST_DETAIL_FILES = new Set([
  "src/components/Plugin/PluginManagerView.tsx",
  "src/components/Plugin/ProjectPluginSection.tsx",
  "src/components/Diagnostics/TelemetryContent.tsx",
  "src/components/EventInspector/EventTimeline.tsx",
  "src/components/ThemeBrowser/ThemeBrowser.tsx",
]);

const files = ROOTS.flatMap(sourceFiles).map((file) => ({
  rel: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
  source: fs.readFileSync(file, "utf8"),
}));

describe("highlighted-row language", () => {
  it("never lets a cursor-driven palette row paint a hover fill of its own", () => {
    const offenders: string[] = [];
    for (const { rel, source } of files) {
      if (LIST_DETAIL_FILES.has(rel)) continue;
      for (const call of paletteRowCnCalls(source)) {
        const hoverFills = call.match(/hover:bg-[\w[\]/.-]+/g);
        if (hoverFills) offenders.push(`${rel}: ${hoverFills.join(", ")}`);
      }
    }
    expect(
      offenders,
      "A palette row's pointer moves the cursor (onPointerMove) instead of painting a second lit row"
    ).toEqual([]);
  });

  it("keeps the list-detail allowlist honest", () => {
    const stale = [...LIST_DETAIL_FILES].filter((rel) => {
      const file = files.find((f) => f.rel === rel);
      return !file || !paletteRowCnCalls(file.source).some((call) => /hover:bg-/.test(call));
    });
    expect(stale, "remove entries that no longer compose a hover step").toEqual([]);
  });

  it("draws no leading selection rail on any row", () => {
    const offenders = files
      .filter(({ source }) => /before:bg-selection-outline/.test(source))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);

    const css = fs.readFileSync(path.join(REPO_ROOT, "src/index.css"), "utf8");
    expect(css).not.toMatch(/\.palette-row[^{]*::before/);
  });

  it("makes the highlight a heavier step than the list-detail hover on every built-in theme", () => {
    // Where hover and selection coexist, the two must never be mistaken for one
    // another, so the highlight has to be the stronger lift of the two.
    const alpha = (value: string): number | null => {
      const m = value.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
      return m ? Number(m[1]) : null;
    };
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const highlight = scheme.tokens["overlay-highlight"];
      const hover = scheme.tokens["overlay-subtle"];
      expect(highlight, `${scheme.id}: overlay-highlight`).toBeTruthy();
      expect(highlight, `${scheme.id}: highlight must differ from hover`).not.toBe(hover);
      const a = alpha(highlight);
      const b = alpha(hover);
      if (scheme.type === "dark" && a !== null && b !== null) {
        expect(a, `${scheme.id}: highlight alpha vs overlay-subtle`).toBeGreaterThan(b);
      }
    }
  });
});
