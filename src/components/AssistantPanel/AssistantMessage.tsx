import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Streaming-safe markdown for one assistant message.
 *
 * ## Why the memo boundary matters here
 *
 * Markdown parsing is O(n) in the accumulated text, and a streaming turn re-renders
 * on every token. Parsing the whole buffer per token is therefore O(n²) over a turn,
 * which is invisible on a two-line answer and very visible on a long one — the
 * classic streaming-chat performance failure.
 *
 * Two things keep that in check. This component is memoized on `content`, so a token
 * that lands in one message never re-parses another. And the transcript hands
 * streaming text through a frame-coalescing buffer, so the parse runs at most once
 * per animation frame rather than once per token.
 *
 * ## Why not `MarkdownDocument`
 *
 * That component resolves relative links and images against a file path and root, so
 * a rendered file's `![](./diagram.png)` loads. An assistant message has no such
 * base: its links are absolute, and giving it a fake root would let a model-authored
 * relative path resolve into the user's project. This renderer deliberately handles
 * less.
 */

export interface AssistantMessageProps {
  content: string;
  /** Renders the streaming caret. */
  streaming?: boolean;
  className?: string;
}

/**
 * A single newline is a LINE BREAK, as it was in the terminal.
 *
 * CommonMark folds a lone `\n` into a space, so a model that writes its status as
 * several one-line statements arrives as one running paragraph. The cockpit did the
 * opposite — it wrapped each source line independently, "so existing newlines
 * (paragraphs, list items) are preserved" (internal/ui/markdown/markdown.go:207) — so
 * a terminal reader saw exactly the line structure the model wrote. Collapsing it here
 * is not a neutral rendering choice; it destroys information the model sent, and it is
 * why the transcript reads as slammed together.
 *
 * Done as an mdast transform rather than by rewriting the source text, because the
 * source-level trick (two trailing spaces) would also fire inside fenced code and
 * indented blocks, where a newline is already literal. Walking the tree touches only
 * `text` nodes, and `code`/`inlineCode` carry their content as a value with no
 * children, so they are structurally out of reach.
 *
 * Written against the tree directly instead of importing `unist-util-visit`: that
 * package is present only as a transitive dependency of react-markdown, and this repo's
 * node_modules is a symlink shared with the main checkout, so declaring a new dependency
 * for twenty lines is not worth what installing it would touch.
 */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

function splitTextNodes(node: MdastNode): void {
  const children = node.children;
  if (!children) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("\n")) {
      const parts = child.value.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) next.push({ type: "break" });
        // An empty part is the gap between two adjacent newlines; the breaks around it
        // already carry it, and an empty text node would render as nothing anyway.
        if (parts[i] !== "") next.push({ type: "text", value: parts[i] });
      }
    } else {
      splitTextNodes(child);
      next.push(child);
    }
  }
  node.children = next;
}

function remarkSoftBreaks() {
  return (tree: MdastNode) => splitTextNodes(tree);
}

/**
 * Trailing-fence repair.
 *
 * A code fence arrives as ``` then a language then content — so mid-stream there is a
 * window where the opening fence has landed and the closing one has not. react-markdown
 * renders that as a fence swallowing the rest of the message, which makes the text
 * visibly lurch when the closing fence finally arrives. Closing it optimistically
 * keeps the block stable while it fills in.
 */
function balanceFences(text: string): string {
  const fences = text.match(/^```/gm);
  if (fences && fences.length % 2 === 1) return `${text}\n\`\`\``;
  return text;
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  streaming = false,
  className,
}: AssistantMessageProps) {
  const source = useMemo(() => balanceFences(content), [content]);

  return (
    <div className={cn("assistant-prose", streaming && "is-streaming", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSoftBreaks]}
        components={{
          // Links always leave the app, so they always get the affordances of doing
          // so. `noreferrer` matters because the target is model-authored.
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-link underline decoration-text-link/40 underline-offset-2 hover:decoration-text-link"
            >
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
      {/* The caret is drawn as an ::after on the last block of prose (see the CSS), so
          it sits at the end of the final line rather than alone beneath it — as a
          sibling element it read as an empty paragraph and cost a line of vertical
          space on every streaming turn.
          
          This anchor exists ONLY for the pre-first-token case, where there is no block
          for the caret to attach to. Rendering it unconditionally would make it the
          last child and reintroduce exactly the layout it was meant to fix. */}
      {streaming && content.length === 0 && (
        <span aria-hidden="true" className="assistant-caret-anchor" />
      )}
    </div>
  );
});
