import path from "node:path";
import { lineColumnToOffset, type SvelteAstNode } from "@daintreehq/svelte-source-model";
import type { SvelteEvidence } from "../../../../../../shared/elementPicker/evidence.js";
import type {
  ComponentDefinition,
  ResolutionResult,
  SourceFileRef,
  UnavailableReason,
} from "../../../../../../shared/elementPicker/resolution.js";
import type { SourceCandidate } from "../../../../../../shared/elementPicker/source.js";
import { unavailableResult } from "../../../outcomes.js";
import {
  isGenerated,
  metaPosition,
  rangeLocation,
  staleResult,
  stoppedReason,
  unreadableResult,
  type ReadSource,
  type SvelteJob,
} from "./context.js";

type SvelteAst = ReturnType<SvelteJob["parse"]>;

/**
 * What the call site's own source says about where its component is written.
 * Nothing is inferred from the rendered page's parent chain: a snippet passed
 * into a component, a wrapper with no element of its own or a dropped frame
 * all make the chain name something plausible and wrong. A dynamic component,
 * a namespace tag, a package import or an unfamiliar alias is `unproven`.
 */
export type DefinitionProof =
  | { status: "proven"; definition: ComponentDefinition; importer: ReadSource }
  | { status: "unproven" }
  /** The call site's file changed since an earlier result was held to it. */
  | { status: "stale" }
  /** Stopped before it could say; a reason that is not evidence either way. */
  | { status: "stopped"; reason: UnavailableReason };

export interface InvocationOutcome {
  result: ResolutionResult;
  proof: DefinitionProof;
}

/** Tag kinds a `component` ancestry frame can point at. */
const INVOCATION_TYPES: ReadonlySet<string> = new Set([
  "Component",
  "SvelteComponent",
  "SvelteSelf",
]);

/**
 * A component's call site: the tag must start exactly at the location, and
 * where the page recorded the tag it was written as, be that tag.
 */
export async function resolveInvocation(
  job: SvelteJob,
  candidate: Extract<SourceCandidate, { kind: "component-invocation" }>,
  evidence: SvelteEvidence | undefined
): Promise<InvocationOutcome> {
  const fail = (result: ResolutionResult, proof: DefinitionProof = { status: "unproven" }) => ({
    result,
    proof,
  });
  const located = await job.locate(candidate.file);
  if (!located.ok) {
    return fail(unavailableResult(candidate, located.reason), stopped(located.reason));
  }
  const file = located.value;
  // SvelteKit's route shell really is an ancestor of every node on the page,
  // and never a call site anyone edits.
  if (isGenerated(candidate.file, file.path) || !file.path.endsWith(".svelte")) {
    return fail(unavailableResult(candidate, "unsupported"));
  }
  const claimed = await job.readClaimed(candidate, file);
  if (!claimed.ok) {
    const result = claimed.result;
    if (result.state === "stale") return fail(result, { status: "stale" });
    return fail(result, result.state === "unavailable" ? stopped(result.reason) : undefined);
  }
  const source = claimed.source;
  if (source.text === null) return fail(unreadableResult(candidate, "unsupported", source));
  let ast: SvelteAst;
  try {
    ast = job.parse(source.text, { modern: true, filename: candidate.file });
  } catch {
    return fail(unreadableResult(candidate, "unsupported", source));
  }

  const at = metaPosition(candidate.location);
  const offset = lineColumnToOffset(source.text, at.line, at.column);
  const found = offset === null ? null : nodeAt(ast.fragment, offset, INVOCATION_TYPES);
  if (found === null) return fail(unreadableResult(candidate, "mismatch", source));
  const tag = await recordedTag(job, candidate, evidence);
  if (tag !== null && found.node.name !== tag) {
    return fail(unreadableResult(candidate, "mismatch", source));
  }

  const proof = await followImport(job, source, ast, found);
  return {
    result: {
      state: "verified",
      candidateId: candidate.candidateId,
      claim: candidate.kind,
      target: { file, location: rangeLocation(source.text, found.node.start, found.node.end) },
      fileRevision: source.revision,
      ...(proof.status === "proven" ? { definition: proof.definition } : {}),
    },
    proof,
  };
}

function stopped(reason: UnavailableReason): DefinitionProof {
  return stoppedReason(reason) ? { status: "stopped", reason } : { status: "unproven" };
}

/** The tag the page recorded for the `component` frame at this call site, verbatim. */
async function recordedTag(
  job: SvelteJob,
  candidate: Extract<SourceCandidate, { kind: "component-invocation" }>,
  evidence: SvelteEvidence | undefined
): Promise<string | null> {
  const at = metaPosition(candidate.location);
  for (const frame of evidence?.ancestry ?? []) {
    if (frame.type !== "component" || frame.componentTag === undefined) continue;
    if (frame.line !== at.line || frame.column !== at.column) continue;
    if (await job.sameFile(frame.file, candidate.file)) return frame.componentTag;
  }
  return null;
}

/**
 * The definition a candidate names, held to what the call site's source
 * proves: the same file is verified as a file, and nothing finer, since an
 * import says where a component is written and not where in it; a different
 * one is a mismatch read in the call site's file, where the binding that
 * contradicts it was found. What the source cannot prove leaves the
 * candidate's own file as it was reported, read but unchecked.
 */
export async function resolveDefinition(
  job: SvelteJob,
  candidate: SourceCandidate,
  invocation: InvocationOutcome | null
): Promise<ResolutionResult> {
  const proof = invocation?.proof ?? { status: "unproven" };
  if (proof.status === "stopped") return unavailableResult(candidate, proof.reason);
  const located = await job.locate(candidate.file);
  if (!located.ok) return unavailableResult(candidate, located.reason);
  const file = located.value;
  if (isGenerated(candidate.file, file.path)) return unavailableResult(candidate, "unsupported");
  if (proof.status === "stale") {
    // The proof came from bytes that are gone; whether the import still says
    // the same is a question for a fresh selection, not this one.
    return staleResult(candidate, file, job.knownRevision(file) ?? null, null, "file-changed");
  }
  const claimed = await job.readClaimed(candidate, file);
  if (!claimed.ok) return claimed.result;
  if (proof.status === "proven") {
    if (proof.definition.file.path === file.path) {
      return {
        state: "verified",
        candidateId: candidate.candidateId,
        claim: candidate.kind,
        target: { file, location: null },
        fileRevision: claimed.source.revision,
      };
    }
    return unreadableResult(candidate, "mismatch", proof.importer);
  }
  return {
    state: "observed",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: { file, location: candidate.kind === "file-hint" ? null : candidate.location },
    fileRevision: claimed.source.revision,
  };
}

async function followImport(
  job: SvelteJob,
  importer: ReadSource,
  ast: SvelteAst,
  found: { node: SvelteAstNode; ancestors: SvelteAstNode[] }
): Promise<DefinitionProof> {
  if (found.node.type !== "Component") return { status: "unproven" };
  const name = typeof found.node.name === "string" ? found.node.name : null;
  // `<ui.Card>`: a namespace member has no import of its own.
  if (name === null || name.includes(".")) return { status: "unproven" };
  if (boundInTemplate(found, name)) return { status: "unproven" };
  const specifier = importSpecifierFor(ast, name);
  if (specifier === null || !specifier.endsWith(".svelte") || specifier.length > 1024) {
    return { status: "unproven" };
  }

  let file: SourceFileRef;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const joined = path.posix.normalize(
      path.posix.join(path.posix.dirname(importer.file.path), specifier)
    );
    if (joined.startsWith("../") || path.posix.isAbsolute(joined)) return { status: "unproven" };
    file = { workspaceId: job.workspaceId, path: joined };
  } else if (specifier.startsWith("$lib/")) {
    const lib = await job.libDirectory();
    if (lib.status !== "found") return lib.status === "stopped" ? lib : { status: "unproven" };
    const located = await job.locate(
      path.posix.join(lib.directory, specifier.slice("$lib/".length))
    );
    if (!located.ok) return stopped(located.reason);
    file = located.value;
  } else {
    return { status: "unproven" };
  }
  // The same boundaries the selection itself keeps: no generated file, and
  // main's containment, symlinks included, on the read.
  if (isGenerated(file.path)) return { status: "unproven" };
  const read = await job.read(file);
  if (!read.ok) return stopped(read.reason);
  return {
    status: "proven",
    definition: { file, fileRevision: read.source.revision, specifier },
    importer,
  };
}

/** The tag of one of `types` starting at `offset`, with every template node enclosing it, outermost first. */
function nodeAt(
  root: SvelteAstNode,
  offset: number,
  types: ReadonlySet<string>
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
    if (types.has(candidate.type) && candidate.start === offset) {
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
function importSpecifierFor(ast: SvelteAst, name: string): string | null {
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
