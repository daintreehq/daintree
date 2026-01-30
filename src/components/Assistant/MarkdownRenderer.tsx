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

type TableAlignment = "left" | "center" | "right";

interface TableData {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

interface ParsedBlock {
  type: "text" | "code" | "table";
  content: string;
  language?: string;
  tableData?: TableData;
}

function parseTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";

  // Skip leading whitespace and pipe if present
  const trimmed = row.trimStart();
  let i = trimmed.startsWith("|") ? 1 : 0;

  while (i < trimmed.length) {
    if (trimmed[i] === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
      // Escaped pipe
      current += "|";
      i += 2;
    } else if (trimmed[i] === "|") {
      cells.push(current.trim());
      current = "";
      i++;
    } else {
      current += trimmed[i];
      i++;
    }
  }

  // Add the last cell if there's content (handles rows without trailing pipe)
  const lastCell = current.trim();
  if (lastCell || cells.length > 0) {
    cells.push(lastCell);
  }

  // Remove empty last cell if row ended with pipe
  if (cells.length > 0 && cells[cells.length - 1] === "") {
    cells.pop();
  }

  return cells;
}

function parseAlignment(separator: string): TableAlignment {
  const trimmed = separator.trim();
  const hasLeftColon = trimmed.startsWith(":");
  const hasRightColon = trimmed.endsWith(":");

  if (hasLeftColon && hasRightColon) {
    return "center";
  } else if (hasRightColon) {
    return "right";
  }
  return "left";
}

function isValidSeparatorRow(row: string): boolean {
  // Separator row must contain only |, -, :, and whitespace
  const cells = parseTableRow(row);
  if (cells.length === 0) return false;

  return cells.every((cell) => {
    const trimmed = cell.trim();
    // Must have at least 3 dashes (GFM requirement)
    return /^:?-{3,}:?$/.test(trimmed);
  });
}

function tryParseTable(
  lines: string[],
  startIndex: number
): { table: TableData; endIndex: number } | null {
  // Need at least 2 lines for a valid table (header + separator)
  if (startIndex + 1 >= lines.length) return null;

  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];

  // Check if this looks like a table (must start with | after trimming)
  const trimmedHeader = headerLine.trimStart();
  const trimmedSeparator = separatorLine.trimStart();
  if (!trimmedHeader.startsWith("|") || !trimmedSeparator.startsWith("|")) return null;
  if (!isValidSeparatorRow(separatorLine)) return null;

  const headers = parseTableRow(headerLine);
  const separatorCells = parseTableRow(separatorLine);

  // Header and separator must have the same number of columns
  if (headers.length === 0 || headers.length !== separatorCells.length) return null;

  const alignments = separatorCells.map(parseAlignment);
  const rows: string[][] = [];

  // Parse body rows
  let endIndex = startIndex + 2;
  while (endIndex < lines.length) {
    const line = lines[endIndex];
    const trimmedLine = line.trimStart();

    // Stop if line doesn't start with a pipe (table rows must start with |)
    if (!trimmedLine.startsWith("|")) break;

    const cells = parseTableRow(line);
    // Require at least one cell to continue, and stop if separator-like
    if (cells.length > 0 && !isValidSeparatorRow(line)) {
      const normalizedCells = [...cells];
      while (normalizedCells.length < headers.length) {
        normalizedCells.push("");
      }
      rows.push(normalizedCells.slice(0, headers.length));
      endIndex++;
    } else {
      break;
    }
  }

  return {
    table: { headers, alignments, rows },
    endIndex,
  };
}

function parseTextWithTables(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = text.split("\n");
  let currentTextLines: string[] = [];

  const flushText = () => {
    if (currentTextLines.length > 0) {
      const content = currentTextLines.join("\n");
      if (content.trim()) {
        blocks.push({ type: "text", content });
      }
      currentTextLines = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const tableResult = tryParseTable(lines, i);
    if (tableResult) {
      flushText();
      blocks.push({
        type: "table",
        content: "",
        tableData: tableResult.table,
      });
      i = tableResult.endIndex;
    } else {
      currentTextLines.push(lines[i]);
      i++;
    }
  }

  flushText();
  return blocks;
}

function parseMarkdown(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const codeBlockRegex = /```([^\n]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const textContent = content.slice(lastIndex, match.index);
      // Parse text content for tables
      const textBlocks = parseTextWithTables(textContent);
      blocks.push(...textBlocks);
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
    const textContent = content.slice(lastIndex);
    // Parse text content for tables
    const textBlocks = parseTextWithTables(textContent);
    blocks.push(...textBlocks);
  }

  return blocks;
}

function renderInlineMarkdown(text: string): string {
  let result = escapeHtml(text);

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_
  result = result.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  result = result.replace(/_([^_]+)_/g, "<em>$1</em>");

  // Inline code: `code` - prose-canopy handles styling
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Links: [text](url) - with XSS protection, prose-canopy handles styling
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const trimmedUrl = url.trim();
    const isAllowedScheme = /^(https?|mailto):/i.test(trimmedUrl);
    if (!isAllowedScheme && !/^[./]/.test(trimmedUrl)) {
      return `<span class="text-canopy-text/50">${linkText}</span>`;
    }
    const escapedUrl = trimmedUrl
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
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
        <ListTag key={`list-${elements.length}`}>
          {listItems.map((item, i) => (
            <li key={i} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(item) }} />
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
        <h3 key={i} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed.slice(4)) }} />
      );
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushList();
      elements.push(
        <h2 key={i} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed.slice(3)) }} />
      );
      continue;
    }
    if (trimmed.startsWith("# ")) {
      flushList();
      elements.push(
        <h1 key={i} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed.slice(2)) }} />
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
      <p key={i} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(trimmed) }} />
    );
  }

  flushList();

  return <>{elements}</>;
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
    <div className="not-prose my-3 first:mt-0 rounded-lg overflow-hidden border border-canopy-border bg-canopy-sidebar/30">
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

function TableBlock({ tableData }: { tableData: TableData }) {
  const alignmentClass = (alignment: TableAlignment): string => {
    switch (alignment) {
      case "center":
        return "text-center";
      case "right":
        return "text-right";
      default:
        return "text-left";
    }
  };

  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-canopy-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-canopy-sidebar/30">
            {tableData.headers.map((header, i) => (
              <th
                key={i}
                scope="col"
                className={cn(
                  "px-3 py-1.5 font-semibold text-canopy-text/90 border-b border-canopy-border",
                  i > 0 && "border-l border-canopy-border",
                  alignmentClass(tableData.alignments[i])
                )}
                dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(header) }}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {tableData.rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className={cn(
                rowIndex % 2 === 1 && "bg-canopy-sidebar/10",
                rowIndex < tableData.rows.length - 1 && "border-b border-canopy-border/50"
              )}
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn(
                    "px-3 py-1.5 text-canopy-text",
                    cellIndex > 0 && "border-l border-canopy-border/50",
                    alignmentClass(tableData.alignments[cellIndex])
                  )}
                  dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(cell) }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  // Handle empty or whitespace-only content
  const hasRenderable = blocks.some(
    (block) => block.type === "code" || block.type === "table" || block.content.trim().length > 0
  );

  if (!hasRenderable) {
    return (
      <div
        className={cn("prose prose-sm prose-canopy min-h-[1.5em]", className)}
        aria-hidden="true"
      />
    );
  }

  return (
    <div className={cn("prose prose-sm prose-canopy max-w-none", className)}>
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <CodeBlock key={index} content={block.content} language={block.language || "text"} />
          );
        }
        if (block.type === "table" && block.tableData) {
          return <TableBlock key={index} tableData={block.tableData} />;
        }
        return <TextBlock key={index} content={block.content} />;
      })}
    </div>
  );
}
