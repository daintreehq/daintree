import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import type { ExtraProps } from "react-markdown";
import type { Element as HastElement, Root as HastRoot, RootContent as HastContent } from "hast";
import { useHorizontalScrollControls } from "@/hooks/useHorizontalScrollControls";
import { pluralize } from "@/lib/pluralize";
import { hastText } from "./hastText";

/**
 * GFM tables, each in its own horizontal scroller.
 *
 * A technical table routinely needs more width than a split pane has, and a
 * table never lays out narrower than its min-content. Unwrapped, that width
 * became the document's: the pane scrolled sideways and took every paragraph
 * with it, while auto layout held the prose column to its longest word. Here
 * only the table moves, and a table that cannot fit switches to a layout that
 * reads well when it scrolls (see `MarkdownDocument.css`).
 */

/**
 * Qualifies a table's region name where the same table can appear twice — the
 * removed and added halves of a rendered diff — so the two tab stops are not
 * announced identically.
 */
export const MarkdownTableLabelPrefix = createContext<string | undefined>(undefined);

/** Below this many characters of prose a cell reads fine at its natural width. */
const PROSE_CELL_CHARS = 24;
const NAMED_COLUMNS = 3;

const isCode = (element: HastElement) => element.tagName === "code";

/**
 * Records the nearest preceding heading on each table, so an overflowing table
 * can be named after its section. A rehype plugin because a table component
 * only ever sees its own subtree.
 */
export function rehypeTableHeadings() {
  return (tree: HastRoot) => {
    let heading = "";
    const visit = (node: HastRoot | HastContent) => {
      if (node.type === "element") {
        if (/^h[1-6]$/.test(node.tagName)) {
          heading = hastText(node.children).trim();
          return;
        }
        if (node.tagName === "table") {
          if (heading) node.properties.dataTableHeading = heading;
          return;
        }
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}

function headerTexts(table: HastElement | undefined): string[] {
  const texts: string[] = [];
  const visit = (node: HastContent) => {
    if (node.type !== "element") return;
    if (node.tagName === "th") {
      const text = hastText(node.children).trim();
      if (text) texts.push(text);
      return;
    }
    if (node.tagName === "tbody") return;
    node.children.forEach(visit);
  };
  table?.children.forEach(visit);
  return texts;
}

function tableLabel(table: HastElement | undefined, prefix: string | undefined): string {
  const heading = table?.properties.dataTableHeading;
  const subject = prefix ? `${prefix} table` : "Table";
  if (typeof heading === "string" && heading) return `${prefix ? `${prefix}: ` : ""}${heading}`;
  const columns = headerTexts(table);
  if (columns.length === 0) return subject;
  const named = columns.slice(0, NAMED_COLUMNS).join(", ");
  const rest = columns.length - NAMED_COLUMNS;
  return rest > 0
    ? `${subject}: ${named} and ${pluralize(rest, "more column")}`
    : `${subject}: ${named}`;
}

/**
 * Whether the table overflows as it lays out WITHOUT the wide treatment. The
 * widened table always overflows, so measuring it instead would latch the
 * treatment on after the pane grew wide enough for the plain table to fit.
 * The attribute comes off for one synchronous layout read and goes straight
 * back, so nothing paints in between; the scroll offset is put back too, since
 * the plain layout's shorter range would otherwise clamp it.
 *
 * Re-measured on resize and on any change to the table's content: an edit can
 * shorten the token that set a column's minimum without changing the widened
 * table's size at all, and nothing would resize to say so.
 */
function useWideLayout(
  frameRef: RefObject<HTMLDivElement | null>,
  viewportRef: RefObject<HTMLDivElement | null>
): boolean {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    const viewport = viewportRef.current;
    const table = viewport?.firstElementChild;
    if (!frame || !viewport || !table) return;

    let pending: number | null = null;
    const measure = () => {
      pending = null;
      const current = frame.dataset.wide;
      if (current === undefined) {
        setWide(viewport.scrollWidth > viewport.clientWidth + 1);
        return;
      }
      const scrollLeft = viewport.scrollLeft;
      delete frame.dataset.wide;
      const overflows = viewport.scrollWidth > viewport.clientWidth + 1;
      frame.dataset.wide = current;
      viewport.scrollLeft = scrollLeft;
      setWide(overflows);
    };
    const schedule = () => {
      if (pending === null) pending = requestAnimationFrame(measure);
    };

    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    resize.observe(table);
    const edits = new MutationObserver(schedule);
    edits.observe(table, { childList: true, subtree: true, characterData: true });
    return () => {
      if (pending !== null) cancelAnimationFrame(pending);
      resize.disconnect();
      edits.disconnect();
    };
  }, [frameRef, viewportRef]);

  return wide;
}

/**
 * The table, its scroll viewport, and the frame that carries the layout mode
 * and edge state for the stylesheet.
 *
 * The viewport is a tab stop and a named region only while it actually
 * overflows: a keyboard user needs a way to reach clipped columns (WCAG 2.1.1),
 * and a table that fits would just be a dead stop. Chromium's own
 * keyboard-focusable scrollers do not cover a table with a link in it.
 */
export function MarkdownTable({ node, children, ...props }: ComponentProps<"table"> & ExtraProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const prefix = useContext(MarkdownTableLabelPrefix);
  const wide = useWideLayout(frameRef, viewportRef);
  const { isOverflowing, canScrollLeft, canScrollRight } = useHorizontalScrollControls(viewportRef);
  // The heading travels on the hast node only; it is not a table attribute.
  const { "data-table-heading": _heading, ...tableProps } = props as typeof props & {
    "data-table-heading"?: unknown;
  };

  return (
    <div
      ref={frameRef}
      className="markdown-table"
      data-wide={wide || undefined}
      data-overflowing={isOverflowing || undefined}
      data-scroll-start={canScrollLeft || undefined}
      data-scroll-end={canScrollRight || undefined}
    >
      <div
        ref={viewportRef}
        className="markdown-table__viewport"
        role={isOverflowing ? "region" : undefined}
        aria-label={isOverflowing ? tableLabel(node, prefix) : undefined}
        tabIndex={isOverflowing ? 0 : undefined}
      >
        <table {...tableProps}>{children}</table>
      </div>
    </div>
  );
}

/**
 * Cells get an inner block for the wide layout to cap. A `max-width` on the
 * cell itself would clamp its min-content too, and a long code string would
 * then spill out of its cell instead of widening the column.
 */
function cellProps(node: HastElement | undefined) {
  // A prose cell keeps a readable floor even when the table fits, so a column
  // of sentences is never squeezed to its longest word. Code never wraps, so it
  // does not count towards the measure.
  const prose = (node ? hastText(node.children, isCode).trim().length : 0) >= PROSE_CELL_CHARS;
  return { "data-prose": prose || undefined };
}

export function MarkdownTableHeaderCell({
  node,
  children,
  ...props
}: ComponentProps<"th"> & ExtraProps) {
  return (
    <th {...props} {...cellProps(node)}>
      <div className="markdown-table__cell">{children}</div>
    </th>
  );
}

export function MarkdownTableCell({ node, children, ...props }: ComponentProps<"td"> & ExtraProps) {
  return (
    <td {...props} {...cellProps(node)}>
      <div className="markdown-table__cell">{children}</div>
    </td>
  );
}
