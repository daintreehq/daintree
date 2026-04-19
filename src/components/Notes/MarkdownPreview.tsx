import { forwardRef, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  /** Absolute path to the notes directory for this project — used to serve attachment URLs via daintree-file://. */
  notesDir?: string | null;
}

const ATTACHMENT_PREFIX = "attachments/";

function buildUrlTransform(notesDir: string | null | undefined): (url: string) => string {
  return (url: string) => {
    if (url && notesDir && url.startsWith(ATTACHMENT_PREFIX)) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        return defaultUrlTransform(url);
      }
      // Reject any traversal segment — raw or percent-encoded — after decode.
      if (decoded.includes("..") || decoded.includes("\0")) {
        return defaultUrlTransform(url);
      }
      const sep = notesDir.endsWith("/") || notesDir.endsWith("\\") ? "" : "/";
      const absolutePath = `${notesDir}${sep}${decoded}`;
      return `daintree-file://daintree/?path=${encodeURIComponent(absolutePath)}&root=${encodeURIComponent(notesDir)}`;
    }
    return defaultUrlTransform(url);
  };
}

export const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  ({ content, className, notesDir }, ref) => {
    const urlTransform = useMemo(() => buildUrlTransform(notesDir), [notesDir]);

    return (
      <div
        ref={ref}
        className={cn(
          "prose prose-sm prose-daintree max-w-none p-4 overflow-auto h-full",
          className
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: true }]]}
          urlTransform={urlTransform}
          components={{
            a({ href, children }) {
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    if (!href) return;
                    if (/^https?:\/\/|^mailto:/i.test(href)) {
                      window.electron.system.openExternal(href);
                      return;
                    }
                    if (href.startsWith("daintree-file://")) {
                      try {
                        const parsed = new URL(href);
                        const filePath = parsed.searchParams.get("path");
                        if (filePath) {
                          window.electron.system.openPath(filePath);
                        }
                      } catch {
                        // Ignore malformed daintree-file URLs
                      }
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
