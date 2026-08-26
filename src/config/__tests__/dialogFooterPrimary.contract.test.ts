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
// omission is invisible. Thirteen files had drifted that way by the time the standard
// changed.
//
// This guard closes that hatch. Inside a dialog footer a `Button` must name its variant,
// and it must not name the accent CTA — the primary action is `contrast`, secondaries are
// ghost/outline/subtle, and a dangerous action is `destructive`.
//
// KNOWN LIMITS (deliberate — a regression guard, not a sound checker):
//   - A computed variant (`variant={x}`) is not analyzed; only literals are.
//   - A spread (`{...props}`) is not treated as supplying the variant, for the same
//     reason the grid-panel guard rejects one: its contents aren't visible here.
//   - A `Button` reached through a wrapper component rendered inside the footer is
//     outside this file's view.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
];

const FOOTER_TAG = "AppDialog.Footer";
const BUTTON_TAG = "Button";
// cva's own fallback. Naming it explicitly is the same accent fill as omitting the prop,
// so both are rejected — the point is that no dialog footer paints the accent CTA.
const REJECTED_VARIANT = "default";

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

function tagNameOf(node: ts.JsxOpeningLikeElement, source: ts.SourceFile): string {
  return node.tagName.getText(source);
}

/** Literal variant, or null when absent/computed. */
function variantOf(
  element: ts.JsxOpeningLikeElement,
  source: ts.SourceFile
): { present: boolean; literal: string | null } {
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue;
    if (attribute.name.getText(source) !== "variant") continue;
    const initializer = attribute.initializer;
    if (initializer && ts.isStringLiteral(initializer)) {
      return { present: true, literal: initializer.text };
    }
    if (
      initializer &&
      ts.isJsxExpression(initializer) &&
      initializer.expression &&
      ts.isStringLiteralLike(initializer.expression)
    ) {
      return { present: true, literal: initializer.expression.text };
    }
    return { present: true, literal: null };
  }
  return { present: false, literal: null };
}

type Violation = { file: string; line: number; reason: string };

function scan(filePath: string): Violation[] {
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.includes(FOOTER_TAG)) return [];

  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const violations: Violation[] = [];
  const relative = path.relative(REPO_ROOT, filePath);

  const inspectButtons = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      tagNameOf(node, source) === BUTTON_TAG
    ) {
      const { present, literal } = variantOf(node, source);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (!present) {
        violations.push({ file: relative, line, reason: "no variant (inherits the accent CTA)" });
      } else if (literal === REJECTED_VARIANT) {
        violations.push({ file: relative, line, reason: `variant="${REJECTED_VARIANT}"` });
      }
    }
    ts.forEachChild(node, inspectButtons);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && tagNameOf(node.openingElement, source) === FOOTER_TAG) {
      for (const child of node.children) inspectButtons(child);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return violations;
}

describe("dialog footers never inherit the accent CTA (#11963)", () => {
  const files = SCAN_ROOTS.flatMap((root) => tsxFiles(root));
  const footerFiles = files.filter((file) => fs.readFileSync(file, "utf8").includes(FOOTER_TAG));

  it("finds the dialog footers it is meant to guard", () => {
    // Guards the guard: a rename that stopped matching would otherwise make the
    // contract pass by scanning nothing.
    expect(footerFiles.length).toBeGreaterThan(5);
  });

  // Proves the scanner actually fires. Written outside the repo so a crashed run
  // can't leave a stray .tsx behind for the other repo-wide contract suites.
  it("recognises hand-written footer buttons that inherit or name the accent CTA", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialog-footer-contract-"));
    const fixture = path.join(dir, "Fixture.tsx");
    fs.writeFileSync(
      fixture,
      [
        "export const D = () => (",
        "  <AppDialog.Footer>",
        '    <Button variant="ghost" onClick={cancel}>Cancel</Button>',
        "    <Button onClick={go}>Go</Button>",
        '    <Button variant="default" onClick={other}>Other</Button>',
        '    <Button variant="contrast" onClick={ok}>OK</Button>',
        "  </AppDialog.Footer>",
        ");",
      ].join("\n")
    );
    try {
      expect(scan(fixture).map((v) => v.reason)).toEqual([
        "no variant (inherits the accent CTA)",
        'variant="default"',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A Button outside a footer is none of this contract's business.
  it("ignores buttons that are not inside a dialog footer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialog-footer-contract-"));
    const fixture = path.join(dir, "Fixture.tsx");
    fs.writeFileSync(
      fixture,
      [
        "export const D = () => (",
        "  <AppDialog>",
        "    <AppDialog.Body><Button onClick={go}>Go</Button></AppDialog.Body>",
        "    <AppDialog.Footer>",
        '      <Button variant="contrast" onClick={ok}>OK</Button>',
        "    </AppDialog.Footer>",
        "  </AppDialog>",
        ");",
      ].join("\n")
    );
    try {
      expect(scan(fixture)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has no footer button inheriting or naming the accent CTA", () => {
    const violations = footerFiles.flatMap((file) => scan(file));
    expect(
      violations.map((v) => `${v.file}:${v.line} — ${v.reason}`),
      'dialog footer buttons must name a variant; the primary action is "contrast"'
    ).toEqual([]);
  });
});
