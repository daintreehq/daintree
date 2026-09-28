import { Fragment } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
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
      {/* -my-1: the 24px targets sit inside the row's own padding rather
          than growing the strip around a one-line command. */}
      {inspectUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void systemClient.openExternal(inspectUrl)}
              className="-my-1 shrink-0 [&_svg]:size-3.5"
              aria-label="Inspect install script in browser"
            >
              <ExternalLink aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Inspect install script</TooltipContent>
        </Tooltip>
      )}
      <CopyButton
        text={sanitizeForClipboard(command)}
        aria-label="Copy command to clipboard"
        tooltip="Copy to clipboard"
        className="-my-1"
      />
    </div>
  );
}
