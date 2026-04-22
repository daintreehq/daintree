import { type ReactElement } from "react";
import { RadioTower } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

/**
 * Passive "Mirroring to N peers" indicator above the focused armed pane's
 * input bar. Pure label — no buttons, no popover. Enter in the input bar
 * broadcasts to every armed peer (handled in HybridInputBar via
 * `tryFleetBroadcastFromEditor`); the pill exists only to confirm visually
 * that the user's keystrokes will land in more than one place.
 */
export function FleetDraftingPill(): ReactElement | null {
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const fleetSize = armedIds.size;
  const peerCount = fleetSize - 1;

  // Hide on a 1-pane fleet — there's no peer to mirror to.
  if (peerCount < 1) return null;

  return (
    <div data-testid="fleet-drafting-pill" className="mb-1.5 flex items-center text-[11px]">
      <span
        aria-label={`Drafting for ${fleetSize} agents`}
        data-testid="fleet-drafting-pill-trigger"
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
          "bg-category-amber-subtle text-category-amber-text"
        )}
      >
        <RadioTower className="h-3 w-3" aria-hidden="true" />
        <span>
          Mirroring to {peerCount} {peerCount === 1 ? "peer" : "peers"}
        </span>
      </span>
    </div>
  );
}
