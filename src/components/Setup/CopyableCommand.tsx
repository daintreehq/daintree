import { Fragment } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { systemClient } from "@/clients/systemClient";
import { sanitizeForClipboard } from "@/lib/clipboardSanitize";

// A break opportunity after every "/" so a wrapped URL or scoped package splits at a
// path boundary rather than a single stranded letter. `<wbr>` adds no characters, so
// the rendered text (and a manual selection of it) stays the exact command.
function withPathBreaks(command: string) {
  return command.split(/(?<=\/)/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

export function CopyableCommand({
  command,
  inspectUrl,
  wrap = false,
}: {
  command: string;
  inspectUrl?: string;
  /**
   * Break the command across lines instead of truncating it. For narrow hosts where
   * the command is the instruction itself, so an ellipsis would hide the part that
   * matters (the package name sits at the end of an install line).
   */
  wrap?: boolean;
}) {
  const { copied, copy } = useCopyWithFeedback();

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] bg-overlay-subtle border border-border-default font-mono text-xs select-text group">
      <span
        className={cn(
          "flex-1 min-w-0 text-text-secondary",
          wrap ? "whitespace-normal break-words" : "truncate"
        )}
      >
        {wrap ? withPathBreaks(command) : command}
      </span>
      {inspectUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void systemClient.openExternal(inspectUrl)}
              className="shrink-0 p-0.5 rounded-[var(--radius-sm)] hover:bg-overlay transition-colors duration-150 text-text-secondary hover:text-text-primary"
              aria-label="Inspect install script in browser"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Inspect install script</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void copy(sanitizeForClipboard(command))}
            className="shrink-0 p-0.5 rounded-[var(--radius-sm)] hover:bg-overlay transition-colors duration-150 text-text-secondary hover:text-text-primary"
            aria-label="Copy command to clipboard"
          >
            {copied ? (
              <Check
                key="check"
                className={cn("w-3.5 h-3.5 text-status-success animate-badge-bump")}
              />
            ) : (
              <Copy key="copy" className="w-3.5 h-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>Copy to clipboard</TooltipContent>
      </Tooltip>
    </div>
  );
}
