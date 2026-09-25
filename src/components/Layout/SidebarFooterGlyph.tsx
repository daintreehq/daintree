import type { ReactNode } from "react";

/**
 * The leading glyph column shared by the sidebar footer's stacked rows —
 * QuickRun's disclosure chevron, the project plugin summary and the resource
 * readout. Their glyphs differ in size (a 12px chevron, 8px marks), and while
 * each row sized its own glyph box the labels after them started at different
 * x. A fixed column, with the glyph centred in it, holds them all to one edge.
 */
export function SidebarFooterGlyph({ children }: { children: ReactNode }) {
  return (
    <span
      data-sidebar-footer-slot="glyph"
      className="flex h-3 w-3 shrink-0 items-center justify-center"
    >
      {children}
    </span>
  );
}
