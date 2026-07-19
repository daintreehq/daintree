import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

// Full literal strings per density rather than a shared base: the comfortable
// output stays byte-identical to the markup the 35 AppDialog consumers render
// today, and compact stays free of a `py-*` utility that would fight `h-8`.
const surfaceHeaderVariants = cva("", {
  variants: {
    density: {
      compact: "h-8 px-3 border-b border-divider flex items-center justify-between shrink-0",
      comfortable:
        "px-6 py-4 border-b border-border-strong dialog-header flex items-center justify-between shrink-0",
    },
  },
  defaultVariants: {
    density: "comfortable",
  },
});

export interface SurfaceHeaderProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof surfaceHeaderVariants> {
  children: React.ReactNode;
}

// Composition stays open (children, not leading/trailing slots): consumers nest
// search rows, badge clusters and multi-line title stacks inside the frame.
const SurfaceHeader = React.forwardRef<HTMLDivElement, SurfaceHeaderProps>(
  ({ density, className, children, ...props }, ref) => (
    <div ref={ref} className={cn(surfaceHeaderVariants({ density }), className)} {...props}>
      {children}
    </div>
  )
);
SurfaceHeader.displayName = "SurfaceHeader";

export interface SurfaceHeaderTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
  icon?: React.ReactNode;
  // Restricted rather than fully polymorphic: a surface header is either the
  // primary label of its dialog (h2) or a section heading inside one (h3).
  as?: "h2" | "h3";
}

const SurfaceHeaderTitle = React.forwardRef<HTMLHeadingElement, SurfaceHeaderTitleProps>(
  ({ as: Heading = "h2", icon, className, children, ...props }, ref) => (
    <Heading
      ref={ref}
      className={cn("text-lg font-semibold text-daintree-text flex items-center gap-2", className)}
      {...props}
    >
      {icon}
      {children}
    </Heading>
  )
);
SurfaceHeaderTitle.displayName = "SurfaceHeaderTitle";

export interface SurfaceHeaderCloseButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> {
  // Required here, defaulted by the surface that owns the wrapper: a bare
  // "Close" is ambiguous once more than one surface uses this button.
  "aria-label": string;
}

const SurfaceHeaderCloseButton = React.forwardRef<
  HTMLButtonElement,
  SurfaceHeaderCloseButtonProps
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-raised transition-colors p-1 rounded",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
      className
    )}
    {...props}
    // After the spread: a cast-through `type: "submit"` would otherwise submit
    // the surrounding form instead of closing the surface.
    type="button"
  >
    <X className="h-5 w-5" />
  </button>
));
SurfaceHeaderCloseButton.displayName = "SurfaceHeaderCloseButton";

export { SurfaceHeader, SurfaceHeaderTitle, SurfaceHeaderCloseButton, surfaceHeaderVariants };
