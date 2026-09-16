import type {
  ResolvedElement,
  SurfaceSupport,
  SvelteAstNode,
  SvelteAstRoot,
  UnsupportedSurfaceReason,
} from "../types.js";

/**
 * Node types whose `start` is the offset of an opening `<`. That is the whole
 * requirement for offset matching, and it is why components are in the list:
 * a `component` ancestry frame points at the invocation tag in the parent file,
 * not at anything inside the component.
 */
const TAG_NODE_TYPES: ReadonlySet<string> = new Set([
  "RegularElement",
  "Component",
  "SvelteElement",
  "SvelteComponent",
  "SvelteSelf",
  "SvelteFragment",
  "SvelteBoundary",
  "SvelteHead",
  "SvelteWindow",
  "SvelteBody",
  "SvelteDocument",
  "TitleElement",
  "SlotElement",
]);

const COMPONENT_NODE_TYPES: ReadonlySet<string> = new Set([
  "Component",
  "SvelteComponent",
  "SvelteSelf",
]);

function isTagNode(node: SvelteAstNode): boolean {
  return TAG_NODE_TYPES.has(node.type) && typeof node.start === "number";
}

/**
 * Every tag node in the tree, in document order.
 *
 * Walks generically rather than through a hand-written list of block shapes:
 * `{#each}`, `{#if}`, `{#await}`, `{#snippet}` and whatever a future release
 * adds all hold their children under differently-named keys, and a missed key
 * would silently make an element unresolvable. `parent` is skipped and visited
 * nodes are remembered because a back-reference would otherwise cycle.
 */
function* walkTagNodes(value: unknown, seen: Set<object>): Generator<SvelteAstNode> {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) yield* walkTagNodes(item, seen);
    return;
  }

  const node = value as SvelteAstNode;
  if (typeof node.type === "string" && isTagNode(node)) yield node;

  for (const [key, child] of Object.entries(value)) {
    if (key === "parent") continue;
    yield* walkTagNodes(child, seen);
  }
}

export function* tagNodes(ast: SvelteAstRoot): Generator<SvelteAstNode> {
  yield* walkTagNodes(ast.fragment, new Set());
}

export function findTagNodesAtOffset(ast: SvelteAstRoot, offset: number): SvelteAstNode[] {
  const matches: SvelteAstNode[] = [];
  for (const node of tagNodes(ast)) {
    if (node.start === offset) matches.push(node);
  }
  return matches;
}

function unsupported(reason: UnsupportedSurfaceReason): SurfaceSupport {
  return { support: "unsupported", reason };
}

/**
 * What an attribute's value supports.
 *
 * `direct` means exactly one thing: the range is the interior of a quoted
 * literal, so a replacement can be written into it verbatim. Three things are
 * refused for that reason:
 *
 * - Anything inside `{…}`, even when it wraps a literal. `plan={"Basic"}` has a
 *   string literal in it, but writing a bare replacement into that range
 *   produces `plan={Pro}`, and `SurfaceSupport` cannot tell the caller that this
 *   particular range needs JavaScript quoting.
 * - An unquoted value. `class=p-4` parses, but writing `p-4 flex` into it yields
 *   `class=p-4 flex` — a second boolean attribute, silently, and still valid
 *   markup, so no re-parse would catch it.
 * - A value assembled from more than one part.
 *
 * All three land on the frozen reason vocabulary, which has no member for
 * "present but not a writable literal": `absent` is used for "there is no range
 * here an edit may be written into", which is what the caller acts on.
 */
function attributeValueSupport(attribute: SvelteAstNode, source: string): SurfaceSupport {
  // Svelte collapses a value that is one whole expression — `class={x}`,
  // `tier={3}`, the `{plan}` shorthand — to the ExpressionTag node itself
  // rather than a one-element array, which `SvelteAstNode["value"]` does not
  // describe. Reading it as an array only would quietly report those as absent.
  const value = attribute["value"] as true | SvelteAstNode | SvelteAstNode[] | undefined;

  // `<div hidden>` / `<Card featured />`: the attribute is present and true,
  // but there is no value range to write into.
  if (value === true || value === undefined) return unsupported("absent");

  const parts = Array.isArray(value) ? value : [value];
  if (parts.length === 0) return unsupported("absent");

  if (parts.length === 1) {
    const only = parts[0]!;
    if (only.type !== "Text") return unsupported("dynamic-expression");
    const quote = source[only.start - 1];
    if ((quote !== '"' && quote !== "'") || source[only.end] !== quote) {
      return unsupported("absent");
    }
    return { support: "direct", range: { start: only.start, end: only.end } };
  }

  const hasText = parts.some((part) => part.type === "Text");
  const hasExpression = parts.some((part) => part.type === "ExpressionTag");
  if (hasText && hasExpression) return unsupported("mixed-text-and-expression");
  return unsupported("dynamic-expression");
}

/**
 * The element's text content, when it is one literal string and nothing else.
 *
 * A mixed or expression-backed body is not a text field: the rendered string
 * the user clicked may be a prop, a derived value or a translation lookup, and
 * writing the string they typed over the expression would delete the binding
 * that produced it.
 */
function textSupport(node: SvelteAstNode): SurfaceSupport {
  const children = node.fragment?.nodes ?? [];
  const hasText = children.some((child) => child.type === "Text");
  const hasExpression = children.some((child) => child.type === "ExpressionTag");

  if (!hasText && !hasExpression) return unsupported("absent");
  if (hasText && hasExpression) return unsupported("mixed-text-and-expression");

  if (children.length === 1) {
    const only = children[0]!;
    if (only.type === "Text")
      return { support: "direct", range: { start: only.start, end: only.end } };
    return unsupported("dynamic-expression");
  }

  return unsupported("multiple-children");
}

/**
 * HTML attribute names are case-insensitive, and the compiler really does emit
 * `CLASS="x"` as `class="x"`. Component props are not: `CLASS` on a component
 * is a different prop from `class`.
 */
function isClassAttribute(node: SvelteAstNode, isComponent: boolean): boolean {
  if (node.type !== "Attribute" || typeof node.name !== "string") return false;
  return isComponent ? node.name === "class" : node.name.toLowerCase() === "class";
}

/**
 * Reads everything the inspector needs to decide which controls it may offer.
 *
 * Nothing here is a judgement about whether an edit is *wise* — that needs the
 * occurrence count, which only the live document knows. This is only what the
 * source itself can support.
 */
export function describeElement(node: SvelteAstNode, source: string): ResolvedElement {
  const attributeNodes = node.attributes ?? [];
  const isComponent = COMPONENT_NODE_TYPES.has(node.type);

  const attributes = new Map<string, SurfaceSupport>();
  const props = new Map<string, SurfaceSupport>();
  const classDirectives: string[] = [];
  const classAttributes: SvelteAstNode[] = [];
  let hasSpread = false;

  for (const attribute of attributeNodes) {
    if (attribute.type === "SpreadAttribute") {
      hasSpread = true;
      continue;
    }
    if (attribute.type === "ClassDirective") {
      if (typeof attribute.name === "string") classDirectives.push(attribute.name);
      continue;
    }
    if (attribute.type !== "Attribute" || typeof attribute.name !== "string") continue;

    if (isClassAttribute(attribute, isComponent)) {
      classAttributes.push(attribute);
      if (!isComponent) continue;
    }

    const support = attributeValueSupport(attribute, source);
    if (isComponent) {
      props.set(attribute.name, support);
    } else {
      // `class` is deliberately absent from `attributes`: it has its own
      // token-level surface, and a generic string editor writing the whole
      // value would undo token-level edits planned against the same range.
      attributes.set(attribute.name, support);
    }
  }

  return {
    kind: node.type,
    tagName: typeof node.name === "string" ? node.name : node.type,
    range: { start: node.start, end: node.end },
    text: textSupport(node),
    // Two spellings of one HTML attribute (`class` and `CLASS`) are two
    // controls over the same rendered value, and a token edit to one would be
    // overwritten by the other. Refuse rather than pick.
    classes:
      classAttributes.length === 1
        ? attributeValueSupport(classAttributes[0]!, source)
        : unsupported("absent"),
    // Built through maps so an attribute literally named `__proto__` becomes an
    // own property instead of silently reassigning the record's prototype.
    attributes: Object.fromEntries(attributes),
    props: Object.fromEntries(props),
    // A literal `class` next to a `{...spread}` is still a real literal, but
    // the compiler emits both into one object in source order, so a spread that
    // appears after it wins at runtime and an edit to the literal changes
    // nothing the user can see. The caller must show the spread either way.
    hasSpread,
    classDirectives,
  };
}
