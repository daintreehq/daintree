import ts from "typescript";

export interface StorageKeyUse {
  file: string;
  line: number;
  how: "persist-name" | "storage-call" | "key-constant";
  /** The key, or its leading literal when the rest is built at runtime. Empty when unreadable. */
  keys: string[];
  /** Why the key could not be read, when `keys` is empty. */
  reason?: string;
}

const STORAGE_METHODS = new Set(["getItem", "setItem", "removeItem"]);
const STORAGE_HELPERS = new Set(["readLocalStorageItemSafely"]);
/** A string constant named like a storage key, valued like one of ours. */
const KEY_CONSTANT_NAME = /(?:KEY|PREFIX)$/;
const KEY_CONSTANT_VALUE = /^(?:daintree|kit)[-_:]/;
const ANNOTATION = /storage-key:[ \t]*([^\n*]+)/g;

type Constants = ReadonlyMap<string, string>;

function literalText(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return literalText(node.expression);
  }
  return null;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function stringConstants(sf: ts.SourceFile): Map<string, string> {
  const found = new Map<string, string>();
  (function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = resolve(node.initializer, found);
      if (typeof value === "string" && value !== "") found.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  })(sf);
  return found;
}

/** Constants a key may name: this file's own, else one every file agrees on. */
function constantsFor(local: Constants, shared: Constants): Constants {
  return new Map([...shared, ...local]);
}

function resolve(node: ts.Expression, constants: Constants): string | { reason: string } {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    const first = node.templateSpans[0]?.expression;
    if (node.head.text !== "") return node.head.text;
    if (first && ts.isIdentifier(first) && constants.has(first.text)) {
      return constants.get(first.text)!;
    }
  }
  if (ts.isIdentifier(node) && constants.has(node.text)) return constants.get(node.text)!;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return resolve(node.expression, constants);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return resolve(node.left, constants);
  }
  return { reason: `\`${node.getText().slice(0, 60)}\` is not a literal or a named string constant` };
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

function importsZustandPersist(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === "zustand/middleware" &&
      /\bpersist\b/.test(s.importClause?.getText() ?? "")
  );
}

/**
 * Reads every browser-storage key the given renderer sources write: the
 * `name` of a zustand `persist` config and the key argument of a
 * `localStorage` / `sessionStorage` call, plus any `*_KEY` / `*_PREFIX` constant
 * holding a Daintree-looking key (storage reached through a helper). A key held in a named string
 * constant resolves through it; one built from a parameter resolves through a
 * `// storage-key: <key>` comment above the statement.
 */
export function scanSources(sources: ReadonlyMap<string, string>): StorageKeyUse[] {
  const parsed = new Map([...sources].map(([file, text]) => [file, parse(file, text)]));
  const tally = new Map<string, Set<string>>();
  const perFile = new Map<string, Map<string, string>>();
  for (const [file, sf] of parsed) {
    const local = stringConstants(sf);
    perFile.set(file, local);
    for (const [name, value] of local) {
      if (!tally.has(name)) tally.set(name, new Set());
      tally.get(name)!.add(value);
    }
  }
  const shared = new Map(
    [...tally].filter(([, values]) => values.size === 1).map(([name, v]) => [name, [...v][0]!])
  );

  const uses: StorageKeyUse[] = [];
  for (const [file, sf] of parsed) {
    const constants = constantsFor(perFile.get(file)!, shared);
    const hasPersist = importsZustandPersist(sf);
    const mentionsStorage = /[sS]torage|persist\(/.test(sf.text);
    const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const record = (node: ts.Node, how: StorageKeyUse["how"], arg: ts.Expression) => {
      const result = resolve(arg, constants);
      if (typeof result === "string") {
        uses.push({ file, line: at(node), how, keys: [result] });
        return;
      }
      const annotated = annotatedKeys(sf, node);
      uses.push(
        annotated.length > 0
          ? { file, line: at(node), how, keys: annotated }
          : { file, line: at(node), how, keys: [], reason: result.reason }
      );
    };

    (function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          STORAGE_METHODS.has(callee.name.text) &&
          /(?:^|\.)(?:localStorage|sessionStorage)$/.test(callee.expression.getText()) &&
          node.arguments[0]
        ) {
          record(node, "storage-call", node.arguments[0]);
        }
        if (ts.isIdentifier(callee) && STORAGE_HELPERS.has(callee.text) && node.arguments[0]) {
          record(node, "storage-call", node.arguments[0]);
        }
        if (hasPersist && ts.isIdentifier(callee) && callee.text === "persist") {
          const options = node.arguments[1];
          const name =
            options && ts.isObjectLiteralExpression(options)
              ? options.properties.find(
                  (p): p is ts.PropertyAssignment =>
                    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "name"
                )
              : undefined;
          if (name) record(name, "persist-name", name.initializer);
          else
            uses.push({
              file,
              line: at(node),
              how: "persist-name",
              keys: [],
              reason: "persist options are not an object literal with a `name`",
            });
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        KEY_CONSTANT_NAME.test(node.name.text) &&
        node.initializer
      ) {
        const value = resolve(node.initializer, constants);
        if (typeof value === "string" && mentionsStorage && KEY_CONSTANT_VALUE.test(value)) {
          uses.push({ file, line: at(node), how: "key-constant", keys: [value] });
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  return uses;
}
