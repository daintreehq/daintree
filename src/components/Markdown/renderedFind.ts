/**
 * Text search over a rendered document's DOM, for find in rendered Markdown.
 *
 * Matches are `Range`s painted through the CSS Custom Highlight API rather than
 * `<mark>` wrappers: the document is a React-owned tree, and wrapping its text
 * nodes would hand React markup it never rendered.
 */

/** Past this many matches the count reads "1000+" and stepping stops there. */
export const RENDERED_FIND_MATCH_LIMIT = 1000;

/** Highlight names; `MarkdownDocument.css` paints them. */
export const FIND_MATCH_HIGHLIGHT = "daintree-find-match";
export const FIND_CURRENT_HIGHLIGHT = "daintree-find-current";

/**
 * Text the reader cannot see or does not read as the document: SVG internals
 * (diagrams), controls, and screen-reader-only labels.
 */
const SKIP_SELECTOR = "svg, button, script, style, [hidden], [aria-hidden='true'], .sr-only";

/**
 * The boxes a match may not run across. Without a boundary between them, the
 * end of one paragraph and the start of the next would read as one line.
 */
const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote, dt, dd, figcaption, caption";

/** Joins blocks in the searched text; never part of a pattern, so never matched. */
const BLOCK_BREAK = "\u0000";

interface TextIndex {
  text: string;
  nodes: Text[];
  /** Offset of each node's first character in `text`. */
  starts: number[];
}

function indexText(root: Element): TextIndex {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element) {
        return node.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const nodes: Text[] = [];
  const starts: number[] = [];
  let block: Element | null | undefined;
  for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
    if (!(textNode instanceof Text) || textNode.data.length === 0) continue;
    const nodeBlock = textNode.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    if (block !== undefined && nodeBlock !== block) text += BLOCK_BREAK;
    block = nodeBlock;
    nodes.push(textNode);
    starts.push(text.length);
    text += textNode.data;
  }
  return { text, nodes, starts };
}

/**
 * The query as a pattern: literal text, except that any run of whitespace
 * matches any run of whitespace, so a phrase finds the same words across a
 * soft line break in the source.
 */
export function buildFindPattern(query: string, matchCase: boolean): RegExp | null {
  if (query.trim().length === 0) return null;
  const source = query
    .split(/(\s+)/)
    .filter((part) => part.length > 0)
    .map((part) => (/^\s+$/.test(part) ? "\\s+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(source, matchCase ? "gu" : "giu");
}

/** The last index in `starts` at or before `offset`. */
function nodeAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface FindResult {
  ranges: Range[];
  /** More matches exist than `ranges` holds. */
  capped: boolean;
}

const EMPTY_RESULT: FindResult = { ranges: [], capped: false };

export function findInRenderedText(
  root: Element,
  query: string,
  matchCase: boolean,
  limit = RENDERED_FIND_MATCH_LIMIT
): FindResult {
  const pattern = buildFindPattern(query, matchCase);
  if (!pattern) return EMPTY_RESULT;
  const { text, nodes, starts } = indexText(root);
  if (nodes.length === 0) return EMPTY_RESULT;
  const doc = root.ownerDocument;
  const ranges: Range[] = [];
  let capped = false;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    if (ranges.length === limit) {
      capped = true;
      break;
    }
    const start = match.index;
    const end = start + match[0].length;
    const startNode = nodeAt(starts, start);
    const endNode = nodeAt(starts, end - 1);
    const range = doc.createRange();
    range.setStart(nodes[startNode]!, start - starts[startNode]!);
    range.setEnd(nodes[endNode]!, end - starts[endNode]!);
    ranges.push(range);
  }
  return { ranges, capped };
}

/**
 * The text a selection can seed the query with: a short, single-line selection
 * inside `root`. Anything longer was selected for some other reason.
 */
export function selectionSeed(root: Element): string | null {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const anchor = selection.anchorNode;
  if (!anchor || !root.contains(anchor)) return null;
  const text = selection.toString().trim();
  if (text.length === 0 || text.length > 100 || /[\r\n]/.test(text)) return null;
  return text;
}

function sharedHighlight(name: string, priority: number): Highlight | null {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight !== "function") return null;
  const existing = CSS.highlights.get(name);
  if (existing) return existing;
  const created = new Highlight();
  created.priority = priority;
  CSS.highlights.set(name, created);
  return created;
}

export const FORCED_COLORS_QUERY = "(forced-colors: active)";

/**
 * Under forced colours Chromium paints every custom highlight in the system
 * Highlight pair, whatever colours it asks for, so the current match and the
 * rest would be one indistinguishable purple. There the current match is the
 * only one painted: the count still says how many there are.
 */
function forcedColors(): boolean {
  return typeof matchMedia === "function" && matchMedia(FORCED_COLORS_QUERY).matches;
}

/**
 * One find bar's share of the two document-wide highlights. Several documents
 * can have a find open at once (a file panel beside the file browser), so each
 * adds and removes only its own ranges.
 */
export function createFindPainter() {
  let painted: Range[] = [];
  let paintedCurrent: Range | null = null;
  return {
    paint(ranges: Range[], current: Range | null) {
      const matches = sharedHighlight(FIND_MATCH_HIGHLIGHT, 0);
      const active = sharedHighlight(FIND_CURRENT_HIGHLIGHT, 1);
      if (!matches || !active) return;
      for (const range of painted) matches.delete(range);
      if (paintedCurrent) active.delete(paintedCurrent);
      painted = forcedColors() ? [] : ranges.filter((range) => range !== current);
      for (const range of painted) matches.add(range);
      paintedCurrent = current;
      if (current) active.add(current);
    },
    clear() {
      this.paint([], null);
    },
  };
}

export type FindPainter = ReturnType<typeof createFindPainter>;

function isScrollable(element: Element, axis: "x" | "y"): boolean {
  const style = getComputedStyle(element);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  return axis === "y"
    ? element.scrollHeight > element.clientHeight
    : element.scrollWidth > element.clientWidth;
}

/**
 * Brings a match into view in every scroller between it and the pane: a wide
 * table or code block scrolls sideways, a tall block inside the document
 * scrolls itself, and the pane scrolls last. A match already comfortably in
 * view stays put; one that is not lands in the middle of what the find bar
 * leaves visible (`topInset` is the bar's depth, which only the pane has).
 */
export function scrollRangeIntoView(range: Range, root: Element, topInset = 0): void {
  if (typeof range.getBoundingClientRect !== "function") return;
  let element: Element | null =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  while (element) {
    const isPane = element.contains(root);
    if (isScrollable(element, "x")) {
      const box = element.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      if (rect.left < box.left || rect.right > box.right) {
        element.scrollLeft += rect.left - box.left - box.width / 2 + rect.width / 2;
      }
    }
    if (isScrollable(element, "y")) {
      const box = element.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      const inset = isPane ? topInset : 0;
      const margin = 16;
      if (rect.top < box.top + inset + margin || rect.bottom > box.bottom - margin) {
        const visibleMiddle = (box.top + inset + box.bottom) / 2;
        element.scrollTop += rect.top + rect.height / 2 - visibleMiddle;
      }
      // The pane is the last scroller that matters: the panel and the window
      // around it don't scroll.
      if (isPane) return;
    }
    element = element.parentElement;
  }
}

/** The scroller the document scrolls in: its nearest vertically scrolling ancestor. */
function paneScroller(root: Element): Element | null {
  let element: Element | null = root;
  while (element && !isScrollable(element, "y")) element = element.parentElement;
  return element;
}

/**
 * The first match below the find bar in the visible part of the document, so
 * a search starts where the reader is rather than back at the top.
 */
export function firstVisibleMatch(ranges: Range[], root: Element, topInset = 0): number {
  if (ranges.length === 0) return -1;
  const scroller = paneScroller(root);
  if (!scroller || typeof ranges[0]!.getBoundingClientRect !== "function") return 0;
  const top = scroller.getBoundingClientRect().top + topInset;
  const index = ranges.findIndex((range) => range.getBoundingClientRect().top >= top);
  return index === -1 ? 0 : index;
}

/**
 * Where a refreshed search should stand, given the match that was current
 * before the document changed. Ranges are live, so one whose text survived
 * the change still marks the same words: the match starting at or after it
 * keeps the reader's place. One whose text was replaced has collapsed, and
 * then there is no place to keep.
 */
export function matchAfter(previous: Range | undefined, ranges: Range[]): number {
  if (!previous || previous.collapsed || !previous.startContainer.isConnected) return -1;
  const index = ranges.findIndex(
    (range) => range.compareBoundaryPoints(Range.START_TO_START, previous) >= 0
  );
  return index === -1 ? ranges.length - 1 : index;
}
