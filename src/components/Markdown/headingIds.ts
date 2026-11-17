import GithubSlugger from "github-slugger";
import type { Element as HastElement, Root as HastRoot, RootContent as HastContent } from "hast";
import { hastText } from "./hastText";

/**
 * Every id the Markdown pipeline mints starts with this. It is remark-rehype's
 * default `clobberPrefix`, which already names GFM footnotes
 * (`user-content-fn-1`), and the prefix GitHub gives heading ids, so a
 * document's ids can never clash with the app's own.
 */
export const MARKDOWN_ID_PREFIX = "user-content-";

const HEADING = /^h[1-6]$/;

/**
 * Gives every heading a GitHub-compatible id, as rehype-slug does: the slug of
 * its text, with `-1`, `-2` … for repeats in document order. The slugger is
 * fresh per document, so the numbering only means something over a whole
 * document rendered in one pass.
 */
export function rehypeHeadingIds() {
  return (tree: HastRoot) => {
    const slugger = new GithubSlugger();
    const visit = (node: HastRoot | HastContent) => {
      if (node.type === "element" && HEADING.test(node.tagName)) {
        name(node, slugger);
        return;
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}

function name(heading: HastElement, slugger: GithubSlugger): void {
  // The footnote section's own label arrives with an id already.
  if (heading.properties.id !== undefined) return;
  heading.properties.id = MARKDOWN_ID_PREFIX + slugger.slug(hastText(heading.children));
}

/**
 * The ids a same-document link may point at, in the order GitHub tries them,
 * or none for a bare `#`. The decoded fragment gains the prefix first (`#risks`
 * names `user-content-risks`), then counts as written, which is how a footnote
 * link (`#user-content-fn-1`) lands. Case is kept, as GitHub keeps it. The
 * fragment is also tried undecoded: remark percent-encodes a footnote label
 * into its id, so `[^é]` is literally `user-content-fn-%C3%A9`.
 */
export function markdownFragmentIds(href: string): string[] {
  if (!href.startsWith("#")) return [];
  const raw = href.slice(1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A stray `%` is still a fragment someone meant literally.
  }
  const ids: string[] = [];
  for (const fragment of new Set([decoded, raw])) {
    if (!fragment) continue;
    ids.push(MARKDOWN_ID_PREFIX + fragment);
    if (fragment.startsWith(MARKDOWN_ID_PREFIX)) ids.push(fragment);
  }
  return ids;
}
