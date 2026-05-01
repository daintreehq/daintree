import { cloneElement, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { resolveBrandChip } from "@/lib/brandIcon";
import { useActiveAppScheme } from "@/hooks/useActiveAppScheme";

interface BrandMarkProps {
  brandColor?: string;
  size?: number;
  className?: string;
  children: ReactElement<{ className?: string }>;
}

const SIZE_CLASS_REGEX = /\b(?:size-|w-|h-)/;

// Wraps a brand icon in a contrasting chip when the brand color falls below
// WCAG 1.4.11 (3:1) against the active theme's panel surface. Chromatic
// brands (Claude orange, Codex green, etc.) are returned untouched. Mono
// brands like Goose and Open Interpreter render their official silhouette
// against a near-white tile on dark themes — preserving brand fidelity
// rather than recoloring the mark.
export function BrandMark({ brandColor, size, className, children }: BrandMarkProps) {
  const scheme = useActiveAppScheme();
  const chip = resolveBrandChip(brandColor, scheme);

  if (!chip) {
    if (!className) {
      return children;
    }
    return cloneElement(children, {
      className: cn(children.props.className, className),
    });
  }

  const inferSize = size === undefined && !(className && SIZE_CLASS_REGEX.test(className));
  const fallbackSize = inferSize ? 16 : size;

  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex items-center justify-center rounded-[3px]", className)}
      style={{
        ...(fallbackSize !== undefined ? { width: fallbackSize, height: fallbackSize } : null),
        backgroundColor: chip.background,
      }}
    >
      {children}
    </span>
  );
}
