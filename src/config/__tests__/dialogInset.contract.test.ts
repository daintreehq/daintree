import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SCROLLBAR_GUTTER_VAR } from "@/lib/scrollbarGutter";

// A dialog's header, body and footer sit in three different boxes and are
// supposed to land on one column. Nothing renders wrong when they drift — the
// title is simply a few pixels off the field below it, which survives review
// indefinitely because it is invisible without a ruler. #12101 shipped that way
// for months: the chrome compensated for a scrollbar gutter with a hardcoded
// 11px, macOS reserved 0, and the header and footer sat 11px inside the form.
//
// The fix removed the figure rather than correcting it — the body absorbs
// whatever the platform actually reserves, and the chrome is a plain `px-6`. So
// what this guards is the shape of that arrangement:
//   - header and footer take their inset from one constant, not two literals;
//   - both body variants carry the class that does the absorbing;
//   - nobody overrides that class's padding from a call site;
//   - the measured-gutter plumbing (module → custom property → CSS) stays
//     joined up end to end;
//   - `plainBody`, the opt-in that split dialogs across two columns, stays gone.
//
// KNOWN LIMITS (deliberate — a regression guard, not a sound checker):
//   - A class string built at runtime, or reached through a wrapper component,
//     is outside this file's view.
//   - Only the specific `calc(<column> + <literal>)` shape is rejected. A fresh
//     magic number spelled some other way (`px-[35px]`) would pass.
//   - Custom scrollports that are not `AppDialog.Body`/`BodyScroll` are not
//     inspected. `HybridInputBar`'s expanded editor deliberately sits on a
//     tighter column than the dialog's, and is not a defect.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
];

const APP_DIALOG_PATH = path.join(REPO_ROOT, "src/components/ui/AppDialog.tsx");
const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");

const APP_DIALOG_MODULE = "/AppDialog";
const DEFAULT_DIALOG_BINDING = "AppDialog";

/** The constant both chrome members must resolve their inset through. */
const INSET_CONST = "DIALOG_INSET";
/** The class that reserves the gutter and takes it back out of the padding. */
const BODY_INSET_CLASS = "dialog-body-inset";
/**
 * Tailwind's `px-6` is 1.5rem, which is the figure `.dialog-body-inset`
 * subtracts the gutter from. The two spellings are the coupling this file
 * exists to hold: change one and the chrome and the body stop agreeing.
 */
const CHROME_INSET_CLASS = "px-6";
const COLUMN_REM = "1.5rem";

// Coverage ratchets, set to the current actuals. This is a static scan, so the
// numbers only move when someone adds or removes a dialog. Growth passes; a
// DROP fails, which is the point — it means a rename stopped matching and the
// contract went blind.
const MIN_HEADERS_INSPECTED = 33;
const MIN_FOOTERS_INSPECTED = 25;
const MIN_BODIES_INSPECTED = 28;

function tsxFiles(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
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

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

/**
 * The local name `AppDialog` is bound to in this file. Almost always
 * "AppDialog", but an alias would otherwise slip every dialog in the file past
 * the tag-name match.
 */
function dialogBinding(source: ts.SourceFile): string {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !specifier.text.endsWith(APP_DIALOG_MODULE)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === DEFAULT_DIALOG_BINDING) return element.name.text;
    }
  }
  return DEFAULT_DIALOG_BINDING;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * Every string literal reachable inside a node. AST, not text: `AppDialog.tsx`
 * quotes `px-6` and the old `11px` in its own prose, and a scan of the file's
 * characters cannot tell a class name from a comment about one.
 */
function stringLiteralsIn(node: ts.Node): string[] {
  const found: string[] = [];
  walk(node, (child) => {
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
      found.push(child.text);
    }
  });
  return found;
}

/** `AppDialog.Header` → "Header", for a JSX tag written as a property access. */
function memberName(tag: ts.JsxTagNameExpression, binding: string): string | null {
  if (!ts.isPropertyAccessExpression(tag)) return null;
  if (!ts.isIdentifier(tag.expression) || tag.expression.text !== binding) return null;
  return tag.name.text;
}

function openingElements(source: ts.SourceFile): ts.JsxOpeningLikeElement[] {
  const found: ts.JsxOpeningLikeElement[] = [];
  walk(source, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) found.push(node);
  });
  return found;
}

function attribute(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | null {
  for (const prop of el.attributes.properties) {
    if (ts.isJsxAttribute(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) {
      return prop;
    }
  }
  return null;
}

/** A horizontal-padding utility, in any of Tailwind's spellings for one. */
const HORIZONTAL_PADDING = /(?:^|\s|:)!?(?:p|px|ps|pe|pl|pr)-\S+/;

/** The shape the old chrome compensation took: the column plus a literal. */
const COMPENSATED_INSET = /calc\(\s*1\.5rem\s*\+/;

const ALL_FILES = SCAN_ROOTS.flatMap((root) => tsxFiles(root));

describe("dialog inset contract — one column for header, body and footer", () => {
  const appDialog = parse(APP_DIALOG_PATH);

  function chromeMember(name: string): ts.Node {
    let found: ts.Node | null = null;
    walk(appDialog, (node) => {
      if (!ts.isBinaryExpression(node)) return;
      const { left, operatorToken, right } = node;
      if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      if (!ts.isPropertyAccessExpression(left) || left.name.text !== name) return;
      found = right;
    });
    if (!found) throw new Error(`AppDialog.${name} assignment not found`);
    return found;
  }

  it("declares the chrome inset once, as the dialog column", () => {
    let literal: string | null = null;
    walk(appDialog, (node) => {
      if (!ts.isVariableDeclaration(node)) return;
      if (!ts.isIdentifier(node.name) || node.name.text !== INSET_CONST) return;
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        literal = node.initializer.text;
      }
    });

    expect(literal, `${INSET_CONST} must be a string literal Tailwind can see`).toBe(
      CHROME_INSET_CLASS
    );
  });

  it.each(["Header", "Footer"])(
    "%s takes its inset from the shared constant and adds no padding of its own",
    (name) => {
      const member = chromeMember(name);

      let usesConstant = false;
      walk(member, (node) => {
        if (ts.isIdentifier(node) && node.text === INSET_CONST) usesConstant = true;
      });
      expect(usesConstant, `AppDialog.${name} must inset via ${INSET_CONST}`).toBe(true);

      for (const literal of stringLiteralsIn(member)) {
        expect(
          HORIZONTAL_PADDING.test(literal),
          `AppDialog.${name} hard-codes horizontal padding in ${JSON.stringify(literal)}, ` +
            `which would override ${INSET_CONST}`
        ).toBe(false);
      }
    }
  );

  it.each(["Body", "BodyScroll"])("%s absorbs the reserved gutter into its padding", (name) => {
    const literals = stringLiteralsIn(chromeMember(name));

    expect(
      literals.some((literal) => literal.split(/\s+/).includes(BODY_INSET_CLASS)),
      `AppDialog.${name} must carry \`${BODY_INSET_CLASS}\``
    ).toBe(true);

    for (const literal of literals) {
      expect(
        HORIZONTAL_PADDING.test(literal),
        `AppDialog.${name} hard-codes horizontal padding in ${JSON.stringify(literal)}, ` +
          `which would fight \`${BODY_INSET_CLASS}\``
      ).toBe(false);
    }
  });

  it("keeps the measured-gutter plumbing joined up from module to stylesheet", () => {
    const css = fs.readFileSync(INDEX_CSS_PATH, "utf8");

    // Take the rule body first. The comment above the selector quotes the very
    // figures asserted below, so a scan of the whole file would pass on prose.
    const rule = new RegExp(`\\.${BODY_INSET_CLASS}\\s*\\{([^}]*)\\}`).exec(css);
    const body = rule?.[1];
    if (body === undefined) {
      throw new Error(`\`.${BODY_INSET_CLASS}\` must be declared in index.css`);
    }

    expect(body, "the padding must subtract the measured gutter from the column").toMatch(
      new RegExp(`padding-inline:\\s*max\\(\\s*0px\\s*,\\s*calc\\(\\s*${COLUMN_REM}\\s*-`)
    );
    expect(
      body.includes(`var(${SCROLLBAR_GUTTER_VAR}`),
      `the padding must read ${SCROLLBAR_GUTTER_VAR}, the property the probe publishes`
    ).toBe(true);
    // Reserving the gutter is what stops the body shifting sideways the moment
    // it starts to overflow; `both-edges` is what keeps that symmetric.
    expect(body).toMatch(/scrollbar-gutter:\s*stable\s+both-edges/);
  });

  it("has no dialog anywhere still compensating for a guessed gutter", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      for (const literal of stringLiteralsIn(parse(file))) {
        if (COMPENSATED_INSET.test(literal)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${JSON.stringify(literal)}`);
        }
      }
    }

    expect(
      offenders,
      "the reserved gutter is a platform property — measure it, do not add a literal back"
    ).toEqual([]);
  });

  it("has no call site opting out of the shared column", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      const source = parse(file);
      for (const el of openingElements(source)) {
        if (attribute(el, "plainBody")) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }

    expect(
      offenders,
      "`plainBody` split dialogs across two columns and was removed with #12101"
    ).toEqual([]);
  });

  it("has no call site overriding the body's horizontal padding", () => {
    const offenders: string[] = [];
    let bodies = 0;

    for (const file of ALL_FILES) {
      const source = parse(file);
      if (path.resolve(file) === APP_DIALOG_PATH) continue;
      const binding = dialogBinding(source);

      for (const el of openingElements(source)) {
        const member = memberName(el.tagName, binding);
        if (member !== "Body" && member !== "BodyScroll") continue;
        bodies += 1;

        const className = attribute(el, "className");
        if (!className?.initializer) continue;
        for (const literal of stringLiteralsIn(className.initializer)) {
          if (HORIZONTAL_PADDING.test(literal)) {
            offenders.push(
              `${path.relative(REPO_ROOT, file)}: ${JSON.stringify(literal)} on ${binding}.${member}`
            );
          }
        }
      }
    }

    expect(
      offenders,
      `a padding utility on the body outranks \`.${BODY_INSET_CLASS}\` and puts the fields ` +
        "back off the chrome's column"
    ).toEqual([]);
    expect(bodies, "body scan went blind — did a rename stop matching?").toBeGreaterThanOrEqual(
      MIN_BODIES_INSPECTED
    );
  });

  it("still sees every dialog's chrome", () => {
    let headers = 0;
    let footers = 0;

    for (const file of ALL_FILES) {
      const source = parse(file);
      if (path.resolve(file) === APP_DIALOG_PATH) continue;
      const binding = dialogBinding(source);
      for (const el of openingElements(source)) {
        const member = memberName(el.tagName, binding);
        if (member === "Header") headers += 1;
        if (member === "Footer") footers += 1;
      }
    }

    expect(headers).toBeGreaterThanOrEqual(MIN_HEADERS_INSPECTED);
    expect(footers).toBeGreaterThanOrEqual(MIN_FOOTERS_INSPECTED);
  });
});
