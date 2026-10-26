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
const KEY_CONSTANT_VALUE = /^(?:daintree|kit)[-_:]/;
/** For a call that reads a store by the name its own `persist` call already declares. */
const DECLARED_ELSEWHERE = "declared-elsewhere";
const ANNOTATION = /storage-key:[ \t]*([^\n*]+)/g;

interface Resolved {
  key: string;
  /** The rest of the key is built at runtime, so only a prefix declaration covers it. */
  partial: boolean;
}

type Constants = ReadonlyMap<string, Resolved>;

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function stringConstants(sf: ts.SourceFile): Map<string, Resolved> {
  const found = new Map<string, Resolved>();
  (function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = resolve(node.initializer, found);
      if ("key" in value && value.key !== "") found.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  })(sf);
  return found;
}

/** Names this file imports, as local name, so a shared constant is only read where it is in scope. */
function importedNames(sf: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) continue;
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements)
        names.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  return names;
}

function resolve(node: ts.Expression, constants: Constants): Resolved | { reason: string } {
  if (ts.isStringLiteralLike(node)) return { key: node.text, partial: false };
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return resolve(node.expression, constants);
  }
  if (ts.isIdentifier(node)) {
    const known = constants.get(node.text);
    if (known) return known;
  }
  if (ts.isTemplateExpression(node)) {
    const first = node.templateSpans[0]?.expression;
    if (node.head.text !== "") return { key: node.head.text, partial: true };
    const known = first && ts.isIdentifier(first) ? constants.get(first.text) : undefined;
    if (known) return { key: known.key, partial: true };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolve(node.left, constants);
    if ("reason" in left) return left;
    const right = resolve(node.right, constants);
    return "key" in right && !right.partial && !left.partial
      ? { key: left.key + right.key, partial: false }
      : { key: left.key, partial: true };
  }
  return {
    reason: `\`${node.getText().slice(0, 60)}\` is not a literal or a named string constant`,
  };
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

/** Local names `persist` is imported under from zustand's middleware. */
function persistNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const s of sf.statements) {
    if (
      !ts.isImportDeclaration(s) ||
      !ts.isStringLiteral(s.moduleSpecifier) ||
      s.moduleSpecifier.text !== "zustand/middleware"
    ) {
      continue;
    }
    const bindings = s.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if ((el.propertyName ?? el.name).text === "persist") names.add(el.name.text);
    }
  }
  return names;
}

const STORAGE_EXPRESSION = /(?:^|\.)(?:localStorage|sessionStorage)$/;

/** Variables bound to `localStorage` / `sessionStorage`, so `storage.setItem(...)` is read too. */
function storageAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  (function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      STORAGE_EXPRESSION.test(node.initializer.getText())
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  })(sf);
  return aliases;
}

/**
 * Reads every browser-storage key the given renderer sources write: the
 * `name` of a zustand `persist` config and the key argument of a
 * `localStorage` / `sessionStorage` call, plus any `*_KEY` / `*_PREFIX` constant
 * holding a Daintree-looking key (storage reached through a helper). A key held
 * in a named string constant resolves through this file's own constants or ones
 * it imports; one built from a parameter resolves through a
 * `// storage-key: <key>` comment above the statement.
 */
export function scanSources(sources: ReadonlyMap<string, string>): StorageKeyUse[] {
  const parsed = new Map([...sources].map(([file, text]) => [file, parse(file, text)]));
  const tally = new Map<string, Set<string>>();
  const perFile = new Map<string, Map<string, Resolved>>();
  for (const [file, sf] of parsed) {
    const local = stringConstants(sf);
    perFile.set(file, local);
    for (const [name, value] of local) {
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
    const imported = importedNames(sf);
    const constants = new Map<string, Resolved>();
    for (const [local, original] of imported) {
      const value = shared.get(original);
      if (value) constants.set(local, value);
    }
    for (const [name, value] of perFile.get(file)!) constants.set(name, value);
    const persistCallees = persistNames(sf);
    const aliases = storageAliases(sf);
    const mentionsStorage = /[sS]torage|persist\(/.test(sf.text);
    const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const record = (node: ts.Node, how: StorageKeyUse["how"], arg: ts.Expression | undefined) => {
      const result = arg ? resolve(arg, constants) : { reason: "no readable key" };
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
          (STORAGE_EXPRESSION.test(callee.expression.getText()) ||
            (ts.isIdentifier(callee.expression) && aliases.has(callee.expression.text))) &&
          node.arguments[0]
        ) {
          record(node, "storage-call", node.arguments[0]);
        }
        if (ts.isIdentifier(callee) && STORAGE_HELPERS.has(callee.text) && node.arguments[0]) {
          record(node, "storage-call", node.arguments[0]);
        }
        if (ts.isIdentifier(callee) && persistCallees.has(callee.text)) {
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
        node.initializer
      ) {
        const value = resolve(node.initializer, constants);
        if ("key" in value && mentionsStorage && KEY_CONSTANT_VALUE.test(value.key)) {
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
