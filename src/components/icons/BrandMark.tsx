import { cloneElement, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { resolveBrandChip } from "@/lib/brandIcon";
import { useActiveAppScheme } from "@/hooks/useActiveAppScheme";

interface BrandMarkProps {
  brandColor?: string;
  /** Marks `brandColor` as a deliberate user choice (e.g. a preset color),
   * which bypasses the dark-theme white-tile fallback. */
  userChosen?: boolean;
  size?: number;
  className?: string;
  children: ReactElement<{ className?: string; brandColor?: string }>;
}

const SIZE_CLASS_REGEX = /\b(?:size-|w-|h-)/;

// Resolves a brand mark that falls below WCAG 1.4.11 (3:1) against the active
// theme's panel surface. Chromatic brands (Claude orange, Codex green, etc.)
// that already clear the floor are returned untouched. On DARK themes, mono
// brands like Goose and Open Interpreter render their official silhouette
// against a near-white tile — preserving brand fidelity rather than
// recoloring the mark. On LIGHT themes the mark itself is darkened to a
// contrast-clearing tint of the same hue — a dark tile on pale chrome reads
// as a black box, not a brand.
export function BrandMark({ brandColor, userChosen, size, className, children }: BrandMarkProps) {
  const scheme = useActiveAppScheme();
  const chip = resolveBrandChip(brandColor, scheme, userChosen);

  if (!chip || chip.tint) {
    const tintProps = chip?.tint ? { brandColor: chip.tint } : null;
    if (!className && !tintProps) {
      return children;
    }
    return cloneElement(children, {
      ...(className ? { className: cn(children.props.className, className) } : null),
      ...tintProps,
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
