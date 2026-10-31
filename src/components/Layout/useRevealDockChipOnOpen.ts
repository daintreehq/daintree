import { useEffect, useRef } from "react";

/**
 * Brings a chip onto the rail when its preview opens. A preview can open with
 * its chip scrolled off the rail (a status-popover row, a keybinding, MCP), and
 * an anchor out of view leaves the popover pinned to nothing at the rail's edge.
 */
export function useRevealDockChipOnOpen(isOpen: boolean) {
  const chipRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    chipRef.current?.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
  }, [isOpen]);
  return chipRef;
}
