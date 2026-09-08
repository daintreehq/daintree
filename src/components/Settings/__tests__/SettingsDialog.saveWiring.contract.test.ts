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
// form is clean — the exact case both of those callers exist for. No render
// test can see the difference: both are `() => Promise<void>` and both resolve.
// So the rule is enforced on the source. flush() belongs to the dialog's own
// teardown path and nowhere else; anything reachable from a JSX prop is a user
// action and must use saveNow().

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_PATH = path.resolve(TEST_DIR, "../SettingsDialog.tsx");

/** The object the form hook is destructured onto in SettingsDialog. */
const FORM_OBJECT = "projectForm";

function parseDialog(): ts.SourceFile {
  const source = fs.readFileSync(DIALOG_PATH, "utf8");
  return ts.createSourceFile(DIALOG_PATH, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/** Every `projectForm.<member>` access in the file, with the member name. */
function collectFormAccesses(sourceFile: ts.SourceFile): ts.PropertyAccessExpression[] {
  const found: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === FORM_OBJECT
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
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
  it("routes every JSX-prop persist callback through saveNow, never flush", () => {
    const sourceFile = parseDialog();
    const accesses = collectFormAccesses(sourceFile);

    const flushInProps = accesses
      .filter((node) => node.name.text === "flush" && isInsideJsxAttribute(node))
      .map((node) => `line ${lineOf(node, sourceFile)}`);

    expect(flushInProps).toEqual([]);
  });

  it("still hands flush to the dialog's own teardown path", () => {
    const sourceFile = parseDialog();
    const accesses = collectFormAccesses(sourceFile);

    // Guards the assertion above against passing vacuously once `flush` is
    // renamed or the teardown call is dropped altogether.
    const flushCalls = accesses.filter((node) => node.name.text === "flush");
    expect(flushCalls.length).toBeGreaterThan(0);
    expect(flushCalls.every((node) => !isInsideJsxAttribute(node))).toBe(true);
  });

  it("wires the explicit user-initiated saves to saveNow", () => {
    const sourceFile = parseDialog();
    const accesses = collectFormAccesses(sourceFile);

    // The environment-variable editor's onFlush and the autosave-error Retry.
    const saveNowInProps = accesses.filter(
      (node) => node.name.text === "saveNow" && isInsideJsxAttribute(node)
    );
    expect(saveNowInProps.length).toBeGreaterThanOrEqual(2);
  });
});
