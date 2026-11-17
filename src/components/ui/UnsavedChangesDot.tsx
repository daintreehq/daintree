import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const UNSAVED_CHANGES_LABEL = "Unsaved changes";
export const UNSAVED_CONFLICT_LABEL = "Unsaved changes \u2014 file changed on disk";

/**
 * The panel header's mark for a draft that has not been saved. The 6px dot is
 * the picture; the padded wrapper is the pointer target, so the tooltip opens
 * without aiming at six pixels. A conflict is the same dot with a different
 * name: the draft is standing on a file that moved.
 */
export function UnsavedChangesDot({
  conflict,
  "data-testid": testId,
}: {
  conflict: boolean;
  "data-testid"?: string;
}) {
  const label = conflict ? UNSAVED_CONFLICT_LABEL : UNSAVED_CHANGES_LABEL;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          data-testid={testId}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-text-secondary" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
