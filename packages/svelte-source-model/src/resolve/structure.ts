import { lineColumnToOffset } from "../splice.js";
import type { DevLocation, SvelteAstNode, SvelteAstRoot, SvelteParse } from "../types.js";

/**
 * Finding an element by where it sits in its template, for when the location
 * the page stamped on it cannot be trusted.
 *
 * Svelte's dev runtime assigns `__svelte_meta.loc` by walking a template's
 * rendered siblings and handing each element the next location in the
 * compiler's list. On a server-rendered page that walk also meets the root a
 * child component rendered just before the template's own elements, and from
 * then on every element carries its neighbour's location — a `div` reports the
 * line of the `span` after it, and the last elements report nothing at all. A
 * client-side render never does this; hydration does it every time.
 *
 * What the runtime cannot get wrong is the shape: an element's tag, which
 * frame (block or component invocation) its template belongs to, and its
 * position among that frame's own elements at each level. The compiler's
 * location list is derived from exactly that shape, so the source can be
 * walked the same way — the fragment for the frame, its own elements in
 * order, down the path — and the element found without the stamp.
 *
 * Exact where the page and the source can be shown to count alike, refused
 * where they cannot: raw `{@html}` markup and a `<slot>`'s
 * fallback render under the template's own frame but are not elements of the
 * source; a `<svelte:element>` may render nothing; a `<svelte:boundary>` and
 * a `<svelte:fragment>` hold elements without a frame of their own. And
 * every iteration of an `{#each}` body shares one frame and one parent, so
 * past the first iteration a position no longer says which root it is.
 */

/** The nearest frame on the element's `__svelte_meta.parent` chain, as the page reports it. */
export interface StructureFrame {
  type: string;
  file: string;
  line: number;
  column: number;
}

/** One level of the path: the element's tag, and its index among the frame's own elements there. */
export interface StructureStep {
  tag: string;
  index: number;
}

export interface StructureRequest {
  /**
   * The frame the element's template belongs to; null when the file's root
   * fragment renders with no frame at all. A `component` frame (which lives in
   * the parent file) and a null frame both mean the root fragment.
   */
  frame: StructureFrame | null;
  /** Outermost first, ending at the element. */
  path: readonly StructureStep[];
  /**
   * A location the page stamped on the element, if any. Wrong, but wrong by
   * a neighbour's: it lands inside the same template, which is enough to say
   * which snippet or branch to walk when the frame alone offers several.
   */
  hint: DevLocation | null;
}

export type StructureFailureReason =
  | "parse-failed"
  | "no-fragment"
  | "ambiguous-fragment"
  | "no-element-at-path"
  /** A level holds markup the page and the source would count differently. */
  | "uncountable-level";

export type StructureResult =
  | { status: "resolved"; location: DevLocation; kind: string; tagName: string }
  | { status: "failed"; reason: StructureFailureReason; detail?: string };

/** Local rather than shared: this package deliberately depends on nothing of Daintree's. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const OWN_ELEMENT_TYPES: ReadonlySet<string> = new Set(["RegularElement"]);

/**
 * Node kinds that put elements into the same parent as the template's own,
 * or take one away, without a frame the page could tell them apart by.
 */
const UNCOUNTABLE_TYPES: ReadonlySet<string> = new Set([
  "HtmlTag",
  "SlotElement",
  "SvelteElement",
  "SvelteFragment",
  "SvelteBoundary",
]);

/** Keys under which the block kinds keep their fragments. */
const FRAGMENT_KEYS = [
  "fragment",
  "body",
  "fallback",
  "consequent",
  "alternate",
  "pending",
  "then",
  "catch",
] as const;

const SNIPPET_HOST_TYPES: ReadonlySet<string> = new Set([
  "Component",
  "SvelteComponent",
  "SvelteSelf",
]);

function isFragment(value: unknown): value is SvelteAstNode {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

/** The fragment's own rendered elements at this level, or null when the level cannot be counted. */
function ownElements(fragment: SvelteAstNode | undefined): SvelteAstNode[] | null {
  if (fragment === undefined || !Array.isArray(fragment.nodes)) return [];
  if (fragment.nodes.some((node) => UNCOUNTABLE_TYPES.has(node.type))) return null;
  return fragment.nodes.filter((node) => OWN_ELEMENT_TYPES.has(node.type));
}

function tagMatches(node: SvelteAstNode, tag: string): boolean {
  return typeof node.name === "string" && node.name.toLowerCase() === tag.toLowerCase();
}

function span(fragment: SvelteAstNode): { start: number; end: number } | null {
  const nodes = fragment.nodes ?? [];
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) return null;
  return { start: first.start, end: last.end };
}

function contains(fragment: SvelteAstNode, offset: number): boolean {
  const range = span(fragment);
  return range !== null && offset >= range.start && offset < range.end;
}

/** Every node in the tree, in document order, skipping the parent back-references. */
function* walk(value: unknown, seen: Set<object>): Generator<SvelteAstNode> {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item, seen);
    return;
  }
  const node = value as SvelteAstNode;
  if (typeof node.type === "string") yield node;
  for (const [key, child] of Object.entries(value)) {
    if (key === "parent") continue;
    yield* walk(child, seen);
  }
}

/**
 * A block's fragments. An `{:else if}` is a nested block in the source but is
 * rendered under the outer `{#if}`'s frame, so its branches are the outer
 * block's too.
 */
function blockFragments(block: SvelteAstNode): SvelteAstNode[] {
  const fragments: SvelteAstNode[] = [];
  for (const key of FRAGMENT_KEYS) {
    const value = block[key];
    if (!isFragment(value)) continue;
    const only = value.nodes?.length === 1 ? value.nodes[0] : undefined;
    if (only !== undefined && only.type === "IfBlock" && only["elseif"] === true) {
      fragments.push(...blockFragments(only));
    } else {
      fragments.push(value);
    }
  }
  return fragments;
}

/**
 * The fragments a frame could stand for. A block has one per branch; a render
 * frame names a `{@render}` in the rendering file, so the body it rendered is
 * any snippet — declared or a component's implicit children — in this one.
 */
function candidateFragments(
  ast: SvelteAstRoot,
  source: string,
  frame: StructureFrame | null,
  file: string
): SvelteAstNode[] | { reason: StructureFailureReason; detail: string } {
  if (frame === null) return [ast.fragment];
  if (frame.type === "component") {
    // A component's own template renders under its invocation frame, whose
    // call site is in the parent file. That call site being in THIS file
    // means the elements are content supplied to the component — a legacy
    // `<slot>` fills with the caller's markup under the callee's frame — and
    // the fragment to walk is the Component node's own.
    if (frame.file !== file) return [ast.fragment];
    const offset = lineColumnToOffset(source, frame.line, frame.column);
    if (offset === null)
      return { reason: "no-fragment", detail: `component frame at ${frame.line}:${frame.column}` };
    for (const node of walk(ast.fragment, new Set())) {
      if (node.start === offset && SNIPPET_HOST_TYPES.has(node.type)) {
        return isFragment(node.fragment) ? [node.fragment] : [];
      }
    }
    return { reason: "no-fragment", detail: `no component starts at offset ${offset}` };
  }
  if (frame.type === "render" || frame.type === "snippet") {
    const bodies: SvelteAstNode[] = [];
    for (const node of walk(ast.fragment, new Set())) {
      if (node.type === "SnippetBlock" && isFragment(node.body)) bodies.push(node.body);
      else if (SNIPPET_HOST_TYPES.has(node.type) && isFragment(node.fragment)) {
        bodies.push(node.fragment);
      }
    }
    return bodies;
  }
  if (frame.file !== file) {
    return {
      reason: "no-fragment",
      detail: `${frame.type} frame in ${frame.file} cannot hold an element of ${file}`,
    };
  }
  const offset = lineColumnToOffset(source, frame.line, frame.column);
  if (offset === null) {
    return {
      reason: "no-fragment",
      detail: `${frame.type} frame at ${frame.line}:${frame.column}`,
    };
  }
  for (const node of walk(ast.fragment, new Set())) {
    if (node.start !== offset || !node.type.endsWith("Block")) continue;
    return blockFragments(node);
  }
  return { reason: "no-fragment", detail: `no block starts at offset ${offset}` };
}

type Followed =
  { status: "found"; node: SvelteAstNode } | { status: "missed" } | { status: "uncountable" };

/**
 * Walks one candidate fragment down the path. Every iteration of an `{#each}`
 * body puts its roots beside the last iteration's under one parent, and a
 * hydrated page drops the stamps off the tail of each, so past the first
 * iteration a position cannot be folded back onto the body's roots — except
 * when the body has one root, which every position then is.
 */
function follow(
  fragment: SvelteAstNode,
  path: readonly StructureStep[],
  frame: StructureFrame | null
): Followed {
  let level = ownElements(fragment);
  let found: SvelteAstNode | null = null;
  for (const [depth, step] of path.entries()) {
    if (level === null) return { status: "uncountable" };
    if (level.length === 0) return { status: "missed" };
    let index = step.index;
    if (depth === 0 && frame?.type === "each") {
      if (level.length === 1) index = 0;
      else if (index >= level.length) return { status: "missed" };
    }
    const node = level[index];
    if (node === undefined || !tagMatches(node, step.tag)) return { status: "missed" };
    found = node;
    level = ownElements(node.fragment);
  }
  return found === null ? { status: "missed" } : { status: "found", node: found };
}

function lineColumnOf(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < offset; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
      lineStart = cursor + 1;
    }
  }
  return { line, column: offset - lineStart };
}

/**
 * Resolves an element by its place in its template rather than by the
 * location the page stamped on it. Exact or nothing: the path has to land on
 * an element with the reported tag in exactly one fragment the frame could
 * mean, through levels the page and the source count alike, or the request
 * fails and the caller keeps its stale answer.
 */
export function resolveElementByStructure(
  source: string,
  file: string,
  request: StructureRequest,
  parse: SvelteParse
): StructureResult {
  if (request.path.length === 0) {
    return { status: "failed", reason: "no-element-at-path", detail: "empty path" };
  }
  let ast: SvelteAstRoot;
  try {
    ast = parse(source, { modern: true, filename: file });
  } catch (error) {
    return { status: "failed", reason: "parse-failed", detail: describeError(error) };
  }
  const candidates = candidateFragments(ast, source, request.frame, file);
  if (!Array.isArray(candidates)) return { status: "failed", ...candidates };
  if (candidates.length === 0) {
    return { status: "failed", reason: "no-fragment", detail: "the frame holds no fragment" };
  }
  // The stamped location, wrong as it is, lies in the element's own template;
  // when it narrows the fragments, only those are walked.
  const hintOffset =
    request.hint === null
      ? null
      : lineColumnToOffset(source, request.hint.line, request.hint.column);
  const narrowed =
    hintOffset === null
      ? candidates
      : candidates.filter((fragment) => contains(fragment, hintOffset));
  const walked = (narrowed.length > 0 ? narrowed : candidates).map((fragment) =>
    follow(fragment, request.path, request.frame)
  );
  const found = walked.filter(
    (outcome): outcome is Extract<Followed, { status: "found" }> => outcome.status === "found"
  );
  const detail = request.path.map((step) => `${step.tag}[${step.index}]`).join(" > ");
  // A fragment the page and the source count differently may be the one the
  // element is in; another fragment answering says nothing about that.
  if (walked.some((outcome) => outcome.status === "uncountable")) {
    return { status: "failed", reason: "uncountable-level", detail };
  }
  if (found.length === 0) return { status: "failed", reason: "no-element-at-path", detail };
  if (found.length > 1) {
    return {
      status: "failed",
      reason: "ambiguous-fragment",
      detail: `${found.length} fragments hold an element at that path`,
    };
  }
  const node = found[0]!.node;
  const { line, column } = lineColumnOf(source, node.start);
  return {
    status: "resolved",
    location: { file, line, column },
    kind: node.type,
    tagName: typeof node.name === "string" ? node.name : "element",
  };
}
