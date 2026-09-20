import path from "node:path";
import type { SvelteAstNode, SvelteParse } from "@daintreehq/svelte-source-model";
import type { Workspace } from "./workspace.js";
import { containsRealPath, readSource, resolveReportedPath } from "./source.js";

export interface CallSite {
  file: string;
  line: number;
  column: number;
}

export interface ComponentDefinition extends CallSite {
  /** The tag as written at the call site; null when no component starts there. */
  name: string | null;
  /** App-relative file the component is written in; null when it can't be proven. */
  definedIn: string | null;
  /** Revision of the call site's file as it was read for this answer; null when unread. */
  revision: string | null;
  /** Revision of `definedIn` as it was read for this answer. */
  definedInRevision: string | null;
}

/**
 * Where each component used at these call sites is written, read from source:
 * the call site's own file is parsed, the component tag found at that exact
 * position, and its import followed to a `.svelte` file that exists in this app.
 *
 * Nothing is inferred from the rendered page's parent chain. A snippet passed
 * into a component, a wrapper with no element of its own, a dropped frame — all
 * make the chain say something plausible and wrong. What this can't prove
 * (a dynamic component, a package import, an unfamiliar alias) comes back null,
 * and the builder won't send a request naming it.
 */
export async function resolveComponentDefinitions(
  workspace: Workspace,
  callSites: readonly CallSite[],
  parse: SvelteParse,
  lineColumnToOffset: (source: string, line: number, column: number) => number | null,
  isGeneratedSourceFile: (file: string) => boolean
): Promise<ComponentDefinition[]> {
  type Parsed = { text: string; ast: ReturnType<SvelteParse>; revision: string };
  const parsed = new Map<string, Parsed | null>();
  const load = async (file: string) => {
    if (parsed.has(file)) return parsed.get(file)!;
    let entry: Parsed | null = null;
    const target = resolveReportedPath(workspace, file);
    if (
      target.ok &&
      target.appRelative.endsWith(".svelte") &&
      (await containsRealPath(workspace.appRoot, target.absolute))
    ) {
      const read = await readSource(workspace.fs, target.absolute);
      if (read.status === "ok") {
        try {
          entry = {
            text: read.text,
            ast: parse(read.text, { modern: true, filename: file }),
            revision: read.revision,
          };
        } catch {
          entry = null;
        }
      }
    }
    parsed.set(file, entry);
    return entry;
  };

  let libDirectory: string | null | undefined;
  const lib = async () => {
    if (libDirectory === undefined) libDirectory = await defaultLibDirectory(workspace);
    return libDirectory;
  };

  const results: ComponentDefinition[] = [];
  for (const site of callSites) {
    const source = isGeneratedSourceFile(site.file) ? null : await load(site.file);
    const unresolved = (name: string | null): ComponentDefinition => ({
      ...site,
      name,
      definedIn: null,
      revision: source?.revision ?? null,
      definedInRevision: null,
    });
    if (!source) {
      results.push(unresolved(null));
      continue;
    }
    const offset = lineColumnToOffset(source.text, site.line, site.column);
    const component = offset === null ? null : componentAt(source.ast.fragment, offset);
    const name = typeof component?.node.name === "string" ? component.node.name : null;
    if (name === null || name.includes(".")) {
      // No component tag there, or `<ui.Card>`: a namespace member has no import of its own.
      results.push(unresolved(name));
      continue;
    }
    const specifier =
      component === null || boundInTemplate(component, name)
        ? null
        : importSpecifierFor(source.ast, name);
    const candidate =
      specifier === null ? null : resolveSpecifier(site.file, specifier, await lib());
    const target = candidate === null ? null : resolveReportedPath(workspace, candidate);
    // The same boundaries selection and excerpts keep: no generated files, and
    // no symlink leading out of the app.
    const contained =
      target?.ok === true &&
      !isGeneratedSourceFile(target.appRelative) &&
      (await containsRealPath(workspace.appRoot, target.absolute));
    const read = contained && target?.ok ? await readSource(workspace.fs, target.absolute) : null;
    const definedInRevision =
      read?.status === "ok" || read?.status === "not-utf8" ? read.revision : null;
    results.push(
      target?.ok && definedInRevision !== null
        ? {
            ...site,
            name,
            definedIn: target.appRelative,
            revision: source.revision,
            definedInRevision,
          }
        : unresolved(name)
    );
  }
  return results;
}

/** The component tag starting at `offset`, with every template node enclosing it, outermost first. */
function componentAt(
  root: SvelteAstNode,
  offset: number
): { node: SvelteAstNode; ancestors: SvelteAstNode[] } | null {
  const stack: SvelteAstNode[] = [];
  let found: { node: SvelteAstNode; ancestors: SvelteAstNode[] } | null = null;
  const visit = (node: unknown): void => {
    if (found !== null || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const candidate = node as SvelteAstNode;
    if (candidate.type === "Component" && candidate.start === offset) {
      found = { node: candidate, ancestors: [...stack] };
      return;
    }
    stack.push(candidate);
    for (const [key, value] of Object.entries(candidate)) {
      if (key === "parent" || key === "metadata") continue;
      if (value !== null && typeof value === "object") visit(value);
    }
    stack.pop();
  };
  visit(root);
  return found;
}

/**
 * SvelteKit's `$lib` is `src/lib` unless `kit.files.lib` says otherwise, and
 * that config is project code this never runs. A config that mentions
 * `files` anywhere — a key, quoted, shorthand or spread — leaves `$lib`
 * unproven rather than guessed.
 */
async function defaultLibDirectory(workspace: Workspace): Promise<string | null> {
  for (const name of [
    "svelte.config.js",
    "svelte.config.mjs",
    "svelte.config.ts",
    "svelte.config.cjs",
  ]) {
    const read = await readSource(workspace.fs, path.join(workspace.appRoot, name));
    if (read.status !== "ok") continue;
    if (/files/.test(read.text)) return null;
  }
  return "src/lib";
}

interface ImportNode {
  type: string;
  importKind?: string;
  source?: { value?: unknown };
  specifiers?: Array<{ type: string; importKind?: string; local?: { name?: unknown } }>;
}

type AnyNode = { type?: unknown; [key: string]: unknown };

/**
 * The module a component name is imported from — only when that default
 * import is the name's one top-level value binding across both script blocks.
 * Type-only imports don't bind a value; declarations nested in functions or
 * blocks can't reach the markup, so they don't count.
 */
function importSpecifierFor(ast: ReturnType<SvelteParse>, name: string): string | null {
  let specifier: string | null = null;
  let bindings = 0;
  for (const script of [ast.instance, ast.module]) {
    const body = (script as { content?: { body?: unknown } } | undefined)?.content?.body;
    if (!Array.isArray(body)) continue;
    for (const statement of body as AnyNode[]) {
      const declaration =
        statement.type === "ExportNamedDeclaration" && statement.declaration
          ? (statement.declaration as AnyNode)
          : statement;
      const names: string[] = [];
      // Ambient declarations are erased before anything runs.
      if (declaration.declare === true) continue;
      switch (declaration.type) {
        case "ImportDeclaration": {
          const node = declaration as unknown as ImportNode;
          if (node.importKind === "type") break;
          for (const entry of node.specifiers ?? []) {
            if (entry.importKind === "type" || entry.local?.name !== name) continue;
            bindings += 1;
            const value = node.source?.value;
            if (entry.type === "ImportDefaultSpecifier" && typeof value === "string") {
              specifier = value;
            }
          }
          break;
        }
        case "VariableDeclaration":
          for (const declarator of (declaration.declarations as AnyNode[]) ?? []) {
            patternNames(declarator.id, names);
          }
          break;
        case "FunctionDeclaration":
        case "ClassDeclaration":
          patternNames(declaration.id, names);
          break;
        default:
          hoistedVarNames(declaration, names);
      }
      bindings += names.filter((entry) => entry === name).length;
    }
  }
  return bindings === 1 ? specifier : null;
}

/** `var` declared inside blocks hoists to the script's top level; functions stop it. */
function hoistedVarNames(node: unknown, into: string[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) hoistedVarNames(child, into);
    return;
  }
  const current = node as AnyNode;
  switch (current.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "StaticBlock":
      return;
    case "VariableDeclaration":
      if (current.kind === "var" && current.declare !== true) {
        for (const declarator of (current.declarations as AnyNode[]) ?? []) {
          patternNames(declarator.id, into);
        }
      }
      break;
  }
  for (const [key, value] of Object.entries(current)) {
    if (key === "parent" || key === "metadata" || key === "loc") continue;
    if (value !== null && typeof value === "object") hoistedVarNames(value, into);
  }
}

/** Identifiers a destructuring pattern (or its expression spelling in `let:`) binds. */
function patternNames(node: unknown, into: string[]): void {
  if (node === null || typeof node !== "object") return;
  const current = node as AnyNode;
  switch (current.type) {
    case "Identifier":
      if (typeof current.name === "string") into.push(current.name);
      return;
    case "ObjectPattern":
    case "ObjectExpression":
      for (const property of (current.properties as AnyNode[]) ?? []) {
        patternNames(
          property.type === "RestElement" || property.type === "SpreadElement"
            ? property.argument
            : property.value,
          into
        );
      }
      return;
    case "ArrayPattern":
    case "ArrayExpression":
      for (const element of (current.elements as unknown[]) ?? []) patternNames(element, into);
      return;
    case "RestElement":
    case "SpreadElement":
      patternNames(current.argument, into);
      return;
    case "AssignmentPattern":
      patternNames(current.left, into);
      return;
  }
}

/**
 * Whether markup enclosing the call site declares the name itself: a snippet
 * parameter or a sibling snippet, an each item or index, an await value, a
 * `let:` binding (renamed or not), or a `{@const}`/`{const}` in scope. Any of
 * these may be what renders, so the import proves nothing there.
 */
function boundInTemplate(
  { node: component, ancestors }: { node: SvelteAstNode; ancestors: readonly SvelteAstNode[] },
  name: string
): boolean {
  const names: string[] = [];
  const letBindings = (node: AnyNode) => {
    for (const attribute of (node.attributes as AnyNode[] | undefined) ?? []) {
      if (attribute.type !== "LetDirective") continue;
      if (attribute.expression) patternNames(attribute.expression, names);
      else if (typeof attribute.name === "string") names.push(attribute.name);
    }
  };
  ancestors.forEach((ancestor, index) => {
    const node = ancestor as unknown as AnyNode;
    // The branch the call site sits in: block bindings reach only their own.
    const inside = ancestors[index + 1] as unknown;
    switch (node.type) {
      case "SnippetBlock":
        for (const parameter of (node.parameters as unknown[]) ?? []) {
          patternNames(parameter, names);
        }
        break;
      case "EachBlock":
        if (inside === node.body) {
          patternNames(node.context, names);
          if (typeof node.index === "string") names.push(node.index);
        }
        break;
      case "AwaitBlock":
        if (inside === node.then) patternNames(node.value, names);
        if (inside === node.catch) patternNames(node.error, names);
        break;
      case "Fragment":
        for (const child of (node.nodes as AnyNode[]) ?? []) {
          if (child.type === "SnippetBlock") patternNames(child.expression, names);
          if (child.type === "ConstTag" || child.type === "DeclarationTag") {
            const declarations = (child.declaration as AnyNode | undefined)?.declarations;
            for (const declarator of (declarations as AnyNode[] | undefined) ?? []) {
              patternNames(declarator.id, names);
            }
          }
        }
        break;
    }
    letBindings(node);
  });
  // A component filling a named slot takes that slot's `let:` scope itself.
  const own = component as unknown as AnyNode;
  const fillsSlot = ((own.attributes as AnyNode[] | undefined) ?? []).some(
    (attribute) =>
      attribute.type === "Attribute" &&
      attribute.name === "slot" &&
      Array.isArray(attribute.value) &&
      (attribute.value as AnyNode[]).every((part) => part.type === "Text")
  );
  if (fillsSlot) letBindings(own);
  return names.includes(name);
}

/** Relative imports and SvelteKit's `$lib`; anything else can't be followed here. */
function resolveSpecifier(
  importer: string,
  specifier: string,
  libDirectory: string | null
): string | null {
  if (!specifier.endsWith(".svelte")) return null;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  }
  if (specifier.startsWith("$lib/")) {
    return libDirectory === null
      ? null
      : path.posix.join(libDirectory, specifier.slice("$lib".length));
  }
  return null;
}
