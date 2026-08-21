import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { BrandMarkSurface } from "@/lib/brandIcon";

const BrandSurfaceContext = createContext<BrandMarkSurface | null>(null);

/**
 * Declares which surface the brand marks below it are painted on.
 *
 * A mark's two inks are placed by measuring against their backdrop, so the
 * backdrop has to be known. Without this the resolver falls back to the theme's
 * hardest surface, which is safe everywhere and generous nowhere — it spends
 * the whole contrast budget on a surface the mark may not even be sitting on.
 *
 * Providers go on containers, not call sites: one on a panel title bar covers
 * the header glyph and every tab in the strip. `lift` names an overlay the
 * container already composites over `surface` in its current state — a focused
 * panel header is `surface-panel` *plus* its focus lift, and measuring the bare
 * token there would answer for a pixel that is not on screen.
 */
export function BrandSurface({
  surface,
  extension,
  lift,
  children,
}: BrandMarkSurface & { children: ReactNode }) {
  // Destructured to primitives and rebuilt, so a caller passing a fresh object
  // literal every render does not re-render every mark below it.
  const value = useMemo(() => ({ surface, extension, lift }), [surface, extension, lift]);
  return <BrandSurfaceContext.Provider value={value}>{children}</BrandSurfaceContext.Provider>;
}

/**
 * Withdraws whatever surface an ancestor declared.
 *
 * For floating material — menus, popovers — whose backdrop is a blur over
 * whatever happens to be behind it. React context reaches through a portal even
 * though the DOM does not, so a menu opened from the toolbar would otherwise
 * measure its marks against the toolbar. Declining sends them back to the
 * conservative fallback, which is the honest answer for a surface no one can
 * name.
 */
export function BrandSurfaceReset({ children }: { children: ReactNode }) {
  return <BrandSurfaceContext.Provider value={null}>{children}</BrandSurfaceContext.Provider>;
}

export function useBrandSurface(): BrandMarkSurface | null {
  return useContext(BrandSurfaceContext);
}
