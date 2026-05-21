import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { systemClient } from "@/clients/systemClient";
import { sanitizeForClipboard } from "@/lib/clipboardSanitize";

export function CopyableCommand({ command, inspectUrl }: { command: string; inspectUrl?: string }) {
  const { copied, copy } = useCopyWithFeedback();

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] bg-overlay-subtle border border-daintree-border font-mono text-xs select-text group">
      <span className="flex-1 truncate text-daintree-text/70">{command}</span>
      {inspectUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void systemClient.openExternal(inspectUrl)}
              className="shrink-0 p-0.5 rounded hover:bg-overlay transition-colors duration-150 text-daintree-text/60 hover:text-daintree-text/80"
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
            className="shrink-0 p-0.5 rounded hover:bg-overlay transition-colors duration-150 text-daintree-text/60 hover:text-daintree-text/80"
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
