import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one chevron a picker trigger wears: the `Select` trigger's, and every
 * popover combobox that sits beside one. Two glyphs on one form read as two
 * kinds of control (#15357). `ChevronsUpDown` stays with navigation switchers.
 *
 * It turns over while its own trigger is open, so the trigger carries
 * {@link PICKER_TRIGGER_GROUP} and a `data-state` (Radix sets it through
 * `asChild`). Keyed to that group rather than `in-data-[state=open]`, which
 * matches any open ancestor and so pinned a Select inside an open popover
 * upside down.
 *
 * `size-3.5!` because a `Button` sizes every descendant svg with
 * `[&_svg]:size-4`, a more specific rule than any plain size on the icon, so a
 * combobox drew this a size larger than the `Select` on the next row.
 */
export const PickerChevron = React.forwardRef<
  SVGSVGElement,
  React.ComponentPropsWithoutRef<typeof ChevronDown>
>(({ className, ...props }, ref) => (
  <ChevronDown
    ref={ref}
    data-animated-chevron
    aria-hidden="true"
    className={cn(
      "size-3.5! shrink-0 text-text-secondary transition-transform duration-150 ease-out group-data-[state=open]/picker:rotate-180",
      className
    )}
    {...props}
  />
));
PickerChevron.displayName = "PickerChevron";

/** Marks the element whose `data-state` turns a {@link PickerChevron} inside it. */
export const PICKER_TRIGGER_GROUP = "group/picker";
