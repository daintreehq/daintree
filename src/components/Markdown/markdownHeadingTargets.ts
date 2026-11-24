import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import type { Root as HastRoot, RootContent as HastContent } from "hast";
import { markdownFragmentIds, rehypeHeadingIds } from "./headingIds";
import { MARKDOWN_REMARK_PLUGINS } from "./markdownRemarkPlugins";

// The rendered document's pipeline up to its ids (react-markdown builds the
// same chain around `MarkdownDocument`'s plugins), so a heading's slug and its
// `-1` come out exactly as the rendered side numbers them, footnotes included.
const processor = unified()
  .use(remarkParse)
  .use(MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeHeadingIds)
  .freeze();

/** Where a source's same-document links land: one parse, any number of lookups. */
export interface MarkdownTargets {
  /**
   * The 1-based source line of the element a same-document link (`#risks`,
   * `#user-content-fn-1`) names, resolved as the rendered document resolves
   * it, or null when nothing in the source carries that id.
   */
  lineOf(href: string): number | null;
}

/**
 * Parses the whole source once and maps every id the rendered document would
 * carry to its source line. A pure function of the text, so a caller holding
 * an immutable document can keep the result for as long as that document.
 */
export function markdownTargets(source: string): MarkdownTargets {
  const tree = processor.runSync(processor.parse(source)) as HastRoot;
  const lines = new Map<string, number>();
  const visit = (node: HastRoot | HastContent, line: number | undefined) => {
    // Generated nodes (a footnote's back-link) stand on their parent's line.
    const own = node.type === "root" ? undefined : (node.position?.start.line ?? line);
    if (node.type === "element") {
      const { id } = node.properties;
      if (typeof id === "string" && own !== undefined && !lines.has(id)) lines.set(id, own);
    }
    if ("children" in node) for (const child of node.children) visit(child, own);
  };
  visit(tree, undefined);
  return {
    lineOf(href) {
      for (const id of markdownFragmentIds(href)) {
        const line = lines.get(id);
        if (line !== undefined) return line;
      }
      return null;
    },
  };
}

/**
 * {@link MarkdownTargets.lineOf} for a single link. Parses the whole source,
 * so a caller that follows more than one link keeps {@link markdownTargets}.
 */
export function markdownTargetLine(source: string, href: string): number | null {
  if (markdownFragmentIds(href).length === 0) return null;
  return markdownTargets(source).lineOf(href);
}
