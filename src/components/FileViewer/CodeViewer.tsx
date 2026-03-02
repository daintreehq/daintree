import { useEffect, useRef, useMemo } from "react";
import { refractor } from "refractor";
import type { Element, Text, RootContent } from "hast";
import { getLanguageForFile } from "./languageUtils";
import { cn } from "@/lib/utils";

export interface CodeViewerProps {
  content: string;
  filePath: string;
  initialLine?: number;
  className?: string;
}

function toHtml(nodes: RootContent[]): string {
  return nodes
    .map((node) => {
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
        return `<span class="${className}">${toHtml(el.children as RootContent[])}</span>`;
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
    .replace(/"/g, "&quot;");
}

function highlightLine(line: string, language: string): string {
  try {
    const result = refractor.highlight(line, language);
    return toHtml(result.children as RootContent[]);
  } catch {
    return escapeHtml(line);
  }
}

export function CodeViewer({ content, filePath, initialLine, className }: CodeViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const language = useMemo(() => getLanguageForFile(filePath), [filePath]);
  const lines = useMemo(() => content.split("\n"), [content]);
  const highlightedLines = useMemo(
    () => lines.map((line) => highlightLine(line, language)),
    [lines, language]
  );

  useEffect(() => {
    if (initialLine === undefined || !containerRef.current) return;
    const lineEl = containerRef.current.querySelector(`[data-line="${initialLine}"]`);
    if (lineEl) {
      lineEl.scrollIntoView({ block: "center" });
    }
  }, [initialLine]);

  return (
    <div ref={containerRef} className={cn("font-mono text-xs leading-5 overflow-auto", className)}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((_line, idx) => {
            const lineNumber = idx + 1;
            const isHighlighted = lineNumber === initialLine;
            return (
              <tr
                key={lineNumber}
                data-line={lineNumber}
                className={cn(isHighlighted && "bg-[var(--color-status-warning)]/10")}
              >
                <td className="select-none text-right pr-4 pl-4 text-muted-foreground/50 w-12 shrink-0 border-r border-canopy-border/30">
                  {lineNumber}
                </td>
                <td
                  className="pl-4 pr-4 whitespace-pre text-canopy-text/90"
                  dangerouslySetInnerHTML={{ __html: highlightedLines[idx] }}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
