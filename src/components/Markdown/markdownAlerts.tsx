import type { ComponentProps } from "react";
import type { Element, ElementContent, Root, Text } from "hast";
import type { ExtraProps } from "react-markdown";
import {
  Info,
  Lightbulb,
  MessageSquareExclamationPoint,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

/**
 * GitHub's alert types, each with GitHub's own title and the Lucide glyph
 * nearest GitHub's octicon. An alert's colours and glyph belong to the author's
 * markup rather than to anything Daintree is reporting, so TIP's glyph is the
 * light bulb GitHub draws, not the severity check mark that says something
 * finished. The tone each type paints with lives in `MarkdownDocument.css`.
 */
const MARKDOWN_ALERTS = {
  note: { title: "Note", Icon: Info },
  tip: { title: "Tip", Icon: Lightbulb },
  important: { title: "Important", Icon: MessageSquareExclamationPoint },
  warning: { title: "Warning", Icon: TriangleAlert },
  caution: { title: "Caution", Icon: OctagonAlert },
} satisfies Record<string, { title: string; Icon: LucideIcon }>;

export type MarkdownAlertType = keyof typeof MARKDOWN_ALERTS;

function isMarkdownAlertType(value: unknown): value is MarkdownAlertType {
  return typeof value === "string" && Object.hasOwn(MARKDOWN_ALERTS, value);
}

/** The marker, ending its line: GitHub takes no title or text after it. */
const MARKER = /^\[!([a-z]+)\][ \t]*(\n|$)/i;

export interface MarkdownAlertOptions {
  /**
   * An element the marker may run through, whose own text nodes are the
   * document's text and whose other children are not: the rendered diff's
   * revision marks, which wrap a changed word and carry a screen-reader label.
   */
  isRevisionMark?: (element: Element) => boolean;
}

/** A piece of the paragraph's leading run: a text node, or the `<br>` ending a line. */
type Leaf =
  | { kind: "text"; node: Text; parent: Element }
  | { kind: "break"; node: Element; parent: Element };

function isWhitespaceText(node: ElementContent): boolean {
  return node.type === "text" && !/\S/.test(node.value);
}

/**
 * The paragraph's text up to its first element that isn't a line break or a
 * revision mark. `blocked` says such an element ended it, rather than the
 * paragraph itself ending.
 */
function leadingRun(
  paragraph: Element,
  isRevisionMark: MarkdownAlertOptions["isRevisionMark"]
): { leaves: Leaf[]; text: string; blocked: boolean } {
  const leaves: Leaf[] = [];
  let text = "";
  for (const child of paragraph.children) {
    if (child.type === "text") {
      leaves.push({ kind: "text", node: child, parent: paragraph });
      text += child.value;
    } else if (child.type === "element" && child.tagName === "br") {
      leaves.push({ kind: "break", node: child, parent: paragraph });
      text += "\n";
    } else if (child.type === "element" && isRevisionMark?.(child)) {
      for (const inner of child.children) {
        if (inner.type !== "text") continue;
        leaves.push({ kind: "text", node: inner, parent: child });
        text += inner.value;
      }
    } else if (child.type === "element") {
      return { leaves, text, blocked: true };
    }
  }
  return { leaves, text, blocked: false };
}

function removeChild(parent: Element, child: ElementContent): void {
  const index = parent.children.indexOf(child);
  if (index !== -1) parent.children.splice(index, 1);
}

/** Takes the first `count` characters of the run out of the tree. */
function consume(leaves: Leaf[], count: number): void {
  let remaining = count;
  for (const leaf of leaves) {
    if (remaining <= 0) return;
    if (leaf.kind === "break") {
      removeChild(leaf.parent, leaf.node);
      remaining -= 1;
      continue;
    }
    if (leaf.node.value.length <= remaining) {
      remaining -= leaf.node.value.length;
      removeChild(leaf.parent, leaf.node);
    } else {
      leaf.node.value = leaf.node.value.slice(remaining);
      remaining = 0;
    }
  }
}

/**
 * Turns a top-level blockquote that opens with a GitHub alert marker
 * (`> [!WARNING]`) into an alert: the marker comes out of the tree and the
 * blockquote is flagged with its type for `MarkdownBlockquote` to draw.
 *
 * GitHub's rules, as rehype-github's emulation of github.com states them: only
 * a blockquote at the top of the document; its first paragraph must start with
 * the marker, whose type is matched in any case; the marker must end its line,
 * by a line ending or a hard break; and a marker with nothing after it in the
 * blockquote stays as written. An unknown type stays as written too.
 *
 * Runs on hast, after every other rehype plugin, rather than on mdast: the
 * rendered diff marks changed words only when the rendered text matches its
 * engine's flattening of the source, which keeps the marker, so the marker has
 * to survive until the marks are in. A changed marker can therefore arrive
 * split across revision marks, which `isRevisionMark` lets the match see
 * through; a mark left with no text of its own goes with the marker.
 */
export function rehypeMarkdownAlerts(options: MarkdownAlertOptions = {}) {
  const { isRevisionMark } = options;
  return (tree: Root) => {
    for (const block of tree.children) {
      if (block.type !== "element" || block.tagName !== "blockquote") continue;
      const contentIndex = block.children.findIndex((child) => !isWhitespaceText(child));
      const paragraph = block.children[contentIndex];
      if (paragraph?.type !== "element" || paragraph.tagName !== "p") continue;

      const run = leadingRun(paragraph, isRevisionMark);
      const match = MARKER.exec(run.text);
      const type = match?.[1]?.toLowerCase();
      if (!match || !isMarkdownAlertType(type)) continue;

      // Something other than text right after the marker shares its line.
      if (match[2] === "" && run.blocked) continue;
      const isWholeParagraph = !run.blocked && !/\S/.test(run.text.slice(match[0].length));
      if (
        isWholeParagraph &&
        !block.children.slice(contentIndex + 1).some((child) => !isWhitespaceText(child))
      ) {
        continue;
      }

      consume(run.leaves, match[0].length);
      // A hard break is followed by the line ending mdast-util-to-hast writes
      // after it, which would otherwise open the body.
      const first = paragraph.children[0];
      if (first?.type === "text") {
        first.value = first.value.replace(/^\n/, "");
        if (!first.value) paragraph.children.shift();
      }
      if (isRevisionMark) {
        paragraph.children = paragraph.children.filter(
          (child) =>
            child.type !== "element" ||
            !isRevisionMark(child) ||
            child.children.some((inner) => inner.type === "text" && inner.value)
        );
      }
      if (paragraph.children.every(isWhitespaceText)) removeChild(block, paragraph);

      block.properties = { ...block.properties, dataMarkdownAlert: type };
    }
  };
}

/**
 * The `blockquote` every Markdown pipeline renders: a plain quote, or for one
 * `rehypeMarkdownAlerts` flagged, GitHub's titled box. A `div` rather than a
 * blockquote, as on GitHub, so the typography plugin's quote marks, italics
 * and rule stay off it.
 */
export function MarkdownBlockquote({
  node,
  children,
  ...props
}: ComponentProps<"blockquote"> & ExtraProps) {
  const type = node?.properties.dataMarkdownAlert;
  if (!isMarkdownAlertType(type)) return <blockquote {...props}>{children}</blockquote>;
  const { title, Icon } = MARKDOWN_ALERTS[type];
  return (
    <div className="markdown-alert" data-markdown-alert={type}>
      <p className="markdown-alert-title">
        <Icon className="markdown-alert-glyph" aria-hidden="true" />
        {title}
      </p>
      {children}
    </div>
  );
}
