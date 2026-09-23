import { useCallback, useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { sanitizeErrorText } from "@/utils/errorText";

const COPIED_RESET_MS = 2000;

export interface SpawnDiagnostics {
  errno?: number;
  syscall?: string;
  path?: string;
}

export interface DiagnosticCopyButtonProps {
  diagnostics: SpawnDiagnostics;
  /** The full error message, copied on its own line after the fields but never displayed. */
  message?: string;
  className?: string;
}

// sanitizeErrorText() preserves HT/LF/CR by design (it's intended for multi-line
// log text). For a single-line copy payload those would split values across
// lines when pasted; collapse them to spaces here.
function flattenWhitespace(text: string): string {
  return sanitizeErrorText(text).replace(/[\t\r\n]+/g, " ");
}

function formatDiagnostics(diagnostics: SpawnDiagnostics): string {
  const parts: string[] = [];
  if (typeof diagnostics.errno === "number") parts.push(`errno=${diagnostics.errno}`);
  if (diagnostics.syscall) parts.push(`syscall=${flattenWhitespace(diagnostics.syscall)}`);
  if (diagnostics.path) parts.push(`path=${flattenWhitespace(diagnostics.path)}`);
  return parts.join(" ");
}

export function DiagnosticCopyButton({
  diagnostics,
  message,
  className,
}: DiagnosticCopyButtonProps) {
  const payload = formatDiagnostics(diagnostics);
  const fullMessage = message ? flattenWhitespace(message) : "";
  const clipboardText = fullMessage ? `${payload}\n${fullMessage}` : payload;
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setCopied(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, [payload]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    if (!payload) return;
    if (!navigator.clipboard?.writeText) return;
    const gen = generationRef.current;
    void navigator.clipboard.writeText(clipboardText).then(
      () => {
        if (gen !== generationRef.current) return;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setCopied(true);
        timeoutRef.current = setTimeout(() => {
          setCopied(false);
          timeoutRef.current = null;
        }, COPIED_RESET_MS);
      },
      () => {
        // Clipboard rejected — stay silent.
      }
    );
  }, [payload, clipboardText]);

  if (!payload) return null;

  return (
    <div className={cn("mt-1 flex items-center gap-2 min-w-0", className)}>
      <span
        className="text-xs font-mono text-text-secondary truncate min-w-0"
        title={payload}
        data-testid="diagnostic-payload"
      >
        {payload}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={handleClick}
        aria-label={copied ? "Diagnostics copied" : "Copy diagnostics"}
        className="shrink-0"
      >
        <Copy aria-hidden="true" />
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
