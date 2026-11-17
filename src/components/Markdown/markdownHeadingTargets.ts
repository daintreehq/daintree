import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import type { Root as HastRoot, RootContent as HastContent } from "hast";
import { markdownFragmentIds, rehypeHeadingIds } from "./headingIds";

// The rendered document's pipeline up to its ids (react-markdown builds the
// same chain around `MarkdownDocument`'s plugins), so a heading's slug and its
// `-1` come out exactly as the rendered side numbers them, footnotes included.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeHeadingIds)
  .freeze();

/**
 * The 1-based source line of the element a same-document link (`#risks`,
 * `#user-content-fn-1`) names, resolved as the rendered document resolves it,
 * or null when nothing in the source carries that id. Parses the whole
 * source, so it runs per followed link, never per keystroke.
 */
export function markdownTargetLine(source: string, href: string): number | null {
  const candidates = markdownFragmentIds(href);
  if (candidates.length === 0) return null;
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
  for (const id of candidates) {
    const line = lines.get(id);
    if (line !== undefined) return line;
  }
  return null;
}
