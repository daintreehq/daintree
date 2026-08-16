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
// Two invariants, because the type checker only covers half of it. A required
// clock parameter turns an omitted argument into a compile error, but it cannot
// stop a caller passing `Date.now()` inline, which type checks and freezes just
// the same. The palette contract covers that half by pinning where the clock
// comes from.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PALETTE_PATH = path.resolve(TEST_DIR, "../ProjectSwitcherPalette.tsx");
const HELPERS_PATH = path.resolve(TEST_DIR, "../../../lib/projectRowStatus.ts");

/** The status-helper family: `getProjectRowStatus`, `getScratchRowStatus`, and any sibling. */
const HELPER_PATTERN = /^get.+RowStatus$/;

/**
 * Components whose clock is knowingly still ambient.
 *
 * `ScratchSection` reads `Date.now()` in its own body. The palette holds a
 * per-minute tick for it, but that tick is state on the palette root and never
 * reaches here: the compiler caches the `<ScratchSection>` element on its props
 * alone, so the root re-runs and the cached child is reused. Threading a clock
 * into it is a separate fix from the ranked row #11823 reports, and listing it
 * here keeps the gap visible instead of letting a suffix-matched predicate
 * quietly skip it.
 */
const AMBIENT_CLOCK_ALLOWLIST = new Set(["ScratchSection"]);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/**
 * Local binding names the status helpers were imported under, following aliases
 * so `import { getScratchRowStatus as read }` is still tracked.
 */
function importedHelperNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  eachNode(source, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (HELPER_PATTERN.test(imported)) names.add(element.name.text);
    }
  });
  return names;
}

/**
 * The component a call sits in. Nearest enclosing function *declaration*, so a
 * call made from a nested `renderItem`-style arrow still resolves to the
 * component whose props hold the clock.
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
 * Whether `argument` is that component's own prop — a destructured binding with
 * no default of its own, or a member of a whole-props parameter. Anything else
 * (an ambient `Date.now()`, a module constant, a local re-binding) is invisible
 * to the compiler's cache key and cannot invalidate the row.
 */
function comesFromProps(owner: ts.FunctionDeclaration, argument: ts.Expression): boolean {
  const props = owner.parameters[0];
  if (!props) return false;

  if (ts.isObjectBindingPattern(props.name)) {
    if (!ts.isIdentifier(argument)) return false;
    return props.name.elements.some(
      (element) =>
        ts.isIdentifier(element.name) &&
        element.name.text === argument.text &&
        element.initializer === undefined
    );
  }

  return (
    ts.isIdentifier(props.name) &&
    ts.isPropertyAccessExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === props.name.text
  );
}

const palette = parse(PALETTE_PATH);
const helperNames = importedHelperNames(palette);

interface HelperCall {
  helper: string;
  owner: string;
  line: number;
  clock: ts.Expression | undefined;
  ownerNode: ts.FunctionDeclaration | undefined;
}

const paletteCalls: HelperCall[] = [];
eachNode(palette, (node) => {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
  if (!helperNames.has(node.expression.text)) return;
  const ownerNode = owningComponent(node);
  paletteCalls.push({
    helper: node.expression.text,
    owner: ownerNode?.name?.text ?? "<module>",
    line: palette.getLineAndCharacterOfPosition(node.getStart(palette)).line + 1,
    clock: node.arguments[1],
    ownerNode,
  });
});

describe("row status clocks (#11823)", () => {
  it("renders every palette row against a clock handed to it, never one it reads itself", () => {
    // Guards the walk itself: a rename or a moved import that stopped matching
    // would otherwise leave an empty list quietly passing every assertion.
    expect(helperNames.size).toBeGreaterThan(0);
    expect(paletteCalls.length).toBeGreaterThan(0);

    const offenders = paletteCalls
      .filter(({ owner }) => !AMBIENT_CLOCK_ALLOWLIST.has(owner))
      .filter(({ ownerNode, clock }) => !ownerNode || !clock || !comesFromProps(ownerNode, clock))
      .map(
        ({ owner, helper, line, clock }) =>
          `${owner}:${line} ${helper}(…, ${clock?.getText(palette) ?? "<no clock>"}) — the clock is not one of ${owner}'s props`
      );

    expect(offenders).toEqual([]);
  });

  it("leaves the status helpers no ambient clock to fall back to", () => {
    const helpers = parse(HELPERS_PATH);

    const declarations = helpers.statements
      .filter(ts.isFunctionDeclaration)
      .filter((fn) => fn.name !== undefined && HELPER_PATTERN.test(fn.name.text));

    expect(declarations.length).toBeGreaterThan(0);

    const offenders = declarations
      .filter((fn) => fn.parameters.some((parameter) => parameter.initializer !== undefined))
      .map(
        (fn) => `${fn.name?.text ?? "<anonymous>"} defaults a parameter instead of requiring it`
      );

    expect(offenders).toEqual([]);
  });
});
