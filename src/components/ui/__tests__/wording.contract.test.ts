import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

/**
 * The wording rules the UI consistency audit settled (component-contract.md,
 * "Wording"). Each rule here is the one a local edit is most likely to break:
 *
 * - A count goes through `pluralize`, so nothing reads "1 files" and a large
 *   count carries the locale's grouping. The audit found thirteen private
 *   `plural()` copies and a CopyTree toast that said "Copied 1 files".
 * - An ellipsis is the single character "…", never three dots.
 * - Menu group headings are sentence case.
 * - Inside the in-app browser and dev preview, the escape hatch is "Open in
 *   external browser" — "Open in browser" is ambiguous when you are already in one.
 *
 * Log lines are not copy and are not scanned.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "__tests__", "__preview__"].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|bench)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
const files = ["src", "shared", "electron/ipc", "electron/services"].flatMap((dir) =>
  walk(path.join(REPO_ROOT, dir))
);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

const LOG_CALLEE =
  /^(console\.\w+|log(Debug|Info|Warn|Error|Verbose)?|\w+Logger\.\w+|logger\.\w+)$/;

function insideLogCall(node: ts.Node, source: ts.SourceFile): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && LOG_CALLEE.test(p.expression.getText(source))) return true;
  }
  return false;
}

function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n)) {
    return n.text;
  }
  if (ts.isTemplateExpression(n)) {
    // `{}` stands in for each interpolation, so "${phase}..." still reads as a trailing ellipsis.
    return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("{}");
  }
  return null;
}

const lineOf = (source: ts.SourceFile, n: ts.Node) =>
  source.getLineAndCharacterOfPosition(n.getStart()).line + 1;

/** Three dots used as an ellipsis: after a word or a closing paren, or before one. */
const THREE_DOT_ELLIPSIS =
  /[\w)}-]\.\.\.(?=$|[\s,;:"')])|^\.\.\.(?:$|[a-z]+\s)|\s\.\.\.(?=$|["')])/;

const MENU_LABEL_TAGS = new Set([
  "DropdownMenuLabel",
  "ContextMenuLabel",
  "MenuLabel",
  "SelectLabel",
]);

/** A heading in Title Case: a word after the first starts upper-then-lower. */
function isTitleCase(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.slice(1).some((w) => /^[A-Z][a-z]/.test(w));
}

/** Three dots that are not UI copy: text written for an agent or a stack trace. */
const THREE_DOT_ALLOWED = new Set([
  // An action example is MCP input written for an agent, not UI copy.
  "src/services/actions/definitions/forgeActions.ts",
  // A stack-trace marker in a GitHub issue body, matched verbatim by its own tests.
  "shared/utils/githubIssueUrl.ts",
  // Matches the dots an agent CLI prints after a truncated status title.
  "electron/services/pty/HandbackDetector.ts",
]);

const IN_APP_BROWSER_FILES = /^src\/components\/(Browser|Portal|DevPreview)\//;
const IN_APP_BROWSER_MENUS = new Set(["src/components/Terminal/TerminalContextMenu.tsx"]);

describe("wording", () => {
  const ellipses: string[] = [];
  const localPlurals: string[] = [];
  const inlinePlurals: string[] = [];
  const titleCaseHeadings: string[] = [];
  const ambiguousBrowser: string[] = [];

  for (const file of files) {
    const r = rel(file);
    const source = parse(file);
    const inBrowserSurface = IN_APP_BROWSER_FILES.test(r) || IN_APP_BROWSER_MENUS.has(r);

    const visit = (n: ts.Node) => {
      const text = literalText(n);
      if (
        text !== null &&
        THREE_DOT_ELLIPSIS.test(text) &&
        !THREE_DOT_ALLOWED.has(r) &&
        !insideLogCall(n, source)
      ) {
        ellipses.push(`${r}:${lineOf(source, n)}`);
      }
      if (text !== null && inBrowserSurface && /\bOpen in browser\b/.test(text)) {
        ambiguousBrowser.push(`${r}:${lineOf(source, n)}`);
      }

      const declared =
        ts.isFunctionDeclaration(n) && n.name
          ? n.name.text
          : ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
            ? ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)
              ? n.name.text
              : null
            : null;
      if (declared && /^plural/i.test(declared) && r !== "src/lib/pluralize.ts") {
        localPlurals.push(`${r}:${lineOf(source, n)} ${declared}`);
      }

      // `n === 1 ? "1 file" : \`${n} files\`` — the hand-rolled form of `pluralize`. A
      // plural that is worded differently ("All 3 installed agents") is not one.
      if (
        ts.isConditionalExpression(n) &&
        ts.isBinaryExpression(n.condition) &&
        n.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        n.condition.right.getText(source) === "1" &&
        (ts.isStringLiteral(n.whenTrue) || ts.isNoSubstitutionTemplateLiteral(n.whenTrue)) &&
        /^1 \S/.test(n.whenTrue.text) &&
        ts.isTemplateExpression(n.whenFalse) &&
        n.whenFalse.head.text === ""
      ) {
        inlinePlurals.push(`${r}:${lineOf(source, n)}`);
      }

      // `noun${n === 1 ? "" : "s"}` — the suffix form of the same thing.
      if (
        ts.isConditionalExpression(n) &&
        ts.isBinaryExpression(n.condition) &&
        n.condition.right.getText(source) === "1" &&
        [n.whenTrue, n.whenFalse].every(ts.isStringLiteral) &&
        [(n.whenTrue as ts.StringLiteral).text, (n.whenFalse as ts.StringLiteral).text]
          .sort()
          .join("|") === "|s"
      ) {
        inlinePlurals.push(`${r}:${lineOf(source, n)}`);
      }

      if (ts.isJsxElement(n)) {
        const tag = n.openingElement.tagName.getText(source);
        if (MENU_LABEL_TAGS.has(tag)) {
          const heading = n.children
            .filter(ts.isJsxText)
            .map((c) => c.text)
            .join("")
            .trim();
          if (heading && isTitleCase(heading)) {
            titleCaseHeadings.push(`${r}:${lineOf(source, n)} "${heading}"`);
          }
        }
      }

      ts.forEachChild(n, visit);
    };
    visit(source);
  }

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("keeps the three-dot allowlist to files that still need it", () => {
    const stale = [...THREE_DOT_ALLOWED].filter((file) => {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      return !/\.\.\./.test(text.replace(/\.\.\.(?=[\w[({])/g, ""));
    });
    expect(stale).toEqual([]);
  });

  it('writes an ellipsis as "…", never three dots', () => {
    expect(ellipses).toEqual([]);
  });

  it("pluralizes counts through the shared helper, not a local copy", () => {
    expect(localPlurals).toEqual([]);
  });

  it("does not hand-roll the singular/plural conditional", () => {
    expect(inlinePlurals).toEqual([]);
  });

  it("keeps menu group headings in sentence case", () => {
    expect(titleCaseHeadings).toEqual([]);
  });

  it('says "Open in external browser" inside the in-app browser and dev preview', () => {
    expect(ambiguousBrowser).toEqual([]);
  });
});

describe("wording detectors", () => {
  it.each([
    "Loading...",
    "Filter themes...",
    "Retrying (1/3)...",
    "...and 2 more",
    "a, ...",
    "...",
    "org-...",
    "{}...",
  ])("flags %j as a three-dot ellipsis", (text) => {
    expect(THREE_DOT_ELLIPSIS.test(text)).toBe(true);
  });

  it.each(["Loading…", "{ ...props }", "[...spread]", 'branchName: "..."'])(
    "leaves %j alone",
    (text) => {
      expect(THREE_DOT_ELLIPSIS.test(text)).toBe(false);
    }
  );

  it("reads Title Case headings by any later capitalised word", () => {
    expect(isTitleCase("CCR Routes")).toBe(true);
    expect(isTitleCase("Project Shared")).toBe(true);
    expect(isTitleCase("CCR routes")).toBe(false);
    expect(isTitleCase("Project shared")).toBe(false);
    expect(isTitleCase("Recent")).toBe(false);
  });
});
