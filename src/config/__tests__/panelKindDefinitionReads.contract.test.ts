import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

// `getPanelKindDefinition` reads mutable module state. Calling it during render
// is unsound under React Compiler (wired for both `vite dev` and `vite build`,
// `compilationMode: "infer"`): the compiler cannot see the mutable read, so it
// caches the call keyed only on the arguments. `GridPanel`/`DockedPanel`
// subscribed to the registry for the rerender but resolved through this getter,
// so the cache kept serving the definition from the fiber's FIRST render — and
// `ContentGridDefault` keys the wrapper on a stable `group.id`, so the fiber
// never remounted. A panel restored before its plugin registered its kind sat on
// "Plugin unavailable" until it was closed and reopened (#11636).
//
// Render paths must instead index the snapshot `useSyncExternalStore` returns,
// which the compiler can see and invalidate. This contract bans the getter
// outside a short imperative allowlist.
//
// Source enforcement rather than a rendering assertion is deliberate: vitest
// runs uncompiled TSX, where the getter re-runs every render and picks the new
// value up, so a rendering test of this passes with or without the bug. The
// compiled bundle is only reachable from E2E, which does not run on PRs.

const GETTER = "getPanelKindDefinition";
const SUBSCRIBE_FN = "subscribeToPanelKindDefinitions";
const SNAPSHOT_FN = "getPanelKindDefinitionsSnapshot";

/** Modules that legitimately call the getter outside a render. */
const IMPERATIVE_ALLOWLIST = new Set([
  // Declares it.
  "panels/registry.tsx",
  // Imperative filter over both registries; its callers own invalidation.
  "registry/spawnablePanelKinds.ts",
]);

/** Render paths that must stay reactive to late plugin kind registration. */
const REQUIRED_SUBSCRIBERS = [
  "components/Terminal/GridPanel.tsx",
  "components/Terminal/DockedPanel.tsx",
  "components/Panel/PanelDialogHost.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/**
 * Local binding names the getter was imported under — following aliases, so
 * `import { getPanelKindDefinition as read }` is still tracked.
 */
function importedGetterNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  eachNode(source, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === GETTER) names.add(element.name.text);
    }
  });
  return names;
}

/** True when one of `names` appears in call position, including `fn?.(…)`. */
function callsAny(source: ts.SourceFile, names: Set<string>): boolean {
  let found = false;
  eachNode(source, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && names.has(callee.text)) found = true;
  });
  return found;
}

/**
 * True when the file binds `useSyncExternalStore(subscribe…, …Snapshot)` to a
 * variable and then indexes that variable. Pinning the *shape* — not just the
 * presence of two symbol names — is what stops a "fix" that keeps the
 * subscription for its rerender but resolves the definition some other way.
 */
function derivesDefinitionFromSnapshot(source: ts.SourceFile): boolean {
  const snapshotBindings = new Set<string>();
  eachNode(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (!ts.isCallExpression(node.initializer)) return;
    const callee = node.initializer.expression;
    const isStoreHook = ts.isIdentifier(callee) && callee.text === "useSyncExternalStore";
    if (!isStoreHook) return;
    const argText = node.initializer.arguments.map((arg) => arg.getText());
    if (!argText.some((a) => a.includes(SUBSCRIBE_FN))) return;
    if (!argText.some((a) => a.includes(SNAPSHOT_FN))) return;
    if (ts.isIdentifier(node.name)) snapshotBindings.add(node.name.text);
  });
  if (snapshotBindings.size === 0) return false;

  let indexed = false;
  eachNode(source, (node) => {
    if (indexed || !ts.isElementAccessExpression(node)) return;
    const target = node.expression;
    if (ts.isIdentifier(target) && snapshotBindings.has(target.text)) indexed = true;
  });
  return indexed;
}

const sourceFiles = walk(SRC_ROOT).map((file) => {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
  return { rel, source: parse(file, text) };
});

describe("panel kind definition reads (#11636)", () => {
  it("keeps the mutable getter out of every module outside the imperative allowlist", () => {
    const offenders = sourceFiles
      .filter((file) => !IMPERATIVE_ALLOWLIST.has(file.rel))
      .filter((file) => {
        const names = importedGetterNames(file.source);
        return names.size > 0 && callsAny(file.source, names);
      })
      .map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it("resolves every panel presentation's definition from the subscribed snapshot", () => {
    const missing = REQUIRED_SUBSCRIBERS.filter((rel) => {
      const file = sourceFiles.find((candidate) => candidate.rel === rel);
      if (!file) throw new Error(`Contract target no longer exists: src/${rel}`);
      return !derivesDefinitionFromSnapshot(file.source);
    });

    expect(missing).toEqual([]);
  });
});
