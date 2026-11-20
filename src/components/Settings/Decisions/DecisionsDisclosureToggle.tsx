import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The button of a disclosure on a Decisions row: its words stay the same open or
 * closed, and the chevron turns. It is the control a deep link into the
 * disclosure hands focus to, since the content it opens may not be there yet.
 */
export function DecisionsDisclosureToggle({
  open,
  onToggle,
  controls,
  labelId,
  disabled,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** Ids of what it shows, listed only while they are there. */
  controls: string | undefined;
  /** The row's label, which the name starts with: "{row} {button}". */
  labelId: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Button
      id={id}
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-labelledby={`${labelId} ${id}`}
      data-settings-focus-target=""
      onClick={onToggle}
    >
      {children}
      <ChevronRight
        data-animated-chevron
        aria-hidden="true"
        className={cn("ml-1 h-3.5 w-3.5 transition-transform duration-150", open && "rotate-90")}
      />
    </Button>
  );
}
