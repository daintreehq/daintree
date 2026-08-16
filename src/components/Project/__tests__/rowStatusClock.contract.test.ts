import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Row status lines are clock-derived, and React Compiler — wired for both `vite
// dev` and `vite build` in `compilationMode: "infer"` — auto-memoizes every row
// the palette draws. A row that reads the clock ambiently instead of receiving
// it caches its status against unchanged props, so the reading taken on first
// render is the only one it ever gets: a scratch in the ranked list opened at
// "just now" and stayed there for as long as the palette was up (#11823).
//
// Source enforcement rather than a rendering assertion is deliberate. Vitest
// wires no compiler plugin, so under test these rows re-run every render and
// the age advances the way it never does in a build — a render-then-advance-
// timers test passes identically with and without the bug.
//
// The clock has to survive a whole chain to reach the screen: a reactive
// source, a prop carrying it down, and a row that renders against that prop
// rather than a reading of its own. Types enforce that the prop and the
// argument are *present*; nothing in them can speak to where the value came
// from or whether it still moves. Breaking any one link refreezes the age, so
// each link gets an assertion — pinning only the last one is what would leave
// this green while the parent quietly swapped its hook for a `Date.now()`.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, "../../..");
const PALETTE_REL = "components/Project/ProjectSwitcherPalette.tsx";
const HELPERS_REL = "lib/projectRowStatus.ts";

/** The status-helper family: `getProjectRowStatus`, `getScratchRowStatus`, and any sibling. */
const HELPER_PATTERN = /^get.+RowStatus$/;

/** The module the family is declared in, by alias or relative path. Barrels and extension-bearing specifiers are not followed. */
const HELPERS_MODULE = /(^|\/)projectRowStatus$/;

/** The prop every row carries its clock on, so the chain can be followed by name. */
const CLOCK_PROP = "nowMs";

/** Hooks that return a clock React re-renders on. An ambient read is not one. */
const REACTIVE_CLOCKS = new Set(["useGlobalMinuteClock"]);

/**
 * Rows that must stay under this contract.
 *
 * Named rather than counted because the walk is only as good as what it finds:
 * moving a row into its own file, or renaming the helper family out of the
 * pattern, would otherwise shrink the checked set to nothing and pass.
 */
const REQUIRED_ROWS = ["ProjectListItem", "ScratchListItem"];

/**
 * Components whose clock is knowingly still ambient.
 *
 * `ScratchSection` reads `Date.now()` in its own body. The palette holds a
 * per-minute tick for it, but that tick is state on the palette root and never
 * reaches here: the compiler caches the `<ScratchSection>` element on its props
 * alone, so the root re-runs and the cached child is reused. Its pinned rows and
 * cleanup countdown go stale the same way the ranked row did — a separate fix
 * from the one #11823 reports, listed here so the gap stays visible instead of
 * being quietly skipped by a predicate that never looked.
 */
const AMBIENT_CLOCK_ALLOWLIST = new Set(["ScratchSection"]);

function parse(file: string): ts.SourceFile {
  // By extension, not TSX for everything: `.ts` parsed as TSX turns generic
  // arrows and type assertions into recovered garbage, and a call read out of a
  // mis-parsed tree is not evidence of anything.
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      // Colocated tests are excluded alongside `__tests__`: a row name only a
      // fixture defines must not be what satisfies the coverage checks below.
      out.push(full);
    }
  }
  return out;
}

function relative(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join("/");
}

interface HelperBindings {
  /** Local names the helpers are callable under, following `as` aliases. */
  direct: Set<string>;
  /** Namespace bindings, so `rowStatus.getScratchRowStatus(…)` is still seen. */
  namespaces: Set<string>;
}

/** How this file can reach the helper family, if it can reach it at all. */
function helperBindings(source: ts.SourceFile): HelperBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();

  eachNode(source, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    if (!HELPERS_MODULE.test(node.moduleSpecifier.text)) return;

    const bindings = node.importClause?.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      return;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (HELPER_PATTERN.test(imported)) direct.add(element.name.text);
    }
  });

  // `const read = getScratchRowStatus` — a rename that keeps the call reachable
  // under a name the import never mentioned.
  eachNode(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (!ts.isIdentifier(node.name) || !ts.isIdentifier(node.initializer)) return;
    if (direct.has(node.initializer.text)) direct.add(node.name.text);
  });

  return { direct, namespaces };
}

/** The status helper this call resolves to, or undefined if it is not one. */
function calledHelper(node: ts.CallExpression, bindings: HelperBindings): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return bindings.direct.has(callee.text) ? callee.text : undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const viaNamespace =
      bindings.namespaces.has(callee.expression.text) && HELPER_PATTERN.test(callee.name.text);
    return viaNamespace ? callee.name.text : undefined;
  }
  return undefined;
}

/**
 * The component a call sits in. Nearest enclosing function *declaration*, so a
 * call made from a nested `renderItem`-style arrow still resolves to the
 * component whose props hold the clock. A row written as an arrow assigned to a
 * const resolves to nothing and is reported, rather than skipped.
 */
function owningComponent(node: ts.Node): ts.FunctionDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * Whether `argument` is this component's own `nowMs` prop.
 *
 * Deliberately narrow: a destructured binding of `nowMs` with no default of its
 * own, or `props.nowMs`. The compiler would also track a plain local alias, but
 * every shape this accepts is one a reader can confirm at a glance, and the
 * rows all already spell it this way. Requiring the *original* property name
 * rather than any prop is what ties this link to the one above it — a row handed
 * some other stable number would otherwise satisfy it.
 */
function isClockProp(owner: ts.FunctionDeclaration, argument: ts.Expression): boolean {
  const props = owner.parameters[0];
  if (!props) return false;

  if (ts.isObjectBindingPattern(props.name)) {
    if (!ts.isIdentifier(argument)) return false;
    return props.name.elements.some(
      (element) =>
        element.dotDotDotToken === undefined &&
        element.initializer === undefined &&
        ts.isIdentifier(element.name) &&
        element.name.text === argument.text &&
        (element.propertyName?.getText(owner.getSourceFile()) ?? element.name.text) === CLOCK_PROP
    );
  }

  return (
    ts.isIdentifier(props.name) &&
    ts.isPropertyAccessExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === props.name.text &&
    argument.name.text === CLOCK_PROP
  );
}

interface HelperCall {
  file: string;
  helper: string;
  owner: string;
  ownerNode: ts.FunctionDeclaration | undefined;
  line: number;
  clock: ts.Expression | undefined;
}

/**
 * Every source that could reach the helper family, parsed.
 *
 * Text-filtered before parsing: the renderer is ~1,500 files, and holding an
 * AST for each one costs hundreds of megabytes for the handful that mention
 * this module. The two contract targets are parsed unconditionally, since the
 * module that declares the family need never name itself.
 */
function loadTarget(rel: string): { rel: string; source: ts.SourceFile } {
  const full = path.join(SRC_ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`Contract target no longer exists: src/${rel}`);
  return { rel, source: parse(full) };
}

const palette = loadTarget(PALETTE_REL);
const helpers = loadTarget(HELPERS_REL);

const helperCalls: HelperCall[] = [];
for (const file of walk(SRC_ROOT)) {
  const rel = relative(file);
  const preloaded = [palette, helpers].find((entry) => entry.rel === rel);
  if (!preloaded && !fs.readFileSync(file, "utf8").includes("projectRowStatus")) continue;

  const source = preloaded?.source ?? parse(file);
  const bindings = helperBindings(source);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) continue;

  eachNode(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const helper = calledHelper(node, bindings);
    if (!helper) return;
    const ownerNode = owningComponent(node);
    helperCalls.push({
      file: rel,
      helper,
      owner: ownerNode?.name?.text ?? "<not a function declaration>",
      ownerNode,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      clock: node.arguments[1],
    });
  });
}

/** Local names bound to a hook that re-renders on a new reading. */
function reactiveClockBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  eachNode(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (!ts.isCallExpression(node.initializer)) return;
    const callee = node.initializer.expression;
    if (!ts.isIdentifier(callee) || !REACTIVE_CLOCKS.has(callee.text)) return;
    if (ts.isIdentifier(node.name)) names.add(node.name.text);
  });
  return names;
}

describe("row status clocks (#11823)", () => {
  it("renders every row against a clock handed to it, never one it reads itself", () => {
    const offenders = helperCalls
      .filter(({ owner }) => !AMBIENT_CLOCK_ALLOWLIST.has(owner))
      .filter(({ ownerNode, clock }) => !ownerNode || !clock || !isClockProp(ownerNode, clock))
      .map(
        ({ file, owner, helper, line, clock }) =>
          `src/${file}:${line} ${owner} calls ${helper}(…, ${
            clock?.getText() ?? "<no clock>"
          }) — not its own \`${CLOCK_PROP}\` prop`
      );

    expect(offenders).toEqual([]);
  });

  it("feeds every row clock from a hook that re-renders, not a one-off reading", () => {
    const reactive = reactiveClockBindings(palette.source);

    const offenders: string[] = [];
    eachNode(palette.source, (node) => {
      if (!ts.isJsxAttribute(node) || node.name.getText() !== CLOCK_PROP) return;
      const line = palette.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const value = node.initializer;
      const passed =
        value && ts.isJsxExpression(value) && value.expression && ts.isIdentifier(value.expression)
          ? value.expression
          : undefined;
      if (!passed || !reactive.has(passed.text)) {
        offenders.push(
          `src/${PALETTE_REL}:${line} ${CLOCK_PROP}=${value?.getText() ?? "?"} does not come from ${[
            ...REACTIVE_CLOCKS,
          ].join("/")}`
        );
      }
    });

    expect(offenders).toEqual([]);

    // Checked by name, not counted: an attribute deleted outright, or replaced
    // by a `{...spread}` the walk above never sees, would otherwise pass this
    // by absence — which is the shape the original bug had.
    const clocked = new Set(rowsRenderedWithAReactiveClock(palette.source, reactive));
    expect(REQUIRED_ROWS.filter((row) => !clocked.has(row))).toEqual([]);
  });

  it("leaves the row-status helpers no ambient clock to fall back to", () => {
    const offenders = exportedHelpers(helpers.source)
      .filter(({ fn }) => !requiresClock(fn))
      .map(({ name }) => `${name} does not require an explicit clock as its second parameter`);

    expect(offenders).toEqual([]);
  });

  it("keeps every row it names, and every exemption it grants, real", () => {
    const owners = new Set(helperCalls.map(({ owner }) => owner));

    const missing = REQUIRED_ROWS.filter((row) => !owners.has(row));
    expect(missing).toEqual([]);

    const dead = [...AMBIENT_CLOCK_ALLOWLIST].filter((name) => !owners.has(name));
    expect(dead).toEqual([]);
  });
});

/** Row components rendered with a `nowMs` fed straight from a re-rendering hook. */
function rowsRenderedWithAReactiveClock(source: ts.SourceFile, reactive: Set<string>): string[] {
  const rows: string[] = [];
  eachNode(source, (node) => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return;
    const clocked = node.attributes.properties.some(
      (attribute) =>
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText() === CLOCK_PROP &&
        attribute.initializer !== undefined &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression !== undefined &&
        ts.isIdentifier(attribute.initializer.expression) &&
        reactive.has(attribute.initializer.expression.text)
    );
    if (clocked) rows.push(node.tagName.getText());
  });
  return rows;
}

/**
 * Exported members of the helper family, counting both declaration forms — an
 * `export const get… = (row, nowMs = Date.now()) => …` reintroduces the default
 * just as effectively as a function declaration does.
 */
function exportedHelpers(
  source: ts.SourceFile
): { name: string; fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression }[] {
  const found: {
    name: string;
    fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  }[] = [];

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      if (HELPER_PATTERN.test(statement.name.text)) {
        found.push({ name: statement.name.text, fn: statement });
      }
      continue;
    }
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (!HELPER_PATTERN.test(declaration.name.text)) continue;
      if (
        ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer)
      ) {
        found.push({ name: declaration.name.text, fn: declaration.initializer });
      }
    }
  }

  return found;
}

/**
 * Whether the clock is genuinely required: present, not optional, not defaulted,
 * and — when it arrives in an options object — carrying no defaulted member to
 * hide an ambient read behind.
 */
function requiresClock(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
): boolean {
  const clock = fn.parameters[1];
  if (!clock) return false;
  if (clock.questionToken !== undefined) return false;
  if (clock.initializer !== undefined) return false;
  // `...nowMs: number[]` is a required parameter the caller may still omit.
  if (clock.dotDotDotToken !== undefined) return false;

  let defaulted = false;
  eachNode(clock, (node) => {
    if (ts.isBindingElement(node) && node.initializer !== undefined) defaulted = true;
  });
  return !defaulted;
}
