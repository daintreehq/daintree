import { forwardRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

export const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  ({ content, className }, ref) => {
    return (
      <div
        ref={ref}
        className={cn("prose prose-sm prose-canopy max-w-none p-4 overflow-auto h-full", className)}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: true }]]}
          components={{
            a({ href, children }) {
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    if (href && /^https?:\/\/|^mailto:/i.test(href)) {
                      window.electron.system.openExternal(href);
                    }
                  }}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }
);
