import type { Paragraph, Root, RootContent } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

declare module "mdast" {
  /** TOML front matter, as `mdast-util-frontmatter` builds it; mdast only types YAML. */
  interface Toml extends Literal {
    type: "toml";
  }

  interface FrontmatterContentMap {
    toml: Toml;
  }
}

/** Class of the rendered front matter block, styled in `MarkdownDocument.css`. */
export const MARKDOWN_FRONTMATTER_CLASS = "markdown-frontmatter";

export type FrontmatterNode = Extract<RootContent, { type: "yaml" | "toml" }>;

export function isFrontmatterType(type: string): type is FrontmatterNode["type"] {
  return type === "yaml" || type === "toml";
}

export function isFrontmatterNode(node: RootContent): node is FrontmatterNode {
  return isFrontmatterType(node.type);
}

/**
 * `mdast-util-to-hast` maps front matter to nothing, so without this the block
 * would vanish from the rendered document. It becomes a div of the raw lines
 * instead, never parsed or interpreted. Not a `<pre>`: the rendered diff never
 * marks words inside one, and a changed value should be marked on its own. The
 * value goes in as hast text because an mdast text node would have its lines'
 * leading whitespace trimmed, which is YAML's nesting.
 */
function remarkFrontmatterBlock() {
  return (tree: Root) => {
    const first = tree.children[0];
    if (!first || !isFrontmatterNode(first)) return;
    if (!first.value.trim()) {
      tree.children.shift();
      return;
    }
    const block: Paragraph = {
      type: "paragraph",
      children: [],
      position: first.position,
      data: {
        hName: "div",
        hProperties: { className: [MARKDOWN_FRONTMATTER_CLASS], dataFrontmatter: first.type },
        hChildren: [{ type: "text", value: first.value }],
      },
    };
    tree.children[0] = block;
  };
}

/**
 * The remark plugins every pipeline that reads a Markdown file as a document
 * shares: the rendered document, the rendered diff's splitter and its block
 * renderer, and the heading-target resolver. Sharing one list is what keeps
 * them agreeing on where a block starts, so a front matter block can't be a
 * rule and a heading to one and metadata to another.
 */
export const MARKDOWN_REMARK_PLUGINS: PluggableList = [
  [remarkFrontmatter, ["yaml", "toml"]],
  remarkGfm,
  remarkFrontmatterBlock,
];
