import { createContext, type ReactNode } from "react";

/**
 * True inside content that sits inset from a surface's edges — a dialog body,
 * the settings page column — rather than across the top of a pane. A status
 * banner there is a box among the content, so it draws the `Callout` recipe's
 * full border and corner instead of a pane banner's edge-to-edge band.
 */
export const InsetSurfaceContext = createContext(false);

export function InsetSurface({ children }: { children: ReactNode }) {
  return <InsetSurfaceContext value={true}>{children}</InsetSurfaceContext>;
}
