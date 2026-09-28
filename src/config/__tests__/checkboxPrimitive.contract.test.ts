import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Every checkbox in the app is the `ui/checkbox` primitive: the same box, radius,
 * neutral checked paint, glyph, focus ring and check animation wherever it
 * appears. A native `<input type="checkbox">` paints with the OS, a hand-rolled
 * `role="checkbox"` draws its own box, and a second import of the Radix root
 * re-states the primitive's classes until they drift — each of those is how the
 * family came apart before.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const PRIMITIVE = "src/components/ui/checkbox.tsx";

/** Native checkboxes still waiting on the fix that owns their surface. Shrink only. */
const NATIVE_ALLOWLIST = new Set<string>([
  // The recipe editor's form is migrated with the rest of that form.
  "src/components/TerminalRecipe/RecipeEditor.tsx",
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "__preview__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

function attrText(el: ts.JsxOpeningLikeElement, name: string): string | undefined {
  for (const prop of el.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name) continue;
    const init = prop.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    if (init && ts.isJsxExpression(init) && init.expression) return init.expression.getText();
  }
  return undefined;
}

function containsGlyph(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
      n.tagName.getText() === "CheckboxGlyph"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

interface Violation {
  file: string;
  kind: "native" | "hand-rolled" | "radix-import";
  line: number;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const full of listSourceFiles(SRC_ROOT)) {
    const file = path.relative(REPO_ROOT, full).split(path.sep).join("/");
    if (file === PRIMITIVE) continue;
    const text = fs.readFileSync(full, "utf8");
    const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart()).line + 1;

    const visit = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "@radix-ui/react-checkbox"
      ) {
        violations.push({ file, kind: "radix-import", line: lineOf(node) });
      }
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName.getText();
        if (tag === "input" && attrText(node, "type") === "checkbox") {
          violations.push({ file, kind: "native", line: lineOf(node) });
        }
        // A button may carry the role when a whole target needs it, as long as
        // the box it draws is the shared glyph.
        if (/^[a-z]/.test(tag) && attrText(node, "role") === "checkbox") {
          const element = ts.isJsxOpeningElement(node) ? node.parent : node;
          if (!containsGlyph(element)) {
            violations.push({ file, kind: "hand-rolled", line: lineOf(node) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

describe("checkbox primitive contract", () => {
  const violations = scan();

  it("draws no native checkbox outside the shrinking allowlist", () => {
    const offenders = violations
      .filter((v) => v.kind === "native" && !NATIVE_ALLOWLIST.has(v.file))
      .map((v) => `${v.file}:${v.line}`);
    expect(offenders).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const stillNative = new Set(violations.filter((v) => v.kind === "native").map((v) => v.file));
    const stale = [...NATIVE_ALLOWLIST].filter((file) => !stillNative.has(file));
    expect(stale).toEqual([]);
  });

  it("hand-rolls no checkbox box", () => {
    const offenders = violations
      .filter((v) => v.kind === "hand-rolled")
      .map((v) => `${v.file}:${v.line}`);
    expect(offenders).toEqual([]);
  });

  it("imports the Radix checkbox only in the primitive", () => {
    const offenders = violations
      .filter((v) => v.kind === "radix-import")
      .map((v) => `${v.file}:${v.line}`);
    expect(offenders).toEqual([]);
  });
});
