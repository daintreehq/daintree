import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The three circular arrows each mean one thing (docs/themes/component-contract.md,
// "Action glyphs"). They drifted until Retry wore all three and one dev-server
// restart wore two, so a user could not learn what any of them promised:
//   - RefreshCw — do it again / fetch it again: Retry, Refresh, Check again.
//   - RotateCw — reload a page or view, restart a process or session.
//   - RotateCcw — go back: restore, reset, revert, undo, replay, resume.
// Plus the smaller concepts that had split: Copy URL wears Copy (Link is for
// linking), edit is Pencil, Project settings the Settings cog, Clone
// repository FolderDown, Open project FolderOpen, a worktree FolderGit2.
//
// Each icon is tied to the label beside it: the text or aria-label of the JSX
// element that holds it, the `label` of the object literal that names it, or
// the `label` attribute of the element it is handed to.
//
// KNOWN LIMITS (deliberate — a regression guard, not a sound checker): a label
// built at runtime or passed in from elsewhere is outside its view.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins/builtin")];

const ROTATION = new Set(["RefreshCw", "RotateCw", "RotateCcw"]);
const GLYPHS = new Set([
  ...ROTATION,
  "Link",
  "Link2",
  "Copy",
  "Settings",
  "Settings2",
  "FolderDown",
  "FolderOpen",
  "FolderGit2",
  "GitBranch",
  "Download",
  "Plus",
  "Check",
]);

type Concept = "go-back" | "reload" | "again";

function rotationConcept(label: string): Concept | null {
  if (/\b(restore|reset|revert|undo|replay|resume|discard)\b/i.test(label)) return "go-back";
  if (/\b(restart|reload)/i.test(label)) return "reload";
  if (
    /\b(retr(y|ying)|try again|check again|re-?check|refresh|re-?scan|fetch|redraw)\b/i.test(label)
  )
    return "again";
  return null;
}

const ROTATION_GLYPH: Record<Concept, string> = {
  "go-back": "RotateCcw",
  reload: "RotateCw",
  again: "RefreshCw",
};

function problem(icon: string, label: string): string | null {
  if (ROTATION.has(icon)) {
    const concept = rotationConcept(label);
    if (concept && ROTATION_GLYPH[concept] !== icon) {
      return `"${label}" is ${concept}, which wears ${ROTATION_GLYPH[concept]}, not ${icon}`;
    }
    if (icon === "RotateCcw" && concept !== "go-back") {
      return `RotateCcw means going back; "${label}" is not a restore, reset, revert or undo`;
    }
  }
  if (/^copy\b/i.test(label) && (icon === "Link" || icon === "Link2")) {
    return `"${label}" copies, so it wears Copy; ${icon} is for linking`;
  }
  if (/\bproject settings/i.test(label) && icon !== "Settings") {
    return `"${label}" wears the Settings cog, not ${icon}`;
  }
  if (/^clone repo/i.test(label) && icon !== "FolderDown") {
    return `"${label}" wears FolderDown, not ${icon}`;
  }
  if (/^open project\b(?!\s+settings)/i.test(label) && icon !== "FolderOpen") {
    return `"${label}" wears FolderOpen, not ${icon}`;
  }
  if (/\bworktrees?\b/i.test(label) && icon === "GitBranch") {
    return `"${label}" counts worktrees, which wear FolderGit2; GitBranch is a branch`;
  }
  return null;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "__tests__", "__preview__", "dist"].includes(entry.name)) continue;
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function stringAttr(node: ts.JsxOpeningLikeElement, name: string): string | null {
  for (const prop of node.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name) continue;
    const init = prop.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    if (init && ts.isJsxExpression(init) && init.expression) {
      const expr = init.expression;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    }
  }
  return null;
}

// The visible text an element carries, ignoring nested elements' own subtrees
// except plain text wrappers.
function elementText(element: ts.JsxElement): string {
  const parts: string[] = [];
  for (const child of element.children) {
    if (ts.isJsxText(child)) parts.push(child.text);
    else if (ts.isJsxExpression(child) && child.expression) {
      const expr = child.expression;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
        parts.push(expr.text);
    } else if (ts.isJsxElement(child) && child.openingElement.attributes.properties.length === 0) {
      parts.push(elementText(child));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function labelForJsxIcon(iconNode: ts.JsxOpeningLikeElement): string | null {
  // The icon sits inside a holder (`<Button>`, `<DropdownMenuItem>`, …): its
  // text names the action, falling back to its aria-label for icon-only ones.
  let holder: ts.Node | undefined = ts.isJsxOpeningElement(iconNode)
    ? iconNode.parent.parent
    : iconNode.parent;
  // Conditional icon swaps (`copied ? <Check/> : <Copy/>`) sit one level down.
  while (holder && !ts.isJsxElement(holder) && !ts.isSourceFile(holder)) holder = holder.parent;
  if (!holder || !ts.isJsxElement(holder)) return null;
  const text = elementText(holder);
  if (text) return text;
  return stringAttr(holder.openingElement, "aria-label");
}

function labelForObjectIcon(prop: ts.PropertyAssignment): string | null {
  const object = prop.parent;
  if (!ts.isObjectLiteralExpression(object)) return null;
  for (const key of ["label", "ariaLabel", "title"]) {
    for (const p of object.properties) {
      if (!ts.isPropertyAssignment(p) || p.name.getText() !== key) continue;
      if (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))
        return p.initializer.text;
    }
  }
  return null;
}

interface Hit {
  icon: string;
  label: string;
  line: number;
}

function iconsWithLabels(file: string): Hit[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const hits: Hit[] = [];
  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const push = (icon: string, label: string | null, node: ts.Node) => {
    if (label) hits.push({ icon, label, line: lineOf(node) });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(source);
      if (GLYPHS.has(tag)) push(tag, labelForJsxIcon(node), node);
      // `<SpinningIcon icon={RefreshCw} />`, `<ProjectCommandRow icon={Settings} label="…" />`
      for (const prop of node.attributes.properties) {
        if (!ts.isJsxAttribute(prop) || prop.name.getText(source) !== "icon") continue;
        const init = prop.initializer;
        if (!init || !ts.isJsxExpression(init) || !init.expression) continue;
        const name = init.expression.getText(source);
        if (!GLYPHS.has(name)) continue;
        push(name, stringAttr(node, "label") ?? labelForJsxIcon(node), node);
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "icon" &&
      ts.isIdentifier(node.initializer) &&
      GLYPHS.has(node.initializer.text)
    ) {
      push(node.initializer.text, labelForObjectIcon(node), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("action glyph vocabulary", () => {
  const files = SCAN_ROOTS.flatMap((root) => sourceFiles(root));
  const hits = files.flatMap((file) => {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    return iconsWithLabels(file).map((hit) => ({ ...hit, file: rel }));
  });

  it("ties a real body of icons to their labels", () => {
    expect(hits.filter((h) => ROTATION.has(h.icon)).length).toBeGreaterThan(60);
  });

  it("gives each concept one glyph", () => {
    const offenders = hits.flatMap((hit) => {
      const why = problem(hit.icon, hit.label);
      return why ? [`${hit.file}:${hit.line} — ${why}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("draws edit with Pencil, not the deprecated Edit aliases", () => {
    const offenders = files
      .filter((file) =>
        /import\s*\{[^}]*\b(Edit|Edit2|Edit3)\b[^}]*\}\s*from\s*"lucide-react"/.test(
          fs.readFileSync(file, "utf8")
        )
      )
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
