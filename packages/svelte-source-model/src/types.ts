/**
 * The boundary vocabulary of the Svelte source model.
 *
 * This package deliberately owns no Daintree concepts — no project, worktree,
 * panel or plugin id. It answers two questions about one `.svelte` file:
 * "which node in this source produced that rendered element?" and "what is the
 * smallest edit that changes it?". The plugin maps these results onto its own
 * domain model; the dependency never runs the other way.
 */

/** A 1-indexed line / 0-indexed column pair, as Svelte's dev runtime reports it. */
export interface DevLocation {
  /** Path as the compiler was given it — relative to the Vite project root. */
  file: string;
  line: number;
  column: number;
}

/** A half-open range of UTF-16 offsets into the original, un-preprocessed source. */
export interface SourceRange {
  start: number;
  end: number;
}

/**
 * The structural subset of Svelte's modern AST this package relies on.
 *
 * Declared here rather than imported from `svelte/compiler` on purpose: the
 * compiler's own types move between minor releases, and every field below has
 * been stable across the Svelte 5 line. A narrower surface is also a narrower
 * blast radius when a future release changes something.
 */
export interface SvelteAstNode {
  type: string;
  start: number;
  end: number;
  name?: string;
  attributes?: SvelteAstNode[];
  value?: true | SvelteAstNode[];
  fragment?: SvelteAstNode;
  nodes?: SvelteAstNode[];
  [key: string]: unknown;
}

export interface SvelteAstRoot {
  fragment: SvelteAstNode;
  [key: string]: unknown;
}

/** `parse(source, { modern: true })`, injected so the caller owns compiler loading. */
export type SvelteParse = (
  source: string,
  options: { modern: true; filename?: string }
) => SvelteAstRoot;

/**
 * Why a rendered node could not be tied to an editable source node. These are
 * reported, never swallowed: an unsupported node is a visible, explained state
 * in the inspector, not a silently disabled control.
 */
export type ResolveFailureReason =
  | "location-out-of-range"
  | "no-element-at-location"
  /** More than one element starts at this offset; no edit may proceed. */
  | "ambiguous-location"
  | "generated-file"
  | "parse-failed";

export type ResolveResult =
  | { status: "resolved"; node: ResolvedElement }
  | { status: "failed"; reason: ResolveFailureReason; detail?: string };

/** What each editable surface of a resolved element supports, and why not. */
export type SurfaceSupport =
  | { support: "direct"; range: SourceRange }
  | { support: "unsupported"; reason: UnsupportedSurfaceReason };

export type UnsupportedSurfaceReason =
  /** No such attribute, prop or text child. */
  | "absent"
  /**
   * Present, but there is no range an edit may be written into: a bare boolean
   * attribute, or an unquoted value (`class=p-4` parses, and writing into it
   * would silently append a second attribute rather than extend the value).
   */
  | "not-a-writable-literal"
  | "dynamic-expression"
  | "mixed-text-and-expression"
  | "class-directive"
  | "spread-attribute"
  | "multiple-children"
  | "not-a-component";

export interface ResolvedElement {
  /** `RegularElement`, `Component`, `SvelteElement`. */
  kind: string;
  /** Tag as authored: `div`, `PricingCard`, `svelte:element`. */
  tagName: string;
  /** Range of the whole element, opening tag through closing tag. */
  range: SourceRange;
  /** Range of the element's single literal text child, when it has exactly one. */
  text: SurfaceSupport;
  /** Range of the `class` attribute's literal value. */
  classes: SurfaceSupport;
  /** Literal attributes by name, with the range of each value. */
  attributes: Record<string, SurfaceSupport>;
  /** Literal props by name — populated for `Component` nodes only. */
  props: Record<string, SurfaceSupport>;
  /** True when a `{...spread}` is present, which changes attribute authority. */
  hasSpread: boolean;
  /** `class:name={…}` directives present on this element, by name. */
  classDirectives: string[];
}
