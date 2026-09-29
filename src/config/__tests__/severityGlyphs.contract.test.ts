import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as lucide from "lucide-react";
import { SEVERITY_GLYPH, type StatusSeverity } from "@/lib/statusSeverity";

// One glyph per severity, app-wide (docs/themes/component-contract.md, "Severity
// glyphs"). Toasts, banners and the inbox had settled on XCircle for a failure
// while inline errors, the readiness rail and a dozen hand-drawn marks used
// CircleAlert, and two banners swapped in OctagonAlert, so "this failed" wore
// three shapes and forced colours, where shape is the only channel left, could
// not tell a failure from a caution.
//
// KNOWN LIMITS (a regression guard, not a sound checker): a glyph chosen at
// runtime, or a banner whose severity is not a string literal, is outside its
// view.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins/builtin")];

/**
 * Glyphs that are not a severity: `CircleAlert` read as a failure beside
 * `XCircle` and as a caution beside `AlertTriangle`, and `CircleCheckBig` is a
 * second success mark. Each holder here uses one as its own concept.
 */
const RETIRED = new Set(["CircleAlert", "AlertCircle", "CircleCheckBig", "CheckCircle"]);
const RETIRED_ALLOWED: Record<string, string> = {
  // The Problems panel's toolbar identity, a destination rather than a verdict:
  // an enclosed X there would read as a close control.
  "src/components/Layout/toolbarButtonMetadata.ts": "Problems toolbar button",
  "src/components/Layout/ToolbarProblemsButton.tsx": "Problems toolbar button",
  // A pull request's review verdict, beside the forge's own approved and
  // review-required marks.
  "plugins/builtin/github/renderer/components/GitHubListItem.tsx": "Changes requested verdict",
};

/** Every Lucide glyph that has ever stood for a severity on a banner or callout. */
const SEVERITY_FAMILY = new Set<unknown>([
  ...Object.values(SEVERITY_GLYPH),
  lucide.CircleAlert,
  lucide.OctagonAlert,
  lucide.CircleCheckBig,
]);

const HOLDERS = new Set(["InlineStatusBanner", "Callout"]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name))
        out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return out;
}

const FILES = sourceFiles().map((file) => {
  const text = fs.readFileSync(file, "utf8");
  return {
    rel: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
    text,
    sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  };
});

function lucideImports(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if ((stmt.moduleSpecifier as ts.StringLiteral).text !== "lucide-react") continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

type Holder = { tag: string; icons: string[]; severity: string | null; line: number };

/** Every glyph an `icon` expression can resolve to: a name, an element, either branch of a ternary. */
function iconNames(expr: ts.Expression, sf: ts.SourceFile): string[] {
  if (ts.isParenthesizedExpression(expr)) return iconNames(expr.expression, sf);
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isJsxSelfClosingElement(expr)) return [expr.tagName.getText(sf)];
  if (ts.isConditionalExpression(expr))
    return [...iconNames(expr.whenTrue, sf), ...iconNames(expr.whenFalse, sf)];
  return [];
}

function holders(sf: ts.SourceFile): Holder[] {
  const found: Holder[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(sf);
      if (HOLDERS.has(tag)) {
        let icons: string[] = [];
        let severity: string | null = null;
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
          const name = attr.name.getText(sf);
          const init = attr.initializer;
          if (name === "icon" && ts.isJsxExpression(init) && init.expression) {
            icons = iconNames(init.expression, sf);
          }
          if (name === "severity" && ts.isStringLiteral(init)) severity = init.text;
        }
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        found.push({ tag, icons, severity, line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Modules whose named exports are Lucide glyphs under their Lucide names. */
const GLYPH_MODULES = new Set(["lucide-react", "@/components/icons"]);

/** The lucide export an identifier resolves to in this file, following `import { A as B }`. */
function lucideGlyph(sf: ts.SourceFile, local: string): unknown {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!GLYPH_MODULES.has(stmt.moduleSpecifier.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.name.text === local) {
        return (lucide as Record<string, unknown>)[(el.propertyName ?? el.name).text];
      }
    }
  }
  return undefined;
}

const LEVEL_OF: Record<string, StatusSeverity> = {
  error: "error",
  warning: "warning",
  info: "info",
  success: "success",
  neutral: "info",
};

describe("severity glyph contract", () => {
  it("scans a real tree", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.rel === "src/components/ui/Callout.tsx")).toBe(true);
  });

  it("imports no retired severity glyph outside its named holders", () => {
    const offenders: string[] = [];
    for (const { rel, sf } of FILES) {
      if (RETIRED_ALLOWED[rel]) continue;
      for (const name of lucideImports(sf)) {
        if (RETIRED.has(name)) offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the retired-glyph allowlist free of stale entries", () => {
    const stale = Object.keys(RETIRED_ALLOWED).filter((rel) => {
      const file = FILES.find((f) => f.rel === rel);
      return !file || !lucideImports(file.sf).some((name) => RETIRED.has(name));
    });
    expect(stale).toEqual([]);
  });

  it("never overrides a banner's or callout's severity glyph with another severity's shape", () => {
    // A domain glyph (a key, a folder, a spinner) is fine; a severity-shaped one
    // must be the shape of the severity the element declares, or the pane says
    // "warning" in ink and "failure" in outline.
    const offenders: string[] = [];
    for (const { rel, sf } of FILES) {
      for (const h of holders(sf)) {
        for (const icon of h.icons) {
          const glyph = lucideGlyph(sf, icon);
          if (!SEVERITY_FAMILY.has(glyph)) continue;
          const level = h.severity ? LEVEL_OF[h.severity] : undefined;
          if (!level || glyph !== SEVERITY_GLYPH[level]) {
            offenders.push(`${rel}:${h.line} <${h.tag} severity=${h.severity} icon=${icon}>`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lets only a neutral callout take a glyph of its own", () => {
    const offenders: string[] = [];
    for (const { rel, sf } of FILES) {
      for (const h of holders(sf)) {
        if (h.tag === "Callout" && h.icons.length > 0 && h.severity !== "neutral") {
          offenders.push(`${rel}:${h.line} severity=${h.severity}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("paints each severity glyph only in its own severity's ink", () => {
    // Red ink on a triangle says "failed" in colour and "careful" in shape; under
    // forced colours only the shape survives, so the two must agree.
    const INK: Array<[RegExp, Set<unknown>, string]> = [
      [
        /\b(text|stroke)-status-(error|danger)\b/,
        new Set([SEVERITY_GLYPH.error, lucide.OctagonAlert]),
        "error",
      ],
      [/\b(text|stroke)-status-warning\b/, new Set([SEVERITY_GLYPH.warning]), "warning"],
      [/\b(text|stroke)-status-success\b/, new Set([SEVERITY_GLYPH.success]), "success"],
    ];
    const offenders: string[] = [];
    for (const { rel, sf } of FILES) {
      const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
          const glyph = lucideGlyph(sf, node.tagName.getText(sf));
          if (glyph && SEVERITY_FAMILY.has(glyph)) {
            const cls = node.attributes.properties
              .filter(ts.isJsxAttribute)
              .find((a) => a.name.getText(sf) === "className")
              ?.initializer?.getText(sf);
            for (const [ink, allowed, level] of INK) {
              if (cls && ink.test(cls) && !allowed.has(glyph)) {
                const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
                offenders.push(`${rel}:${line} ${node.tagName.getText(sf)} in ${level} ink`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });

  it("draws no hand-rolled status callout outside the Callout primitive", () => {
    // The status-tint box is Callout's; a copy of it grows its own glyph and its
    // own coloured words. These share the tint and are not messages. Any alpha
    // on either side counts, so re-spelling the tint does not slip past.
    const allowed = new Set([
      "src/components/ui/Callout.tsx",
      // A type-to-confirm field sitting in a destructive dialog: an input, no glyph.
      "src/components/ui/TypedNameConfirmInput.tsx",
      // The crash report's stack trace, a <pre>.
      "src/components/Recovery/CrashRecoveryDialog.tsx",
      // An agent row in the setup list washed for its failed install; the row is
      // the control, and its "Failed" pill carries the glyph.
      "src/components/Setup/AgentCliStep.tsx",
    ]);
    const pair =
      /border-status-([a-z]+)\/\d+\b[^"'`]*\bbg-status-\1\/\d+|bg-status-([a-z]+)\/\d+\b[^"'`]*\bborder-status-\2\/\d+/;
    const offenders = FILES.filter((f) => !allowed.has(f.rel) && pair.test(f.text)).map(
      (f) => f.rel
    );
    expect(offenders).toEqual([]);
  });
});
