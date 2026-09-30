import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Inline row controls, their tooltips, and the unavailable dim. Each rule is
// one the app drifted on site by site: a 20px pin beside a 24px one, a fill
// that snapped because only opacity transitioned, an OS tooltip on one row and
// a styled one on its neighbour, a 40% dim beside a 70% one for the same state.
//
// KNOWN LIMITS (a regression guard, not a sound checker):
//   - Only literal class strings are read.
//   - A row control is recognised as a `span` with an `onClick` that is
//     `role="presentation"` or `aria-hidden` — the only shape a control inside
//     `role="option"`/`role="menuitem"` can take.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const SCAN_ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins")];

/**
 * Presentational click targets that are glyph toggles rather than row controls:
 * they draw no fill and replace a glyph in its own slot.
 */
const GLYPH_TOGGLES: Record<string, string> = {
  "src/components/Layout/DockLaunchButton.tsx": "preset disclosure chevron in the icon column",
  "src/components/Worktree/WorktreeOverviewRow.tsx": "selection checkbox in the type-icon slot",
  "src/panels/file-browser/FileTreeView.tsx": "tree disclosure chevron",
  "src/components/PluginKit/PluginKitFileTree.tsx":
    "the kit FileTree's disclosure chevron, as the host tree's",
  "src/components/PluginKit/PluginKitPatterns.tsx":
    "the kit ListRow's selection checkbox in the icon slot, as the worktree overview grid's",
};

/** Elements that already own the keyboard, so text inside must not add a tab stop. */
const FOCUS_HOST_TAGS = new Set([
  "button",
  "Button",
  "DropdownMenuItem",
  "ContextMenuItem",
  "C.Item",
]);
const FOCUS_HOST_ROLES = new Set(["option", "menuitem"]);
const FOCUSABLE_CHILD_TAGS = new Set(["button", "Button", "a", "input", "select", "textarea"]);

function tsxFiles(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "__tests__", "__preview__", "dist"].includes(entry.name)) continue;
      tsxFiles(full, found);
    } else if (entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) return prop;
  }
  return undefined;
}

function literal(attr: ts.JsxAttribute | undefined): string | undefined {
  const init = attr?.initializer;
  if (!init) return attr ? "true" : undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const expr = init.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    return expr.getText();
  }
  return undefined;
}

const sources = SCAN_ROOTS.flatMap((root) => tsxFiles(root)).map((file) =>
  ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
);

// Forward slashes on every platform, to match the allowlists.
const rel = (source: ts.SourceFile) =>
  path.relative(REPO_ROOT, source.fileName).split(path.sep).join("/");
function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${rel(source)}:${line + 1}`;
}

/** Visits every JSX element with its enclosing JSX elements, innermost last. */
function visitJsx(
  source: ts.SourceFile,
  visit: (opening: Opening, ancestors: Opening[]) => void
): void {
  const walk = (node: ts.Node, ancestors: Opening[]) => {
    let next = ancestors;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      visit(opening, ancestors);
      next = [...ancestors, opening];
    }
    node.forEachChild((child) => walk(child, next));
  };
  walk(source, []);
}

function isRowControl(opening: Opening): boolean {
  if (opening.tagName.getText() !== "span" || !attribute(opening, "onClick")) return false;
  const role = literal(attribute(opening, "role"));
  const hidden = literal(attribute(opening, "aria-hidden"));
  return role === "presentation" || hidden === "true";
}

describe("row controls", () => {
  it("share ROW_CONTROL_CLASS and explain themselves through RowControlTooltip", () => {
    const violations: string[] = [];
    let inspected = 0;
    for (const source of sources) {
      visitJsx(source, (opening, ancestors) => {
        if (!isRowControl(opening)) return;
        if (GLYPH_TOGGLES[rel(source)]) {
          const cls = attribute(opening, "className")?.getText() ?? "";
          if (!cls.includes("ROW_CONTROL_CLASS")) return;
        }
        inspected++;
        const cls = attribute(opening, "className")?.getText() ?? "";
        if (!cls.includes("ROW_CONTROL_CLASS")) violations.push(`${where(source, opening)} class`);
        if (attribute(opening, "title")) violations.push(`${where(source, opening)} title`);
        const parent = ancestors.at(-1)?.tagName.getText();
        if (parent !== "RowControlTooltip") violations.push(`${where(source, opening)} tooltip`);
      });
    }
    // Coverage floor: the palette, launcher, Quick Run, plugin tray and agent menu.
    expect(inspected).toBeGreaterThanOrEqual(7);
    expect(violations).toEqual([]);
  });
});

describe("truncated text", () => {
  it("never discloses its full text through a native title", () => {
    const violations: string[] = [];
    for (const source of sources) {
      visitJsx(source, (opening) => {
        const tag = opening.tagName.getText();
        if (tag[0] !== tag[0]!.toLowerCase() || !attribute(opening, "title")) return;
        const cls = attribute(opening, "className")?.getText() ?? "";
        if (/\btruncate\b/.test(cls)) violations.push(where(source, opening));
      });
    }
    expect(violations).toEqual([]);
  });

  it("adds no tab stop inside a row that already owns the keyboard", () => {
    const violations: string[] = [];
    for (const source of sources) {
      visitJsx(source, (opening, ancestors) => {
        if (opening.tagName.getText() !== "TruncatedTooltip") return;
        if (literal(attribute(opening, "focusable")) === "false") return;
        const insideHost = ancestors.some(
          (a) =>
            FOCUS_HOST_TAGS.has(a.tagName.getText()) ||
            FOCUS_HOST_ROLES.has(literal(attribute(a, "role")) ?? "")
        );
        if (!insideHost) return;
        // A focusable child takes no extra tabIndex from TruncatedTooltip.
        const element = opening.parent;
        const child = ts.isJsxElement(element)
          ? element.children.find((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c))
          : undefined;
        const childTag = child
          ? (ts.isJsxElement(child)
              ? child.openingElement
              : (child as ts.JsxSelfClosingElement)
            ).tagName.getText()
          : "";
        if (FOCUSABLE_CHILD_TAGS.has(childTag)) return;
        violations.push(where(source, opening));
      });
    }
    expect(violations).toEqual([]);
  });
});

describe("unavailable dim", () => {
  // 50% and cursor-not-allowed (`ARIA_DISABLED_CLASSES`), or secondary text plus
  // a stated reason. Busy is a spinner, never a dim.
  const OFF_SCALE_OPACITY = /(?<![-:\w])opacity-(?!50\b|100\b|0\b)\d+/;

  it("is 50% wherever a disabled variant sets opacity", () => {
    const violations: string[] = [];
    for (const source of sources) {
      const text = source.getFullText();
      for (const match of text.matchAll(/(?<![-\w])(aria-)?disabled:opacity-(\d+)/g)) {
        if (match[2] === "50" || match[2] === "100") continue;
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(`${rel(source)}:${line} ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("never pairs cursor-not-allowed or an unavailable flag with another level", () => {
    const flag =
      /\b(isDisabled|disabled|needsSetup|isShadowed|isDimmed|unavailable|isUnavailable|busy|isBusy|isCopying\w*|!is\w*Launchable|!can\w+)\s*(&&|\?)\s*$/;
    const availableElse = /\b(can\w+|is\w*Launchable|isEnabled|enabled)\s*\?\s*"[^"]*"\s*:\s*$/;
    const violations: string[] = [];
    for (const source of sources) {
      const walk = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const value = node.text;
          if (OFF_SCALE_OPACITY.test(value)) {
            const before = source
              .getFullText()
              .slice(Math.max(0, node.getFullStart() - 240), node.getStart());
            const paired = /(?<![-:\w])cursor-(not-allowed|wait)\b/.test(value);
            const context = before.replace(/\s+/g, " ");
            // `flag && "…"`, `flag ? "…"`, or the else branch of an availability
            // test: `canOpen ? "…" : "opacity-40"`.
            const flagged = flag.test(context) || availableElse.test(context);
            if (paired || flagged) violations.push(`${where(source, node)} ${value}`);
          }
        }
        node.forEachChild(walk);
      };
      walk(source);
    }
    expect(violations).toEqual([]);
  });
});
