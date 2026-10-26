// Reads the browser-storage keys renderer sources use, for check:renderer-storage
// (#14695). It reads syntax, not types, so some uses stay out of its sight on
// purpose, and a key reached only through one of them needs its declaration
// added by hand:
// - a `persist` from a local module that wraps or re-exports zustand's: only
//   imports from `zustand/middleware` are followed;
// - element access (`localStorage[k] = v`, `window["localStorage"]`), and
//   storage reached through an object property or a function another file
//   declares;
// - a new key that a new caller passes to a helper whose storage call carries a
//   `// storage-key:` comment: the comment names only the keys it knew, and the
//   `*_KEY` / `*_PREFIX` constant backstop sees only `daintree`-prefixed
//   constants in a file that mentions storage.

import path from "node:path";
import ts from "typescript";

export interface StorageKeyUse {
  file: string;
  line: number;
  how: "persist-name" | "storage-call" | "key-constant";
  /** The key, or its leading literal when the rest is built at runtime. Empty when unreadable. */
  keys: string[];
  /** The rest of the key is built at runtime, so only a prefix declaration covers it. */
  partial: boolean;
  /** Why the key could not be read, when `keys` is empty. */
  reason?: string;
}

const STORAGE_METHODS = new Set(["getItem", "setItem", "removeItem"]);
const STORAGE_HELPERS = new Set(["readLocalStorageItemSafely"]);
/** A string constant named like a storage key, valued like one of ours. */
const KEY_CONSTANT_NAME = /(?:KEY|PREFIX)$/;
const KEY_CONSTANT_VALUE = /^daintree[-_:]/;
/**
 * For a call that reads a store by the name its own `persist` call already
 * declares, or a key-named constant that is not a storage key.
 */
const DECLARED_ELSEWHERE = "declared-elsewhere";
const ANNOTATION = /storage-key:[ \t]*([^\n*]+)/g;
const STORAGE_EXPRESSION = /(?:^|\.)(?:localStorage|sessionStorage)$/;
/** A type naming the DOM `Storage` (not zustand's `StateStorage`). */
const STORAGE_TYPE =
  /\bStorage\b|\btypeof\s+(?:window\.|globalThis\.)?(?:localStorage|sessionStorage)\b/;

interface Resolved {
  key: string;
  /** The rest of the key is built at runtime, so only a prefix declaration covers it. */
  partial: boolean;
}

/** Named imports from inside the scanned tree, by local name, read through its top-level constants. */
type Imported = ReadonlyMap<string, Resolved>;

/** What a name refers to: a `const`'s initializer, an import, or something that holds no readable key. */
type Binding = ts.Expression | "import" | "unreadable" | undefined;

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function bindsName(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, text));
}

function isConst(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
}

function declares(s: ts.Statement, name: string): Binding {
  if (ts.isVariableStatement(s)) {
    const d = s.declarationList.declarations.find((decl) => bindsName(decl.name, name));
    if (!d) return undefined;
    return isConst(s.declarationList) && ts.isIdentifier(d.name) && d.initializer
      ? d.initializer
      : "unreadable";
  }
  if (ts.isImportDeclaration(s)) {
    const clause = s.importClause;
    const bindings = clause?.namedBindings;
    if (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((el) => el.name.text === name)
    ) {
      return "import";
    }
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
      return "unreadable";
    }
    return clause?.name?.text === name ? "unreadable" : undefined;
  }
  if (
    (ts.isFunctionDeclaration(s) ||
      ts.isClassDeclaration(s) ||
      ts.isEnumDeclaration(s) ||
      ts.isModuleDeclaration(s)) &&
    s.name &&
    ts.isIdentifier(s.name) &&
    s.name.text === name
  ) {
    return "unreadable";
  }
  return undefined;
}

function scopeStatements(n: ts.Node): readonly ts.Statement[] {
  if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) return n.statements;
  if (ts.isCaseBlock(n)) return n.clauses.flatMap((c) => [...c.statements]);
  return [];
}

/**
 * The nearest declaration of `id`'s name enclosing it. A parameter, loop or
 * catch variable, `let`, or `const` without an initializer holds no readable key.
 */
function lookup(id: ts.Identifier): Binding {
  const name = id.text;
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsName(p.name, name))) {
      return "unreadable";
    }
    if (
      (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.initializer) &&
      n.initializer.declarations.some((d) => bindsName(d.name, name))
    ) {
      return "unreadable";
    }
    if (
      ts.isCatchClause(n) &&
      n.variableDeclaration &&
      bindsName(n.variableDeclaration.name, name)
    ) {
      return "unreadable";
    }
    for (const s of scopeStatements(n)) {
      const found = declares(s, name);
      if (found) return found;
    }
  }
  return undefined;
}

function resolveName(
  id: ts.Identifier,
  imported: Imported,
  seen: Set<ts.Node>
): Resolved | undefined {
  const binding = lookup(id);
  if (binding === "import") return imported.get(id.text);
  if (binding === undefined || binding === "unreadable" || seen.has(binding)) return undefined;
  seen.add(binding);
  const value = resolve(binding, imported, seen);
  seen.delete(binding);
  return "key" in value && value.key !== "" ? value : undefined;
}

function resolve(
  node: ts.Expression,
  imported: Imported,
  seen = new Set<ts.Node>()
): Resolved | { reason: string } {
  if (ts.isStringLiteralLike(node)) return { key: node.text, partial: false };
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return resolve(node.expression, imported, seen);
  }
  if (ts.isIdentifier(node)) {
    const known = resolveName(node, imported, seen);
    if (known) return known;
  }
  if (ts.isTemplateExpression(node)) {
    const first = node.templateSpans[0]?.expression;
    if (node.head.text !== "") return { key: node.head.text, partial: true };
    const known = first && ts.isIdentifier(first) ? resolveName(first, imported, seen) : undefined;
    if (known) return { key: known.key, partial: true };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolve(node.left, imported, seen);
    if ("reason" in left) return left;
    const right = resolve(node.right, imported, seen);
    return "key" in right && !right.partial && !left.partial
      ? { key: left.key + right.key, partial: false }
      : { key: left.key, partial: true };
  }
  return {
    reason: `\`${node.getText().slice(0, 60)}\` is not a literal or a named string constant`,
  };
}

/** Top-level string constants, read within their own file, for files that import them. */
function topLevelConstants(sf: ts.SourceFile): Map<string, Resolved> {
  const found = new Map<string, Resolved>();
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s) || !isConst(s.declarationList)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const value = resolve(d.initializer, new Map());
      if ("key" in value && value.key !== "") found.set(d.name.text, value);
    }
  }
  return found;
}

function posix(file: string): string {
  return file.split(path.sep).join("/");
}

/** Every scanned file's path without its extension, and every directory holding one. */
function scannedModules(files: Iterable<string>): Set<string> {
  const modules = new Set<string>();
  for (const file of files) {
    let p = posix(file).replace(/\.tsx?$/, "");
    for (; p !== "." && p !== "" && !modules.has(p); p = path.posix.dirname(p)) modules.add(p);
  }
  return modules;
}

/** Whether an import specifier names a module inside the scanned tree (`@/` is `src/`). */
function inScannedTree(file: string, specifier: string, modules: ReadonlySet<string>): boolean {
  if (specifier.startsWith("@/")) return true;
  if (!specifier.startsWith(".")) return false;
  const target = path.posix
    .join(path.posix.dirname(posix(file)), specifier)
    .replace(/\.(?:[cm]?js|tsx?)$/, "");
  return modules.has(target);
}

/** Names this file imports from inside the scanned tree, as local name to original name. */
function importedNames(
  file: string,
  sf: ts.SourceFile,
  modules: ReadonlySet<string>
): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    if (!inScannedTree(file, s.moduleSpecifier.text, modules)) continue;
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements)
        names.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  return names;
}

/**
 * Keys a `// storage-key: <key> ...` comment names for a call the scan can't
 * read: on the statement holding it, or on a loop or block enclosing it.
 */
function annotatedKeys(sf: ts.SourceFile, node: ts.Node): string[] {
  const keys: string[] = [];
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionLike(n)) break;
    if (!ts.isBlock(n.parent) && !ts.isSourceFile(n.parent)) continue;
    for (const range of ts.getLeadingCommentRanges(sf.text, n.getFullStart()) ?? []) {
      for (const match of sf.text.slice(range.pos, range.end).matchAll(ANNOTATION)) {
        keys.push(...match[1]!.trim().split(/\s+/));
      }
    }
  }
  return keys;
}

/** How zustand's `persist` is called in this file: by an imported name, or as `<namespace>.persist`. */
function persistCallees(sf: ts.SourceFile): (callee: ts.Expression) => boolean {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const s of sf.statements) {
    if (
      !ts.isImportDeclaration(s) ||
      !ts.isStringLiteral(s.moduleSpecifier) ||
      s.moduleSpecifier.text !== "zustand/middleware"
    ) {
      continue;
    }
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if ((el.propertyName ?? el.name).text === "persist") names.add(el.name.text);
    }
  }
  return (callee) =>
    (ts.isIdentifier(callee) && names.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "persist" &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text));
}

/**
 * Whether an expression is web storage: `localStorage` / `sessionStorage`, a
 * variable or parameter bound to it or typed `Storage`, or a call to a function
 * this file declares to return `Storage`.
 */
function storageReceivers(sf: ts.SourceFile): (receiver: ts.Expression) => boolean {
  const factories = new Set<string>();
  const aliases = new Set<string>();
  const typed = (type: ts.TypeNode | undefined) => !!type && STORAGE_TYPE.test(type.getText());
  const isFactoryCall = (node: ts.Expression) => {
    const call = unwrap(node);
    return (
      ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      factories.has(call.expression.text)
    );
  };
  (function findFactories(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && typed(node.type)) {
      factories.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      typed(node.initializer.type)
    ) {
      factories.add(node.name.text);
    }
    ts.forEachChild(node, findFactories);
  })(sf);
  (function findAliases(node: ts.Node) {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && typed(node.type)) {
      aliases.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      const isFunction = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
      if (
        (init && STORAGE_EXPRESSION.test(init.getText())) ||
        (init && isFactoryCall(init)) ||
        (!isFunction && typed(node.type))
      ) {
        aliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, findAliases);
  })(sf);
  return (receiver) => {
    const node = unwrap(receiver);
    return (
      STORAGE_EXPRESSION.test(node.getText()) ||
      (ts.isIdentifier(node) && aliases.has(node.text)) ||
      isFactoryCall(node)
    );
  };
}

/**
 * Reads every browser-storage key the given renderer sources write: the
 * `name` of a zustand `persist` config and the key argument of a
 * `localStorage` / `sessionStorage` call, plus any `*_KEY` / `*_PREFIX` constant
 * holding a Daintree-looking key (storage reached through a helper). A key held
 * in a named string constant resolves through the nearest declaration of that
 * name in scope, or a constant imported from inside the scanned tree; one built
 * from a parameter resolves through a `// storage-key: <key>` comment above the
 * statement.
 */
export function scanSources(sources: ReadonlyMap<string, string>): StorageKeyUse[] {
  const parsed = new Map([...sources].map(([file, text]) => [file, parse(file, text)]));
  const modules = scannedModules(parsed.keys());
  const tally = new Map<string, Set<string>>();
  for (const sf of parsed.values()) {
    for (const [name, value] of topLevelConstants(sf)) {
      if (!tally.has(name)) tally.set(name, new Set());
      tally.get(name)!.add(JSON.stringify(value));
    }
  }
  const shared = new Map<string, Resolved>(
    [...tally]
      .filter(([, values]) => values.size === 1)
      .map(([name, v]) => [name, JSON.parse([...v][0]!) as Resolved])
  );

  const uses: StorageKeyUse[] = [];
  for (const [file, sf] of parsed) {
    const imported = new Map<string, Resolved>();
    for (const [local, original] of importedNames(file, sf, modules)) {
      const value = shared.get(original);
      if (value) imported.set(local, value);
    }
    const isPersist = persistCallees(sf);
    const isStorage = storageReceivers(sf);
    const mentionsStorage = /[sS]torage|persist\(/.test(sf.text);
    const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const record = (node: ts.Node, how: StorageKeyUse["how"], arg: ts.Expression | undefined) => {
      const result = arg ? resolve(arg, imported) : { reason: "no readable key" };
      if ("key" in result) {
        uses.push({ file, line: at(node), how, keys: [result.key], partial: result.partial });
        return;
      }
      const annotated = annotatedKeys(sf, node);
      if (annotated.includes(DECLARED_ELSEWHERE)) return;
      uses.push(
        annotated.length > 0
          ? { file, line: at(node), how, keys: annotated, partial: false }
          : { file, line: at(node), how, keys: [], partial: false, reason: result.reason }
      );
    };

    (function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          STORAGE_METHODS.has(callee.name.text) &&
          isStorage(callee.expression) &&
          node.arguments[0]
        ) {
          record(node, "storage-call", node.arguments[0]);
        }
        if (ts.isIdentifier(callee) && STORAGE_HELPERS.has(callee.text) && node.arguments[0]) {
          record(node, "storage-call", node.arguments[0]);
        }
        if (isPersist(callee)) {
          const options = node.arguments[1];
          const name =
            options && ts.isObjectLiteralExpression(options)
              ? options.properties.find(
                  (p): p is ts.PropertyAssignment =>
                    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "name"
                )
              : undefined;
          if (name) record(name, "persist-name", name.initializer);
          else record(node, "persist-name", undefined);
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        KEY_CONSTANT_NAME.test(node.name.text) &&
        node.initializer &&
        mentionsStorage
      ) {
        const value = resolve(node.initializer, imported);
        if (
          "key" in value &&
          KEY_CONSTANT_VALUE.test(value.key) &&
          !annotatedKeys(sf, node).includes(DECLARED_ELSEWHERE)
        ) {
          uses.push({
            file,
            line: at(node),
            how: "key-constant",
            keys: [value.key],
            partial: value.partial,
          });
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  return uses;
}
