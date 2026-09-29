import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLOATING_CARD_CLASS,
  FLOATING_CARD_RADIUS_CLASS,
  FLOATING_CARD_SURFACE_CLASS,
  OVERLAY_SHEET_SHADOW_CLASS,
} from "@/components/ui/floatingSurface";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * Everything that floats over app content is one family. The audit behind this
 * test found floating cards in three radii (toasts `sm`, find bar `md`,
 * artifact overlay `lg`), cards painted on sidebar and panel fills, and side
 * sheets on Tailwind's black `shadow-2xl` beside one with no shadow at all.
 * These are the rules that keep them together.
 */

/** Hosts whose floating chrome must come from `floatingSurface.ts`. */
const FLOATING_CARD_HOSTS: Record<string, string> = {
  "src/components/ui/toaster.tsx": "FLOATING_CARD_RADIUS_CLASS",
  "src/components/ui/ReEntrySummary.tsx": "FLOATING_CARD_RADIUS_CLASS",
  "src/components/ui/FindBarControls.tsx": "FLOATING_CARD_CLASS",
  "src/components/ui/ScrollPill.tsx": "FLOATING_CARD_SURFACE_CLASS",
  "src/components/Terminal/ArtifactOverlay.tsx": "FLOATING_CARD_CLASS",
  "src/components/Onboarding/GettingStartedChecklist.tsx": "FLOATING_CARD_CLASS",
};

const OVERLAY_SHEET_HOSTS = [
  "src/components/Layout/AppLayout.tsx",
  "src/components/ThemeBrowser/ThemeBrowser.tsx",
];

function radiusStep(classes: string): string | null {
  const match = classes.match(/rounded-(?:\[var\(--radius-([a-z0-9]+)\)\]|([a-z0-9]+))/);
  return match?.[1] ?? match?.[2] ?? null;
}

/** The `cn(...)` / template call text around each use of `name`, balanced on parentheses. */
function callsApplying(source: string, name: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
    if (source.slice(Math.max(0, match.index - 60), match.index).includes("import")) continue;
    const open = source.lastIndexOf("cn(", match.index);
    if (open === -1) {
      calls.push(
        source.slice(source.lastIndexOf("\n", match.index), source.indexOf("\n", match.index))
      );
      continue;
    }
    let depth = 0;
    let end = open + 2;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(open, end + 1));
  }
  return calls;
}

function zToken(css: string, name: string): number {
  const match = css.match(new RegExp(`--z-${name}:\\s*(\\d+);`));
  if (!match) throw new Error(`--z-${name} not found`);
  return Number(match[1]);
}

describe("floating elevation contract", () => {
  it("gives floating cards the same radius as the popover they sit beside", () => {
    const popoverContent = read("src/components/ui/popover.tsx").match(
      /"[^"]*surface-overlay shadow-overlay[^"]*"/
    );
    expect(popoverContent).not.toBeNull();
    const popoverStep = radiusStep(popoverContent![0]);
    expect(popoverStep).not.toBeNull();
    expect(radiusStep(FLOATING_CARD_RADIUS_CLASS)).toBe(popoverStep);
    expect(FLOATING_CARD_CLASS).toContain(FLOATING_CARD_RADIUS_CLASS);
  });

  it("draws floating cards and overlay sheets with theme shadow tokens", () => {
    for (const classes of [FLOATING_CARD_SURFACE_CLASS, OVERLAY_SHEET_SHADOW_CLASS]) {
      expect(classes).toMatch(/\bshadow-\[var\(--theme-shadow-[a-z]+\)\]/);
    }
    expect(FLOATING_CARD_SURFACE_CLASS).not.toMatch(/\brounded-/);
  });

  it.each(Object.entries(FLOATING_CARD_HOSTS))(
    "%s takes its chrome from floatingSurface and restates none of it",
    (file, primitive) => {
      const source = read(file);
      expect(source).toMatch(
        new RegExp(
          `import \\{[^}]*\\b${primitive}\\b[^}]*\\} from "@/components/ui/floatingSurface"`
        )
      );
      // No class string spells the card out by hand beside the import.
      const restated = [...source.matchAll(/"[^"\n]*"/g)]
        .map(([literal]) => literal)
        .filter(
          (literal) =>
            /\bbg-surface-[a-z-]+/.test(literal) &&
            /\bborder-border-default\b/.test(literal) &&
            /\bshadow-/.test(literal)
        );
      expect(restated).toEqual([]);

      // The call that applies the primitive must not override what it owns.
      // The primitive owns the radius (unless it is the surface-only one), and
      // the fill and shadow (unless it is the radius-only one).
      const owns = {
        radius: primitive !== "FLOATING_CARD_SURFACE_CLASS",
        surface: primitive !== "FLOATING_CARD_RADIUS_CLASS",
      };
      const calls = callsApplying(source, primitive);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const literals = [...call.matchAll(/"[^"\n]*"|`[^`]*`/g)]
          .map(([literal]) => literal.replace(/\$\{[^}]*\}/g, " "))
          .join(" ");
        if (owns.radius) expect(literals).not.toMatch(/(?:^|[\s"])rounded-/);
        if (owns.surface) {
          expect(literals).not.toMatch(/(?:^|[\s"])bg-surface-/);
          expect(literals).not.toMatch(/(?:^|[\s"])shadow-/);
        }
      }
    }
  );

  it("toasts and the re-entry summary share a card shape", () => {
    for (const file of ["src/components/ui/toaster.tsx", "src/components/ui/ReEntrySummary.tsx"]) {
      expect(read(file)).not.toMatch(
        /"rounded-\[var\(--radius-(?:xs|sm|md)\)\] border border-tint/
      );
    }
  });

  it.each(OVERLAY_SHEET_HOSTS)(
    "%s lifts its overlay sheet with the shared sheet shadow",
    (file) => {
      expect(read(file)).toMatch(/\bOVERLAY_SHEET_SHADOW_CLASS\b/);
    }
  );

  it("keeps the docked assistant flat: it pushes content aside, so it casts nothing", () => {
    const helpPanel = read("src/components/HelpPanel/HelpPanel.tsx");
    expect(helpPanel).not.toMatch(/\bOVERLAY_SHEET_SHADOW_CLASS\b|shadow-\[var\(--theme-shadow-/);
  });
});

describe("app-level stacking", () => {
  const css = read("src/index.css");

  it("puts the toolbar strictly between the sheets it covers and the modals that cover it", () => {
    const toolbar = zToken(css, "toolbar");
    for (const below of ["panel", "portal", "maximized", "visual-bell"]) {
      expect(toolbar).toBeGreaterThan(zToken(css, below));
    }
    for (const above of ["modal", "popover", "nested-dialog", "toast"]) {
      expect(toolbar).toBeLessThan(zToken(css, above));
    }
  });

  it("puts the drag shield above every other layer", () => {
    const shield = zToken(css, "drag-shield");
    const others = [...css.matchAll(/--z-([a-z-]+):\s*(\d+);/g)].filter(
      ([, name]) => name !== "drag-shield"
    );
    expect(others.length).toBeGreaterThan(5);
    for (const [, name, value] of others) {
      expect(shield, `--z-${name}`).toBeGreaterThan(Number(value));
    }
  });

  it.each([
    ["src/components/Layout/Toolbar.tsx", "toolbar"],
    ["src/components/Layout/ContentDock.tsx", "panel"],
    ["src/components/Terminal/TwoPaneSplitLayout.tsx", "drag-shield"],
    ["src/panels/file-browser/FileBrowserPane.tsx", "drag-shield"],
  ])("%s stacks on --z-%s", (file, token) => {
    expect(read(file)).toContain(`var(--z-${token})`);
  });

  it("keeps the toolbar root on its token", () => {
    expect(read("src/components/Layout/Toolbar.tsx")).toMatch(
      /"@container\/toolbar[^"]*\bz-\[var\(--z-toolbar\)\]/
    );
  });

  it("stacks the body-portaled sheets on tokens, not raw numbers", () => {
    const source = read("src/components/Layout/AppLayout.tsx");
    expect(source).toContain("z-[var(--z-panel)]");
    expect(source).toContain("z-[var(--z-portal)]");
    expect(source).toContain("z-[var(--z-panel-scrim)]");
    expect(zToken(css, "panel-scrim")).toBeLessThan(zToken(css, "panel"));
    expect(source).not.toMatch(/"fixed (?:right-0 )?bottom-0 z-(?:40|50)\b/);
  });

  // The toolbar's own z-20 clusters stack inside it and are not app layers.
  it.each([
    "src/components/Layout/ContentDock.tsx",
    "src/components/Terminal/TwoPaneSplitLayout.tsx",
  ])("%s declares no raw numeric z-index", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/\bz-\[\d+\]|\bz-(?:10|20|30|40|50)\b|zIndex:\s*\d/);
  });
});
