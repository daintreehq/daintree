import { useMemo, useState, useCallback, useEffect, type ReactElement } from "react";
import { refractor } from "refractor";
import type { Element, Text, RootContent } from "hast";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  cpp: "cpp",
  c: "c",
  go: "go",
  java: "java",
  swift: "swift",
  php: "php",
  sql: "sql",
  html: "markup",
  xml: "markup",
  css: "css",
  scss: "scss",
  json: "json",
  toml: "toml",
  dockerfile: "docker",
  graphql: "graphql",
};

function resolveLanguage(lang: string): string {
  const normalized = lang.toLowerCase().trim();
  return LANGUAGE_ALIASES[normalized] || normalized || "text";
}

function highlightCode(code: string, language: string): string {
  const resolvedLang = resolveLanguage(language);

  try {
    const highlighted = refractor.highlight(code, resolvedLang);
    return toHtml(highlighted.children);
  } catch {
    return escapeHtml(code);
  }
}

function toHtml(nodes: RootContent[]): string {
  return nodes
    .map((node: RootContent) => {
      if (node.type === "text") {
        return escapeHtml((node as Text).value);
      }
      if (node.type === "element") {
        const el = node as Element;
        const classNameProp = el.properties?.className;
        const className =
          typeof classNameProp === "string"
            ? classNameProp
            : Array.isArray(classNameProp)
              ? classNameProp.join(" ")
              : "";
        const children = toHtml(el.children as RootContent[]);
        return `<span class="${className}">${children}</span>`;
      }
      return "";
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface ParsedBlock {
  type: "text" | "code";
  content: string;
  language?: string;
}

function parseMarkdown(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const codeBlockRegex = /```([^\n]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({
        type: "text",
        content: content.slice(lastIndex, match.index),
      });
    }

    const languageInfo = match[1].trim();
    const language = languageInfo ? languageInfo.split(/\s+/)[0] : "text";
    const codeContent = match[2];
    const trimmedCode = codeContent.startsWith("\n") ? codeContent.slice(1) : codeContent;

    blocks.push({
      type: "code",
      language,
      content: trimmedCode,
    });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    blocks.push({
      type: "text",
      content: content.slice(lastIndex),
    });
  }

  return blocks;
}

function renderInlineMarkdown(text: string): string {
  let result = escapeHtml(text);

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold">$1</strong>');
  result = result.replace(/__(.+?)__/g, '<strong class="font-semibold">$1</strong>');

  // Italic: *text* or _text_
  result = result.replace(/\*([^*]+)\*/g, '<em class="italic">$1</em>');
  result = result.replace(/_([^_]+)_/g, '<em class="italic">$1</em>');

  // Inline code: `code`
  result = result.replace(
    /`([^`]+)`/g,
    '<code class="bg-canopy-sidebar/60 px-1.5 py-0.5 rounded text-[13px] font-mono text-canopy-text/90 border border-canopy-border/50">$1</code>'
  );

  // Links: [text](url) - with XSS protection
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const trimmedUrl = url.trim();
    const isAllowedScheme = /^(https?|mailto):/i.test(trimmedUrl);
    if (!isAllowedScheme && !/^[./]/.test(trimmedUrl)) {
      return `<span class="text-canopy-text/50">${text}</span>`;
    }
    const escapedUrl = trimmedUrl
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    return `<a href="${escapedUrl}" class="text-canopy-accent hover:underline" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  return result;
}

function TextBlock({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: ReactElement[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const flushList = () => {
    if (listItems.length > 0 && listType) {
      const ListTag = listType;
      elements.push(
        <ListTag
          key={`list-${elements.length}`}
          className={cn("my-2 pl-5", listType === "ul" ? "list-disc" : "list-decimal")}
        >
          {listItems.map((item, i) => (
            <li
              key={i}
              className="my-0.5"
              dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(item) }}
            />
          ))}
        </ListTag>
      );
      listItems = [];
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Headings
    if (trimmed.startsWith("### ")) {
      flushList();
      elements.push(
        <h3
          key={i}
          className="text-sm font-semibold text-canopy-text mt-3 mb-1"
          dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed.slice(4)) }}
        />
      );
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushList();
      elements.push(
        <h2
          key={i}
          className="text-base font-semibold text-canopy-text mt-3 mb-1"
          dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed.slice(3)) }}
        />
      );
      continue;
    }
    if (trimmed.startsWith("# ")) {
      flushList();
      elements.push(
        <h1
          key={i}
          className="text-lg font-semibold text-canopy-text mt-3 mb-1"
          dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed.slice(2)) }}
        />
      );
      continue;
    }

    // Unordered list
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      listItems.push(ulMatch[1]);
      continue;
    }

    // Ordered list
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      listItems.push(olMatch[1]);
      continue;
    }

    // Empty line
    if (trimmed === "") {
      flushList();
      continue;
    }

    // Regular paragraph
    flushList();
    elements.push(
      <p
        key={i}
        className="my-1.5 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed) }}
      />
    );
  }

  flushList();

  return <div className="space-y-0.5">{elements}</div>;
}

function CodeBlock({ content, language }: { content: string; language: string }) {
  const highlightedHtml = useMemo(() => highlightCode(content, language), [content, language]);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard?.writeText) {
      console.warn("Clipboard API not available");
      return;
    }

    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.error("Failed to copy to clipboard:", err);
      });
  }, [content]);

  useEffect(() => {
    return () => {
      setCopied(false);
    };
  }, []);

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-canopy-border bg-canopy-sidebar/30">
      {language && language !== "text" && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-canopy-sidebar/70 border-b border-canopy-border">
          <span className="text-[10px] font-mono text-canopy-text/50 uppercase tracking-wider">
            {language}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium",
              "transition-colors",
              copied
                ? "text-green-400 bg-green-400/10"
                : "text-canopy-text/50 hover:text-canopy-text/80 hover:bg-canopy-bg/50"
            )}
            aria-label="Copy code"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                Copy
              </>
            )}
          </button>
        </div>
      )}
      <pre className="p-3 overflow-x-auto">
        <code
          className="text-[13px] font-mono leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
    </div>
  );
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  // Handle empty or whitespace-only content
  const hasRenderable = blocks.some(
    (block) => block.type === "code" || block.content.trim().length > 0
  );

  if (!hasRenderable) {
    return (
      <div className={cn("text-sm text-canopy-text min-h-[1.5em]", className)} aria-hidden="true" />
    );
  }

  return (
    <div className={cn("text-sm text-canopy-text", className)}>
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <CodeBlock key={index} content={block.content} language={block.language || "text"} />
        ) : (
          <TextBlock key={index} content={block.content} />
        )
      )}
    </div>
  );
}
