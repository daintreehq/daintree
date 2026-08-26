import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// `AppDialog.Footer`'s `primaryAction` prop resolves the CTA's variant centrally, so
// every dialog that uses it followed #11963 for free. A footer that hand-writes its
// buttons instead bypasses that resolver entirely: `<Button>` with no variant falls
// through to cva's `default`, the accent fill, and looks correct in review because the
// omission is invisible. Fourteen files had drifted that way by the time the standard
// changed.
//
// This guard closes that hatch. Inside a dialog footer a `Button` must name its variant,
// and it must not name the accent CTA — the primary action is `contrast`, secondaries are
// ghost/outline/subtle, and a dangerous action is `destructive`.
//
// KNOWN LIMITS (deliberate — a regression guard, not a sound checker):
//   - A variant expression that isn't statically resolvable to string literals (a call, an
//     imported constant) is reported as unresolvable and counted, not rejected. Ternaries
//     and `||`/`??` chains over literals ARE resolved, so `variant={x ? "default" : "ghost"}`
//     is caught.
//   - A spread (`{...props}`) is not treated as supplying the variant, for the same reason
//     the grid-panel guard rejects one: its contents aren't visible here.
//   - A `Button` reached through a wrapper component rendered inside the footer, or a
//     locally aliased `Button`, is outside this file's view.
//   - Dialogs that don't use `AppDialog.Footer` at all (a hand-rolled footer row in the
//     body) are not in scope; this guards the footer contract, not every button in every
//     dialog.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
];

const APP_DIALOG_MODULE = "components/ui/AppDialog";
const DEFAULT_DIALOG_BINDING = "AppDialog";
const FOOTER_MEMBER = "Footer";
const BUTTON_TAG = "Button";
// cva's own fallback. Naming it explicitly is the same accent fill as omitting the prop,
// so both are rejected — the point is that no dialog footer paints the accent CTA.
const REJECTED_VARIANT = "default";

// Ratchets. These are floors, not exact counts: they exist so a rename or refactor that
// stopped matching can't leave the contract green by inspecting nothing. Raise them only
// alongside a deliberate change in how many footers exist.
const MIN_FOOTERS_INSPECTED = 20;
const MIN_BUTTONS_INSPECTED = 40;

function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      tsxFiles(full, found);
    } else if (entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The local name `AppDialog` is bound to in this file. Almost always "AppDialog", but an
 * alias would otherwise slip every footer in the file past the tag-name match.
 */
function dialogBinding(source: ts.SourceFile): string {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !specifier.text.includes(APP_DIALOG_MODULE)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === DEFAULT_DIALOG_BINDING) return element.name.text;
    }
  }
  return DEFAULT_DIALOG_BINDING;
}

/**
 * Every string literal an expression can evaluate to, or null when that can't be
 * determined statically. Covers the shapes a variant realistically takes.
 */
function literalValues(node: ts.Expression): string[] | null {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literalValues(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalValues(node.whenTrue);
    const whenFalse = literalValues(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const left = literalValues(node.left);
    const right = literalValues(node.right);
    return left && right ? [...left, ...right] : null;
  }
  return null;
}

type VariantInfo =
  { kind: "absent" } | { kind: "literals"; values: string[] } | { kind: "unresolvable" };

function variantOf(element: ts.JsxOpeningLikeElement): VariantInfo {
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue;
    if (attribute.name.getText() !== "variant") continue;
    const initializer = attribute.initializer;
    if (!initializer) return { kind: "unresolvable" };
    if (ts.isStringLiteral(initializer)) return { kind: "literals", values: [initializer.text] };
    if (ts.isJsxExpression(initializer) && initializer.expression) {
      const values = literalValues(initializer.expression);
      return values ? { kind: "literals", values } : { kind: "unresolvable" };
    }
    return { kind: "unresolvable" };
  }
  return { kind: "absent" };
}

type Violation = { file: string; line: number; reason: string };
type ScanResult = { violations: Violation[]; footers: number; buttons: number };

function scan(filePath: string): ScanResult {
  const text = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const footerTag = `${dialogBinding(source)}.${FOOTER_MEMBER}`;
  const result: ScanResult = { violations: [], footers: 0, buttons: 0 };
  const relative = path.relative(REPO_ROOT, filePath);

  const inspectButtons = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === BUTTON_TAG
    ) {
      result.buttons += 1;
      const variant = variantOf(node);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (variant.kind === "absent") {
        result.violations.push({
          file: relative,
          line,
          reason: "no variant (inherits the accent CTA)",
        });
      } else if (variant.kind === "literals" && variant.values.includes(REJECTED_VARIANT)) {
        result.violations.push({ file: relative, line, reason: `variant="${REJECTED_VARIANT}"` });
      }
    }
    ts.forEachChild(node, inspectButtons);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === footerTag) {
      result.footers += 1;
      for (const child of node.children) inspectButtons(child);
      // Buttons handed in as props (`children={<Button/>}`, `hint={...}`) render inside
      // the footer just the same.
      inspectButtons(node.openingElement.attributes);
    } else if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === footerTag) {
      result.footers += 1;
      inspectButtons(node.attributes);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return result;
}

describe("dialog footers never inherit the accent CTA (#11963)", () => {
  const results = SCAN_ROOTS.flatMap((root) => tsxFiles(root))
    .filter((file) => fs.readFileSync(file, "utf8").includes(`.${FOOTER_MEMBER}`))
    .map((file) => scan(file));

  const footers = results.reduce((total, r) => total + r.footers, 0);
  const buttons = results.reduce((total, r) => total + r.buttons, 0);

  // Guards the guard. A rename, an alias, or a refactor that stopped matching would
  // otherwise leave this contract green because it walked nothing — and it counts AST
  // nodes actually inspected, not files whose text happens to mention the tag.
  it("inspects the dialog footers it is meant to guard", () => {
    expect(footers, "footer elements matched by the AST walk").toBeGreaterThanOrEqual(
      MIN_FOOTERS_INSPECTED
    );
    expect(buttons, "buttons inspected inside those footers").toBeGreaterThanOrEqual(
      MIN_BUTTONS_INSPECTED
    );
  });

  it("has no footer button inheriting or naming the accent CTA", () => {
    const violations = results.flatMap((r) => r.violations);
    expect(
      violations.map((v) => `${v.file}:${v.line} — ${v.reason}`),
      'dialog footer buttons must name a variant; the primary action is "contrast"'
    ).toEqual([]);
  });

  // Fixtures live outside the repo so a crashed run can't leave a stray .tsx behind for
  // the other repo-wide contract suites.
  function withFixture(lines: string[], assert: (result: ScanResult) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialog-footer-contract-"));
    const fixture = path.join(dir, "Fixture.tsx");
    fs.writeFileSync(fixture, lines.join("\n"));
    try {
      assert(scan(fixture));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("catches a footer button that inherits or names the accent CTA", () => {
    withFixture(
      [
        'import { AppDialog } from "@/components/ui/AppDialog";',
        "export const D = () => (",
        "  <AppDialog.Footer>",
        '    <Button variant="ghost" onClick={cancel}>Cancel</Button>',
        "    <Button onClick={go}>Go</Button>",
        '    <Button variant="default" onClick={other}>Other</Button>',
        '    <Button variant="contrast" onClick={ok}>OK</Button>',
        "  </AppDialog.Footer>",
        ");",
      ],
      (result) => {
        expect(result.violations.map((v) => v.reason)).toEqual([
          "no variant (inherits the accent CTA)",
          'variant="default"',
        ]);
        expect(result.buttons).toBe(4);
        expect(result.footers).toBe(1);
      }
    );
  });

  it("follows an aliased AppDialog import", () => {
    withFixture(
      [
        'import { AppDialog as Modal } from "@/components/ui/AppDialog";',
        "export const D = () => (",
        "  <Modal.Footer>",
        "    <Button onClick={go}>Go</Button>",
        "  </Modal.Footer>",
        ");",
      ],
      (result) => {
        expect(result.footers).toBe(1);
        expect(result.violations.map((v) => v.reason)).toEqual([
          "no variant (inherits the accent CTA)",
        ]);
      }
    );
  });

  it("resolves a conditional variant and rejects the branch that paints accent", () => {
    withFixture(
      [
        'import { AppDialog } from "@/components/ui/AppDialog";',
        "export const D = () => (",
        "  <AppDialog.Footer>",
        '    <Button variant={danger ? "destructive" : "default"}>A</Button>',
        '    <Button variant={danger ? "destructive" : "contrast"}>B</Button>',
        "    <Button variant={computeVariant()}>C</Button>",
        "  </AppDialog.Footer>",
        ");",
      ],
      (result) => {
        // Only the branch that can resolve to the accent CTA is rejected; an
        // unresolvable expression is a documented known limit, not a violation.
        expect(result.violations.map((v) => v.reason)).toEqual(['variant="default"']);
        expect(result.buttons).toBe(3);
      }
    );
  });

  it("sees a button handed to a self-closing footer as a prop", () => {
    withFixture(
      [
        'import { AppDialog } from "@/components/ui/AppDialog";',
        "export const D = () => (",
        "  <AppDialog.Footer hint={<Button onClick={go}>Go</Button>} />",
        ");",
      ],
      (result) => {
        expect(result.footers).toBe(1);
        expect(result.violations.map((v) => v.reason)).toEqual([
          "no variant (inherits the accent CTA)",
        ]);
      }
    );
  });

  it("ignores buttons that are not inside a dialog footer", () => {
    withFixture(
      [
        'import { AppDialog } from "@/components/ui/AppDialog";',
        "export const D = () => (",
        "  <AppDialog>",
        "    <AppDialog.Body><Button onClick={go}>Go</Button></AppDialog.Body>",
        "    <AppDialog.Footer>",
        '      <Button variant="contrast" onClick={ok}>OK</Button>',
        "    </AppDialog.Footer>",
        "  </AppDialog>",
        ");",
      ],
      (result) => {
        expect(result.violations).toEqual([]);
        expect(result.buttons).toBe(1);
      }
    );
  });
});
