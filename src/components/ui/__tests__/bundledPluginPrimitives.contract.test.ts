import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Bundled plugins draw with the host UI kit exactly as the app does. Builtins
// load in-process and import `@/components/ui/*` directly, so a restyled copy
// of a primitive is never a missing export — it is drift: a switch made from a
// checkbox beside New Worktree's Checkbox, a pill hand-tinted beside Badge, a
// 32px button with its own hover beside the ghost icon button, a glyph spun by
// hand beside Spinner, an OS tooltip beside the shared one.
//
// KNOWN LIMITS (a regression guard, not a sound checker):
//   - Only literal class strings are read.
//   - `title` is policed on DOM elements and `Button`. A Radix `SelectItem`
//     forwards it to its option, where a styled tooltip would fight the
//     listbox's own pointer and focus handling, so options keep theirs.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const BUILTIN_ROOT = path.join(REPO_ROOT, "plugins/builtin");

function tsxFiles(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "__tests__", "__preview__", "dist"].includes(entry.name)) continue;
      tsxFiles(full, found);
    } else if (entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

const rendererDirs = fs
  .readdirSync(BUILTIN_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(BUILTIN_ROOT, entry.name, "renderer"));

const sources = rendererDirs
  .flatMap((dir) => tsxFiles(dir))
  .map((file) =>
    ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
  );

const rel = (source: ts.SourceFile) =>
  path.relative(REPO_ROOT, source.fileName).split(path.sep).join("/");

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function eachOpening(source: ts.SourceFile, visit: (opening: Opening) => void): void {
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node)) visit(node.openingElement);
    else if (ts.isJsxSelfClosingElement(node)) visit(node);
    node.forEachChild(walk);
  };
  walk(source);
}

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) return prop;
  }
  return undefined;
}

function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${rel(source)}:${line + 1}`;
}

/** Every string literal in the file that reads as a class list. */
function classStrings(source: ts.SourceFile): { text: string; node: ts.Node }[] {
  const out: { text: string; node: ts.Node }[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ text: node.text, node });
    }
    node.forEachChild(walk);
  };
  walk(source);
  return out;
}

function classViolations(pattern: RegExp): string[] {
  return sources.flatMap((source) =>
    classStrings(source)
      .filter(({ text }) => pattern.test(text))
      .map(({ node }) => where(source, node))
  );
}

describe("bundled plugin renderers", () => {
  it("scans every builtin plugin's renderer", () => {
    const plugins = new Set(sources.map((s) => rel(s).split("/")[2]));
    for (const id of ["github", "markdown-editor", "sveltekit-builder"]) {
      expect(plugins).toContain(id);
    }
  });

  it("spin through Spinner or SpinningIcon, never a hand-applied animate-spin", () => {
    expect(classViolations(/(^|\s)animate-spin(\s|$)/)).toEqual([]);
  });

  it("tint status pills through Badge, never a hand-rolled status wash", () => {
    expect(classViolations(/(^|\s)bg-status-(error|warning|success|info)\/10(\s|$)/)).toEqual([]);
  });

  it("hover icon buttons with the ghost button's overlay-hover, never overlay-medium", () => {
    expect(classViolations(/(^|\s)hover:bg-overlay-medium(\s|$)/)).toEqual([]);
  });

  it("take text, checks and switches from Input, Textarea, Checkbox and Switch", () => {
    const violations: string[] = [];
    for (const source of sources) {
      eachOpening(source, (opening) => {
        const tag = opening.tagName.getText();
        if (tag === "input" || tag === "textarea") violations.push(where(source, opening));
      });
    }
    expect(violations).toEqual([]);
  });

  it("explain themselves through the shared Tooltip, never a native title", () => {
    const violations: string[] = [];
    for (const source of sources) {
      eachOpening(source, (opening) => {
        const tag = opening.tagName.getText();
        const intrinsic = tag[0] === tag[0]!.toLowerCase();
        if ((intrinsic || tag === "Button") && attribute(opening, "title")) {
          violations.push(where(source, opening));
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
