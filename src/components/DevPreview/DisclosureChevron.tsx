import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The console's one disclosure glyph: stacks, library runs, groups, objects. */
export function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      data-animated-chevron
      aria-hidden="true"
      className={cn(
        "w-3 h-3 shrink-0 transition-transform duration-150 ease-out",
        expanded && "rotate-90"
      )}
    />
  );
}
