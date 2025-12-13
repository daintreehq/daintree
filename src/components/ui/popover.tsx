import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

let sidecarBoundary: HTMLDivElement | null = null;

function getSidecarBoundary() {
  if (typeof document === "undefined") return null;
  if (sidecarBoundary) return sidecarBoundary;

  // Collision boundary that excludes the native sidecar region on the right.
  const boundary = document.createElement("div");
  boundary.dataset.sidecarBoundary = "true";
  Object.assign(boundary.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "calc(100vw - var(--sidecar-right-offset, 0px))",
    height: "100vh",
    pointerEvents: "none",
    visibility: "hidden",
  });
  document.body.appendChild(boundary);
  sidecarBoundary = boundary;
  return boundary;
}

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, collisionBoundary, ...props }, ref) => {
  const [boundary, setBoundary] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    setBoundary(getSidecarBoundary());
  }, []);

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        collisionBoundary={collisionBoundary ?? boundary ?? undefined}
        className={cn(
          "z-[var(--z-popover)] overflow-hidden rounded-[var(--radius-lg)] border border-canopy-border bg-canopy-sidebar text-canopy-text shadow-lg",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
