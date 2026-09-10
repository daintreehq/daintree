import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The project settings form exposes two persist entry points that differ only
// in whether they write when nothing changed, and picking the wrong one fails
// silently in opposite directions:
//
//   flush()   — lifecycle (dialog close, WebContentsView detach). Skips the
//               write when the form is clean, because that write spreads a
//               cached settings snapshot and would revert fields other tabs
//               saved out-of-band (#12326).
//   saveNow() — explicit user-initiated save. Always writes, because the
//               environment-variable migration button and the autosave-error
//               Retry both re-save deliberately *unchanged* values.
//
// Wire a user-facing callback to flush() and it becomes a no-op the moment the
// form is clean — the exact case both of those callers exist for. The two are
// interchangeable at the type level, so nothing in the signature catches it.
//
// Source enforcement rather than a rendering assertion is a cost call, not an
// impossibility: SettingsDialog is ~1600 lines of lazily-loaded tabs, and
// standing that up to click one Retry button buys a single assertion. The rule
// itself is structural anyway — flush() belongs to the dialog's own teardown
// path and nowhere else, so anything reachable from a JSX prop is a user
// action and must use saveNow().

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_PATH = path.resolve(TEST_DIR, "../SettingsDialog.tsx");

/** The object the form hook's return value is bound to in SettingsDialog. */
const FORM_OBJECT = "projectForm";

function parseDialog(): ts.SourceFile {
  const source = fs.readFileSync(DIALOG_PATH, "utf8");
  return ts.createSourceFile(
    DIALOG_PATH,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Names destructured off `projectForm` (`const { flush } = projectForm`), so a
 * refactor to bare identifiers stays covered instead of silently passing.
 */
function collectDestructuredNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !ts.isIdentifier(node.initializer) ||
      node.initializer.text !== FORM_OBJECT ||
      !ts.isObjectBindingPattern(node.name)
    ) {
      return;
    }
    for (const element of node.name.elements) {
      const source = element.propertyName ?? element.name;
      if (ts.isIdentifier(source)) names.add(source.text);
    }
  });
  return names;
}

/** Every reference to `projectForm.<member>`, in property-access or destructured form. */
function collectMemberReferences(sourceFile: ts.SourceFile, member: string): ts.Node[] {
  const destructured = collectDestructuredNames(sourceFile);
  const found: ts.Node[] = [];
  walk(sourceFile, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === FORM_OBJECT &&
      node.name.text === member
    ) {
      found.push(node);
      return;
    }
    // A bare identifier only counts once the name is bound off projectForm,
    // otherwise unrelated locals named `flush` would be swept in.
    if (
      destructured.has(member) &&
      ts.isIdentifier(node) &&
      node.text === member &&
      !ts.isPropertyAccessExpression(node.parent) &&
      !ts.isBindingElement(node.parent)
    ) {
      found.push(node);
    }
  });
  return found;
}

function isInsideJsxAttribute(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isJsxAttribute(current)) return true;
  }
  return false;
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

describe("SettingsDialog persist wiring", () => {
  it("never hands the lifecycle flush to a JSX callback prop", () => {
    const sourceFile = parseDialog();
    const flushRefs = collectMemberReferences(sourceFile, "flush");

    const inProps = flushRefs
      .filter(isInsideJsxAttribute)
      .map((node) => `line ${lineOf(node, sourceFile)}`);

    expect(inProps).toEqual([]);
  });

  it("still uses both entry points, so the rule above cannot pass vacuously", () => {
    const sourceFile = parseDialog();

    // flush() reaching nothing at all would mean teardown stopped persisting;
    // saveNow() reaching nothing would mean the explicit saves regressed to a
    // dirty-gated write. Either makes the assertion above meaningless.
    expect(collectMemberReferences(sourceFile, "flush").length).toBeGreaterThan(0);
    expect(collectMemberReferences(sourceFile, "saveNow").length).toBeGreaterThan(0);
  });
});
