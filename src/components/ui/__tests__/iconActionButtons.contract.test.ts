import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

/**
 * Close, dismiss and copy icon buttons are one family each, built from one
 * primitive each: `SurfaceHeaderCloseButton` for a full-surface close,
 * `DismissButton` for a card/banner/hint X, `CopyButton` for an icon-only copy.
 * A hand-rolled one drifts — the audit that produced these found seven close
 * treatments, six dismiss X's and six copy shapes.
 *
 * The scan is an AST walk, not a regex: it finds `<button>`/`<Button>` elements
 * that render an `X` glyph under a close/dismiss name, or that swap a `Copy`
 * glyph for a `Check`. The allowlist is the survivors owned by other surfaces'
 * own families (pane toolbars, tab strips, the diagnostics dock); an entry
 * that stops matching fails, so the list can only shrink.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const SCAN_ROOTS = [path.join(REPO_ROOT, "src")];

/** The primitives themselves. */
const PRIMITIVES = new Set(["src/components/ui/CopyButton.tsx"]);

const SURVIVORS: Record<string, string> = {
  // Pane toolbars: the `toolbar-icon-button` family and its 16px
  // glyphs. Their copy ticks follow the neutral rule; the buttons are the
  // toolbar's own.
  "src/components/Portal/PortalToolbar.tsx": "portal toolbar and its tab strip",
  "src/components/Portal/DevServerDashboard.tsx": "portal toolbar family",
  // Tab strips close their tabs with the tab's own control — one shared
  // `DocumentTabClose` for the grid, dock, portal and assistant strips.
  "src/components/ui/document-tab.tsx": "document tab close",
  // The dev-preview console and the diagnostics dock are twins with their own
  // shared chrome.
  "src/components/DevPreview/ConsolePanel.tsx": "dev-preview console chrome",
  "src/components/Diagnostics/DiagnosticsDock.tsx": "diagnostics dock chrome",
  "src/components/Diagnostics/ProblemsContent.tsx": "diagnostics dock chrome",
  // A ribbon family whose dismiss shares one class with the exit and disarm
  // controls beside it; changing the X alone would split them.
  "src/components/Fleet/FleetArmingRibbon.tsx": "FLEET_RIBBON_ICON_BUTTON_CLASS ribbon family",
  // A round remove control inside a suggestion chip, paired with its add.
  "src/components/Settings/VoiceInputSettingsTab.tsx": "suggestion chip",
  // A rounded-full scrim over a theme preview image, deliberately not chrome.
  "src/components/ThemeBrowser/ThemeBrowser.tsx": "scrim close over a preview",
};

const CLOSE_NAME = /^(Dismiss|Hide|Close)\b/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "__tests__", "__preview__"].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function stringAttr(node: ts.JsxOpeningLikeElement, name: string): string | undefined {
  for (const prop of node.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name) continue;
    const init = prop.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    if (init && ts.isJsxExpression(init) && init.expression) {
      const expr = init.expression;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
      if (ts.isTemplateExpression(expr)) return expr.head.text;
    }
  }
  return undefined;
}

/**
 * True when the button shows words beside its glyph — "Copy details", a
 * "Copied" swap. A labelled control is a different, legitimate shape; this
 * contract is about the icon-only ones.
 */
function hasVisibleText(node: ts.JsxElement): boolean {
  let text = false;
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n) && n.text.trim()) text = true;
    if (
      ts.isJsxExpression(n) &&
      n.parent &&
      (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
    ) {
      const hasString = (e: ts.Node): boolean =>
        ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)
          ? true
          : ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)
            ? false
            : (ts.forEachChild(e, (c) => (hasString(c) ? true : undefined)) ?? false);
      if (n.expression && hasString(n.expression)) text = true;
    }
    ts.forEachChild(n, visit);
  };
  node.children.forEach(visit);
  return text;
}

/** Glyph tag names rendered anywhere inside `node`, not crossing into a nested button. */
function glyphsWithin(node: ts.Node): Set<string> {
  const found = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxSelfClosingElement(n)) found.add(tagName(n));
    if (ts.isJsxElement(n) && n !== node && /^(button|Button)$/.test(tagName(n.openingElement))) {
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function handRolled(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isJsxElement(n) &&
      /^(button|Button)$/.test(tagName(n.openingElement)) &&
      !hasVisibleText(n)
    ) {
      const glyphs = glyphsWithin(n);
      const name = stringAttr(n.openingElement, "aria-label") ?? "";
      const line = source.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      if (glyphs.has("X") && CLOSE_NAME.test(name)) hits.push(`close/dismiss "${name}" :${line}`);
      if (glyphs.has("Copy") && glyphs.has("Check")) hits.push(`copy "${name}" :${line}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return hits;
}

describe("close, dismiss and copy icon buttons", () => {
  const found = new Map<string, string[]>();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const hits = handRolled(file);
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (hits.length && !PRIMITIVES.has(rel)) found.set(rel, hits);
    }
  }

  it("are built from the shared primitives outside the allowlisted families", () => {
    const unexpected = [...found.entries()]
      .filter(([file]) => !(file in SURVIVORS))
      .map(([file, hits]) => `${file}: ${hits.join(", ")}`);
    expect(unexpected).toEqual([]);
  });

  it("keeps no stale allowlist entry", () => {
    const stale = Object.keys(SURVIVORS).filter((file) => !found.has(file));
    expect(stale).toEqual([]);
  });
});
