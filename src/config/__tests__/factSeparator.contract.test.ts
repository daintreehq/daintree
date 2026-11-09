import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// A middle dot between two facts renders through FactSeparator, which dims it
// and hides it from assistive tech. Drawn by hand, the dot took the row's full
// ink and its own spacing on every surface.
//
// Scope is markup: a dot in JSX text, or in a string or template literal a JSX
// child slot can render. A dot inside a string the code hands elsewhere (a
// `.join(" · ")`, an accessible name, a tooltip or a title prop) is text and
// out of view.
//
// KNOWN LIMITS (a syntactic guard, not a sound checker): markup built with
// `createElement` or in `.ts` files is not scanned, and a literal behind a
// constant condition (`{false && " · "}`) is flagged though it never renders.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOT = path.join(REPO_ROOT, "src");
const PRIMITIVE = "src/components/ui/FactSeparator.tsx";
// Tour scenes are drawn against `@daintreehq/tour`'s public surface alone
// (Tour/__tests__/sceneIsolation.contract.test.ts), so they can't import the
// host primitive.
const EXEMPT_DIRS = ["src/components/Tour/scenes/"];

const MIDDLE_DOT = "\u00b7";
// The entities the JSX transform decodes: HTML5-only names like `&centerdot;`
// and an uppercase `&#X` reach the page as typed.
const JSX_ENTITY = /&(?:middot|#0*183|#x0*[bB]7);/g;

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

/** JSX text is HTML-like: its entities render as the characters they name. */
function jsxTextHasDot(raw: string): boolean {
  return raw.replace(JSX_ENTITY, MIDDLE_DOT).includes(MIDDLE_DOT);
}

function isChildSlot(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxFragment(node);
}

type RenderedLiteral = ts.StringLiteralLike | ts.TemplateExpression;

/** The literals a JSX child expression can render as text. Calls are opaque. */
function renderedLiterals(expr: ts.Expression): RenderedLiteral[] {
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    return renderedLiterals(expr.expression);
  }
  if (ts.isStringLiteralLike(expr)) return [expr];
  if (ts.isTemplateExpression(expr)) {
    return [expr, ...expr.templateSpans.flatMap((span) => renderedLiterals(span.expression))];
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.flatMap((element) =>
      ts.isSpreadElement(element) ? renderedLiterals(element.expression) : renderedLiterals(element)
    );
  }
  if (ts.isConditionalExpression(expr)) {
    return [...renderedLiterals(expr.whenTrue), ...renderedLiterals(expr.whenFalse)];
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    // `a && b` renders `a` only when it is falsy, which no dot-bearing string is.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return renderedLiterals(expr.right);
    if (op === ts.SyntaxKind.CommaToken) return renderedLiterals(expr.right);
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      return [...renderedLiterals(expr.left), ...renderedLiterals(expr.right)];
    }
  }
  return [];
}

/** A JS literal's text is already unescaped; entity spelling in it renders as typed. */
function literalHasDot(literal: RenderedLiteral): boolean {
  if (ts.isTemplateExpression(literal)) {
    return [literal.head, ...literal.templateSpans.map((span) => span.literal)].some((part) =>
      part.text.includes(MIDDLE_DOT)
    );
  }
  return literal.text.includes(MIDDLE_DOT);
}

function handRolledDots(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const report = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push(`${rel}:${line + 1}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && jsxTextHasDot(node.getText(sf))) report(node);
    if (ts.isJsxExpression(node) && node.expression && isChildSlot(node.parent)) {
      for (const literal of renderedLiterals(node.expression)) {
        if (literalHasDot(literal)) report(literal);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const relative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
const SCANNED = sourceFiles(SCAN_ROOT).map(relative);
const scanRel = (rel: string) =>
  handRolledDots(rel, fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
const scanSnippet = (jsx: string) => handRolledDots("snippet.tsx", `const x = (${jsx});`);

describe("fact separator contract", () => {
  it("renders every middle dot in markup through FactSeparator", () => {
    const offenders = SCANNED.filter(
      (rel) => rel !== PRIMITIVE && !EXEMPT_DIRS.some((dir) => rel.startsWith(dir))
    ).flatMap(scanRel);
    expect(
      offenders,
      `Hand-rolled middle dot found. Render <FactSeparator /> (or <FactRun /> for a list) from ${PRIMITIVE} instead.`
    ).toEqual([]);
  });

  it("walks the components and finds the primitive's own dot, so the scan is not vacuous", () => {
    expect(SCANNED).toContain(PRIMITIVE);
    expect(SCANNED).toContain("src/components/Layout/TrashBinItem.tsx");
    expect(SCANNED.filter((rel) => rel.startsWith("src/components/")).length).toBeGreaterThan(500);
    expect(scanRel(PRIMITIVE)).toHaveLength(1);
  });

  it.each([
    ["a dot in JSX text", "<span>a \u00b7 b</span>"],
    ["a named entity in JSX text", "<span>a &middot; b</span>"],
    ["a decimal entity with leading zeroes", "<span>&#0183;</span>"],
    ["an uppercase hex entity", "<span>&#xB7;</span>"],
    ["a padded lowercase hex entity", "<span>&#x00b7;</span>"],
    ["a string child", '<p>a{" \u00b7 "}b</p>'],
    ["a string child of a fragment", '<>a{" \u00b7 "}b</>'],
    ["a string with no substitutions in backticks", "<p>a{` \u00b7 b`}</p>"],
    ["an escaped string child", '<p>a{"\\u00b7"}b</p>'],
    ["a wrapped string child", '<p>a{(" \u00b7 b" as string)}</p>'],
    ["a conditional string child", '<p>a{on && " \u00b7 b"}</p>'],
    ["the true arm of a ternary", '<p>a{on ? " \u00b7 b" : null}</p>'],
    ["the false arm of a ternary", '<p>a{on ? null : " \u00b7 b"}</p>'],
    ["the left of an ||", '<p>{" \u00b7 " || b}</p>'],
    ["the right of a ??", '<p>a{label ?? " \u00b7 b"}</p>'],
    ["a concatenation", '<p>{a + " \u00b7 " + b}</p>'],
    ["an array of strings", '<p>{[a, " \u00b7 ", b]}</p>'],
    ["the result of a comma", '<p>{(a, " \u00b7 ")}</p>'],
    ["a template's head", "<span>{` \u00b7 ${n} waiting`}</span>"],
    ["a template's middle", "<span>{`${a} \u00b7 ${b}`}</span>"],
    ["a template's tail", "<span>{`${a} \u00b7`}</span>"],
    ["a string inside a template substitution", '<span>{`${a}${" \u00b7 "}${b}`}</span>'],
    ["JSX passed as a prop", "<Row description={<>a \u00b7 b</>} />"],
  ])("flags %s", (_, jsx) => {
    expect(scanSnippet(jsx)).toHaveLength(1);
  });

  it.each([
    ["an attribute string", '<span title="a \u00b7 b" />'],
    ["an attribute expression string", '<span title={" \u00b7 "} />'],
    ["an attribute template", "<span title={`${a} \u00b7 ${b}`} />"],
    ["a joined name", '<span aria-label={[a, b].join(" \u00b7 ")} />'],
    ["a rendered join", '<span>{[a, b].join(" \u00b7 ")}</span>'],
    ["a template handed to a call", "<span>{format(`${a} \u00b7 ${b}`)}</span>"],
    ["a template without a dot in its text", "<span>{`${a}${sep}${b}`}</span>"],
    ["a comment", "<span>{/* a \u00b7 b */}</span>"],
    ["entity spelling inside a JS string", '<span>{"&middot;"}</span>'],
    ["an HTML5-only entity the JSX transform keeps as typed", "<span>&centerdot;</span>"],
    ["an uppercase hex marker the JSX transform keeps as typed", "<span>&#XB7;</span>"],
    ["the condition of an &&", '<span>{" \u00b7 " && value}</span>'],
    ["the left of a comma", '<span>{(" \u00b7 ", value)}</span>'],
  ])("leaves %s alone", (_, jsx) => {
    expect(scanSnippet(jsx)).toEqual([]);
  });
});
