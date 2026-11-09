import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// A middle dot between two facts renders through FactSeparator, which dims it
// and hides it from assistive tech. Drawn by hand, the dot took the row's full
// ink and its own spacing on every surface.
//
// Scope is markup: a dot in JSX text, or a string literal standing in a JSX
// child slot. A dot inside a string the code builds (a `.join(" · ")` that
// becomes an accessible name, a tooltip or a title) is text and out of view.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOT = path.join(REPO_ROOT, "src");
const PRIMITIVE = "src/components/ui/FactSeparator.tsx";

const MIDDLE_DOT = "\u00b7";
const ENTITY = /&(?:middot|#183|#x0*b7);/gi;
// Cheap pre-filter, so only files that could hold a dot are parsed: the glyph,
// an HTML entity, or a JS escape inside a string literal.
const MAY_HOLD_DOT = /\u00b7|&(?:middot|#183|#x0*b7);|\\(?:u00b7|xb7|u\{0*b7\})/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "__preview__", "node_modules", "dist"].includes(entry.name)) continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function hasDot(raw: string): boolean {
  return raw.replace(ENTITY, MIDDLE_DOT).includes(MIDDLE_DOT);
}

function isChildSlot(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxFragment(node);
}

/** The string literals a JSX child expression can render as text. */
function renderedLiterals(expr: ts.Expression): ts.StringLiteralLike[] {
  if (ts.isParenthesizedExpression(expr)) return renderedLiterals(expr.expression);
  if (ts.isStringLiteralLike(expr)) return [expr];
  if (ts.isConditionalExpression(expr)) {
    return [...renderedLiterals(expr.whenTrue), ...renderedLiterals(expr.whenFalse)];
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return [...renderedLiterals(expr.left), ...renderedLiterals(expr.right)];
  }
  return [];
}

function handRolledDots(rel: string, text: string): string[] {
  if (!MAY_HOLD_DOT.test(text)) return [];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const report = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push(`${rel}:${line + 1}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && hasDot(node.getText(sf))) report(node);
    if (ts.isJsxExpression(node) && node.expression && isChildSlot(node.parent)) {
      for (const literal of renderedLiterals(node.expression)) {
        if (hasDot(literal.text)) report(literal);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const relative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
const scanFile = (file: string) => handRolledDots(relative(file), fs.readFileSync(file, "utf8"));
const scanSnippet = (jsx: string) => handRolledDots("snippet.tsx", `const x = (${jsx});`);

describe("fact separator contract", () => {
  it("renders every middle dot in markup through FactSeparator", () => {
    const offenders = sourceFiles(SCAN_ROOT)
      .filter((file) => relative(file) !== PRIMITIVE)
      .flatMap(scanFile);
    expect(
      offenders,
      `Hand-rolled middle dot found. Render <FactSeparator /> from ${PRIMITIVE} instead.`
    ).toEqual([]);
  });

  it("still finds the primitive's own dot, so the scan is not vacuous", () => {
    expect(scanFile(path.join(REPO_ROOT, PRIMITIVE))).toHaveLength(1);
  });

  it.each([
    ["a dot in JSX text", "<span>a · b</span>"],
    ["an entity in JSX text", "<span>a &middot; b</span>"],
    ["a numeric entity", "<span>&#xB7;</span>"],
    ["a string child", '<p>a{" · "}b</p>'],
    ["an escaped string child", '<p>a{"\\u00b7"}b</p>'],
    ["a conditional string child", '<p>a{on && " · b"}</p>'],
    ["a ternary string child", '<p>a{on ? " · b" : null}</p>'],
    ["JSX passed as a prop", "<Row description={<>a · b</>} />"],
  ])("flags %s", (_, jsx) => {
    expect(scanSnippet(jsx)).toHaveLength(1);
  });

  it.each([
    ["an attribute", '<span title="a · b" />'],
    ["a joined name", '<span aria-label={[a, b].join(" · ")} />'],
    ["a rendered join", '<span>{[a, b].join(" · ")}</span>'],
    ["a template built from values", "<span>{`${a} · ${b}`}</span>"],
    ["a comment", "<span>{/* a · b */}</span>"],
  ])("leaves %s alone", (_, jsx) => {
    expect(scanSnippet(jsx)).toEqual([]);
  });
});
