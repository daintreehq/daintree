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

// Hook for the `--brand-mark-saturation` theme extension (src/index.css). Vendor
// brand hexes come from `AgentConfig.color`, not the token system, so a theme
// running a contrast budget has no other way to stop a row of logos out-shouting
// its own signals. Inert unless a theme sets the extension.
const BRAND_MARK_CLASS = "brand-mark";

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
  // Only themes that actually set the extension get the hook class, so every
  // other theme renders byte-for-byte as before (no class, no filter, no
  // compositing layer) rather than paying for an inert `saturate(1)`.
  const dampClass = scheme.extensions?.["brand-mark-saturation"] ? BRAND_MARK_CLASS : undefined;

  if (!chip || chip.tint) {
    const tintProps = chip?.tint ? { brandColor: chip.tint } : null;
    if (!className && !tintProps && !dampClass) {
      return children;
    }
    // `cn` collapses to "" when nothing is supplied; pass className only when it
    // has content so the no-op path leaves the child's props exactly as they were.
    const merged = cn(children.props.className, dampClass, className);
    return cloneElement(children, {
      ...(merged ? { className: merged } : null),
      ...tintProps,
    });
  }

  const inferSize = size === undefined && !(className && SIZE_CLASS_REGEX.test(className));
  const fallbackSize = inferSize ? 16 : size;

  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex items-center justify-center rounded-[3px]", dampClass, className)}
      style={{
        ...(fallbackSize !== undefined ? { width: fallbackSize, height: fallbackSize } : null),
        backgroundColor: chip.background,
      }}
    >
      {children}
    </span>
  );
}
