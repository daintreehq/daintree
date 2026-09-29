import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(ROOT, "src");

/**
 * `Button`s that may still set `aria-pressed` themselves instead of taking
 * `pressed`, because the shared pressed look is not their state language.
 */
const RAW_ARIA_PRESSED: Record<string, string> = {
  // Chrome icon toggles: the toolbar's armed chip (`.toolbar-icon-button`) owns
  // their pressed look.
  "src/components/Layout/Toolbar.tsx": "toolbar armed chip",
  "src/components/Layout/ToolbarAssistantButton.tsx": "toolbar armed chip",
  "src/components/Layout/ToolbarPortalButton.tsx": "toolbar armed chip",
  // Checkable rows in the sources popover: a check glyph carries the state,
  // the way a menu's checkbox items do.
  "src/components/Logs/LogFilters.tsx": "checkable popover rows",
  // Show/hide value: the eye glyph is the state, the established reveal idiom.
  "src/components/Settings/AgentScopeEditor/ReadOnlyDetail.tsx": "reveal toggle",
  "src/components/Settings/EnvVarRow.tsx": "reveal toggle",
  "src/components/Settings/ImportEnvDialog.tsx": "reveal toggle",
  // Media transport: play/pause and mute carry state in the glyph.
  "src/components/Tour/TourControls.tsx": "transport control",
};

/** The one place a filter chip is drawn. */
const FILTER_CHIP_HOME = "src/components/ui/FilterChip.tsx";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "__preview__" ? [] : sourceFiles(full);
    }
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}

interface JsxSite {
  file: string;
  line: number;
  tag: string;
  attrs: Map<string, ts.JsxAttribute>;
}

function jsxSites(): JsxSite[] {
  return sourceFiles(SRC).flatMap((full) => {
    const file = path.relative(ROOT, full).split(path.sep).join("/");
    const source = ts.createSourceFile(
      full,
      readFileSync(full, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const out: JsxSite[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attrs = new Map<string, ts.JsxAttribute>();
        for (const prop of node.attributes.properties) {
          if (ts.isJsxAttribute(prop)) attrs.set(prop.name.getText(source), prop);
        }
        out.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          tag: node.tagName.getText(source),
          attrs,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  });
}

const sites = jsxSites();
const where = (s: JsxSite) => `${s.file}:${s.line}`;

function identifiers(node: ts.Node | undefined, out = new Set<string>()): Set<string> {
  if (!node) return out;
  if (ts.isIdentifier(node)) out.add(node.text);
  ts.forEachChild(node, (child) => void identifiers(child, out));
  return out;
}

/** True when `node` branches on any identifier the pressed state is read from. */
function branchesOn(node: ts.Node | undefined, state: Set<string>): boolean {
  if (!node) return false;
  if (ts.isConditionalExpression(node)) {
    if ([...identifiers(node.condition)].some((id) => state.has(id))) return true;
  }
  return ts.forEachChild(node, (child) => branchesOn(child, state) || undefined) ?? false;
}

describe("pressed toggles and filter chips", () => {
  it("toggle Buttons take `pressed`, so every one draws the shared pressed look", () => {
    const offenders = sites
      .filter((s) => s.tag === "Button" && s.attrs.has("aria-pressed"))
      .filter((s) => !(s.file in RAW_ARIA_PRESSED))
      .map(where);
    expect(offenders).toEqual([]);
  });

  it("every allowlisted raw aria-pressed Button still exists", () => {
    const live = new Set(
      sites.filter((s) => s.tag === "Button" && s.attrs.has("aria-pressed")).map((s) => s.file)
    );
    expect(Object.keys(RAW_ARIA_PRESSED).filter((file) => !live.has(file))).toEqual([]);
  });

  // A toggle's name stays put; `pressed` (or a raw `aria-pressed`) is what
  // announces the change, so a flipped name reads twice: "Close X, pressed".
  it("a pressed toggle never flips its accessible name with its state", () => {
    const offenders = sites
      .filter((s) => s.tag === "Button" && (s.attrs.has("pressed") || s.attrs.has("aria-pressed")))
      .filter((s) => {
        const pressed = s.attrs.get("pressed") ?? s.attrs.get("aria-pressed");
        return branchesOn(
          s.attrs.get("aria-label")?.initializer,
          identifiers(pressed?.initializer)
        );
      })
      .map(where);
    expect(offenders).toEqual([]);
  });

  // Restating the pressed paint at a site is how the family drifted into five
  // looks; Button owns it.
  it("no pressed toggle paints its own pressed state", () => {
    const offenders = sites
      .filter((s) => s.tag === "Button" && s.attrs.has("pressed"))
      .filter((s) => /aria-pressed:/.test(s.attrs.get("className")?.getText() ?? ""))
      .map(where);
    expect(offenders).toEqual([]);
  });

  it("filter chips are drawn by FilterChip alone", () => {
    const offenders = sites
      .filter((s) => s.attrs.has("data-filter-chip") && s.file !== FILTER_CHIP_HOME)
      .map(where);
    expect(offenders).toEqual([]);
  });
});
