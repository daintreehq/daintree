import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { MarkdownBlockquote, rehypeMarkdownAlerts } from "@/components/Markdown/markdownAlerts";
import "@/components/Markdown/MarkdownDocument.css";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeMarkdownAlerts];

/** No URL survives: nothing an agent wrote can fetch, navigate or point at a file. */
const NO_URLS = () => "";

/**
 * Links show their words and images their alt text, and nothing else of
 * either: a question is an agent's words, read on the machine that owns the
 * pane, so nothing in it may reach out or act when clicked.
 */
const COMPONENTS: Components = {
  a: ({ children }) => <span className="underline decoration-dotted">{children}</span>,
  img: ({ alt }) => (alt ? <span className="text-text-secondary">[{alt}]</span> : null),
  blockquote: MarkdownBlockquote,
};

/**
 * A Decisions question's own words (#17098), as markdown formatting at most.
 * `skipHtml` with no `rehype-raw` drops any markup the agent wrote before it
 * reaches the DOM; fences stay plain text, with no highlighter or diagrams.
 */
export function DecisionMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn("markdown-document markdown-message prose min-w-0", className)}
      data-testid="decision-markdown"
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={NO_URLS}
        components={COMPONENTS}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
