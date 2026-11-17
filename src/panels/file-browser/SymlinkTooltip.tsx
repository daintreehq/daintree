import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

/**
 * Where a symlinked row points, for the pointer. The row itself is the focus
 * target and already carries the same words as screen-reader text, so this
 * adds no tab stop of its own.
 */
export function SymlinkTooltip({
  description,
  children,
}: {
  description: string | null | undefined;
  children: ReactElement;
}) {
  if (!description) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="break-words">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A row's name, for the pointer: where a symlink points, otherwise the full
 * name while it is cut. The row is the focus target, so neither gives the
 * text a tab stop of its own.
 */
export function RowNameTooltip({
  name,
  symlinkDescription,
  children,
}: {
  name: string;
  symlinkDescription: string | null | undefined;
  children: ReactElement;
}) {
  if (symlinkDescription) {
    return <SymlinkTooltip description={symlinkDescription}>{children}</SymlinkTooltip>;
  }
  return (
    <TruncatedTooltip
      content={name}
      side="bottom"
      align="start"
      contentClassName="break-words"
      focusable={false}
    >
      {children}
    </TruncatedTooltip>
  );
}
