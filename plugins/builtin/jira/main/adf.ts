/**
 * Atlassian Document Format to readable text. Issue bodies from the other
 * providers are Markdown, so structure comes out in the same shape (list
 * markers, fences, `[text](url)`), which also reads fine unrendered. Unknown
 * node types are expected as Atlassian adds them: they keep their text rather
 * than fail the issue.
 */

interface AdfNode {
  type?: unknown;
  text?: unknown;
  attrs?: unknown;
  marks?: unknown;
  content?: unknown;
}

/** Deeper than any real document; bounds the recursion against a malformed one. */
const MAX_DEPTH = 64;

const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "mention",
  "emoji",
  "inlineCard",
  "status",
  "date",
  "mediaInline",
]);

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList", "decisionList"]);

function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null;
}

function childrenOf(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function attrOf(node: AdfNode, name: string): string {
  if (!isNode(node.attrs)) return "";
  const value = (node.attrs as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

function withMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks)) return text;
  let result = text;
  if (marks.some((mark) => isNode(mark) && mark.type === "code")) result = `\`${result}\``;
  const link = marks.find((mark) => isNode(mark) && mark.type === "link") as AdfNode | undefined;
  const href = link ? attrOf(link, "href") : "";
  if (href) result = href === text ? href : `[${result}](${href})`;
  return result;
}

function renderChildren(node: AdfNode, depth: number, separator = "\n\n"): string {
  const parts: string[] = [];
  let inlineRun = "";
  for (const child of childrenOf(node)) {
    const rendered = renderNode(child, depth + 1);
    if (typeof child.type === "string" && INLINE_TYPES.has(child.type)) {
      inlineRun += rendered;
      continue;
    }
    if (inlineRun) parts.push(inlineRun);
    inlineRun = "";
    if (rendered) parts.push(rendered);
  }
  if (inlineRun) parts.push(inlineRun);
  return parts.join(separator);
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, index) => `${index === 0 ? first : rest}${line}`)
    .join("\n");
}

/** One list's items, tight, with continuation lines hanging under the marker. */
function renderList(
  node: AdfNode,
  depth: number,
  markerFor: (item: AdfNode, index: number) => string
): string {
  return childrenOf(node)
    .map((item, index) => {
      // A task list nests its sublists directly, with no item of their own.
      if (typeof item.type === "string" && LIST_TYPES.has(item.type)) {
        return prefixLines(renderNode(item, depth + 1), "  ", "  ");
      }
      const marker = markerFor(item, index);
      return prefixLines(renderChildren(item, depth + 1, "\n"), marker, " ".repeat(marker.length));
    })
    .join("\n");
}

function renderTable(node: AdfNode, depth: number): string {
  return childrenOf(node)
    .map((row) =>
      childrenOf(row)
        .map((cell) => renderChildren(cell, depth + 2, " ").replace(/\s*\n\s*/g, " "))
        .join(" | ")
    )
    .join("\n");
}

function renderDate(node: AdfNode): string {
  const timestamp = attrOf(node, "timestamp");
  if (!timestamp) return "";
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function renderNode(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? withMarks(node.text, node.marks) : "";
    case "hardBreak":
      return "\n";
    case "mention":
      return attrOf(node, "text") || "@unknown";
    case "emoji":
      return attrOf(node, "text") || attrOf(node, "shortName");
    case "status":
      return attrOf(node, "text");
    case "date":
      return renderDate(node);
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return attrOf(node, "url");
    case "media":
    case "mediaInline": {
      const alt = attrOf(node, "alt");
      return alt ? `[attachment: ${alt}]` : "[attachment]";
    }
    case "rule":
      return "---";
    case "heading": {
      const level = isNode(node.attrs) ? (node.attrs as { level?: unknown }).level : undefined;
      const hashes = "#".repeat(typeof level === "number" ? Math.min(Math.max(level, 1), 6) : 1);
      return `${hashes} ${renderChildren(node, depth)}`;
    }
    case "codeBlock":
      return `\`\`\`${attrOf(node, "language")}\n${renderChildren(node, depth)}\n\`\`\``;
    case "blockquote":
      return prefixLines(renderChildren(node, depth), "> ", "> ");
    case "bulletList":
      return renderList(node, depth, () => "- ");
    case "orderedList": {
      const order = isNode(node.attrs) ? (node.attrs as { order?: unknown }).order : undefined;
      const start = typeof order === "number" ? order : 1;
      return renderList(node, depth, (_item, index) => `${start + index}. `);
    }
    case "taskList":
      return renderList(node, depth, (item) =>
        attrOf(item, "state") === "DONE" ? "- [x] " : "- [ ] "
      );
    case "decisionList":
      return renderList(node, depth, () => "- ");
    case "table":
      return renderTable(node, depth);
    case "expand":
    case "nestedExpand":
      return [attrOf(node, "title"), renderChildren(node, depth)].filter(Boolean).join("\n\n");
    default:
      // A leaf of an unknown type keeps whatever text it carries.
      if (childrenOf(node).length > 0) return renderChildren(node, depth);
      return typeof node.text === "string" ? node.text : attrOf(node, "text");
  }
}

/** A description as text: `null` for an empty one is `""`, and a plain string passes through. */
export function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isNode(value)) return "";
  return renderNode(value, 0).trim();
}
