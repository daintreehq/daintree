import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/CopyButton";
import { sanitizeErrorText } from "@/utils/errorText";

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
      <CopyButton
        label="Copy"
        aria-label="Copy diagnostics"
        text={clipboardText}
        announcement="Diagnostics copied"
      />
    </div>
  );
}
