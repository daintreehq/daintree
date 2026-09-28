import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// A dialog's header X is always there. While an action runs, or while the dialog can't
// be dismissed, it stays in place and reads as unavailable — `AppDialog.CloseButton`
// disables itself from the dialog's own `dismissible`, and `ConfirmDialog` locks
// dismissal while its confirm is loading. What drifted was the callers: twenty-five
// dialogs removed the X instead, either by rendering it conditionally or by handing
// `ConfirmDialog` an `onClose` that goes `undefined` mid-action. The header then jumped
// the moment the user pressed the primary, and the same job looked different in every
// dialog that did it.
//
// KNOWN LIMITS (a regression guard, not a sound checker): a close button reached through
// a wrapper component, or an `onClose` built in a variable or helper, is outside this
// file's view. `onClose` is only rejected when a branch is a literal `undefined`/`null`
// or the expression is a `&&` guard.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins/builtin")];

const CLOSE_TAG = "AppDialog.CloseButton";
const CONFIRM_TAG = "ConfirmDialog";

// Coverage ratchets at the current actuals: a drop means the walk went blind.
const MIN_CLOSE_BUTTONS_INSPECTED = 25;
const MIN_CONFIRM_DIALOGS_INSPECTED = 80;

function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      if (entry.name === "__preview__" || entry.name === "dist") continue;
      tsxFiles(full, found);
    } else if (entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

type Violation = { file: string; line: number; reason: string };
type ScanResult = { violations: Violation[]; closeButtons: number; confirmDialogs: number };

/** True when the element only renders on one side of a `&&` or a ternary. */
function isConditionallyRendered(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isJsxElement(current) && !ts.isJsxFragment(current)) {
    if (ts.isConditionalExpression(current)) return true;
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isAbsentLiteral(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isAbsentLiteral(node.expression);
  if (ts.isIdentifier(node) && node.text === "undefined") return true;
  return node.kind === ts.SyntaxKind.NullKeyword;
}

/** An `onClose` that can evaluate to nothing, which drops the X. */
function onCloseCanVanish(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) return onCloseCanVanish(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return isAbsentLiteral(expression.whenTrue) || isAbsentLiteral(expression.whenFalse);
  }
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

function scan(filePath: string): ScanResult {
  const text = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const relative = path.relative(REPO_ROOT, filePath);
  const result: ScanResult = { violations: [], closeButtons: 0, confirmDialogs: 0 };
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      if (tag === CLOSE_TAG) {
        result.closeButtons += 1;
        const element = ts.isJsxOpeningElement(node) ? node.parent : node;
        if (isConditionallyRendered(element)) {
          result.violations.push({
            file: relative,
            line: lineOf(node),
            reason: "close button rendered conditionally",
          });
        }
      } else if (tag === CONFIRM_TAG) {
        result.confirmDialogs += 1;
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== "onClose") continue;
          const initializer = attribute.initializer;
          if (
            initializer &&
            ts.isJsxExpression(initializer) &&
            initializer.expression &&
            onCloseCanVanish(initializer.expression)
          ) {
            result.violations.push({
              file: relative,
              line: lineOf(attribute),
              reason: "onClose can be undefined, which removes the close button",
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

describe("dialog close button stays in place while busy", () => {
  const results = SCAN_ROOTS.flatMap((root) => tsxFiles(root))
    .filter((file) => {
      const text = fs.readFileSync(file, "utf8");
      return text.includes(CLOSE_TAG) || text.includes(`<${CONFIRM_TAG}`);
    })
    .map((file) => scan(file));

  it("inspects the close buttons and confirm dialogs it is meant to guard", () => {
    const closeButtons = results.reduce((total, r) => total + r.closeButtons, 0);
    const confirmDialogs = results.reduce((total, r) => total + r.confirmDialogs, 0);
    expect(closeButtons).toBeGreaterThanOrEqual(MIN_CLOSE_BUTTONS_INSPECTED);
    expect(confirmDialogs).toBeGreaterThanOrEqual(MIN_CONFIRM_DIALOGS_INSPECTED);
  });

  it("never removes the close button to lock a dialog", () => {
    const violations = results.flatMap((r) => r.violations);
    expect(
      violations.map((v) => `${v.file}:${v.line} — ${v.reason}`),
      "lock the dialog with `dismissible` / `isConfirmLoading` / `isBusy`; the X disables itself"
    ).toEqual([]);
  });

  function withFixture(lines: string[], assert: (result: ScanResult) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialog-close-contract-"));
    const fixture = path.join(dir, "Fixture.tsx");
    fs.writeFileSync(fixture, lines.join("\n"));
    try {
      assert(scan(fixture));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("catches a conditionally rendered close button", () => {
    withFixture(
      [
        "export const D = () => (",
        "  <AppDialog.Header>",
        "    <AppDialog.Title>T</AppDialog.Title>",
        "    {!busy && <AppDialog.CloseButton />}",
        "    {done ? null : <AppDialog.CloseButton />}",
        "  </AppDialog.Header>",
        ");",
        "export const E = () => (",
        "  <AppDialog.Header>",
        "    <AppDialog.CloseButton />",
        "  </AppDialog.Header>",
        ");",
      ],
      (result) => {
        expect(result.closeButtons).toBe(3);
        expect(result.violations.map((v) => v.line)).toEqual([4, 5]);
      }
    );
  });

  it("catches an onClose that goes undefined while busy", () => {
    withFixture(
      [
        "export const D = () => (",
        "  <>",
        "    <ConfirmDialog onClose={busy ? undefined : close} />",
        "    <ConfirmDialog onClose={busy ? null : () => close()} />",
        "    <ConfirmDialog onClose={!busy && close} />",
        "    <ConfirmDialog onClose={close} />",
        "    <ConfirmDialog onClose={() => { if (busy) return; close(); }} />",
        "  </>",
        ");",
      ],
      (result) => {
        expect(result.confirmDialogs).toBe(5);
        expect(result.violations.map((v) => v.line)).toEqual([3, 4, 5]);
      }
    );
  });
});
