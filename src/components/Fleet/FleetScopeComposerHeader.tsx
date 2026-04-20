import { useEffect, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { useFleetDeckStore } from "@/store/fleetDeckStore";
import { FleetComposer } from "./FleetComposer";
import { focusFleetComposer } from "./fleetComposerFocus";

interface FleetScopeComposerHeaderProps {
  agentCount: number;
  worktreeCount: number;
  className?: string;
}

export function FleetScopeComposerHeader({
  agentCount,
  worktreeCount,
  className,
}: FleetScopeComposerHeaderProps): ReactElement {
  // When the deck is open, the deck renders its own FleetComposer. Skip the
  // header's composer to avoid double-mount — the single-slot focus registry
  // would otherwise be hijacked by whichever composer mounts second.
  const isDeckOpen = useFleetDeckStore((s) => s.isOpen);

  // Autofocus the composer when the header first mounts (scope entry).
  // Child effects fire before parent effects, so FleetComposer's
  // registerFleetComposerFocusHandler runs before this call.
  useEffect(() => {
    if (isDeckOpen) return;
    focusFleetComposer();
  }, [isDeckOpen]);

  const agentWord = agentCount === 1 ? "agent" : "agents";
  const worktreeWord = worktreeCount === 1 ? "worktree" : "worktrees";

  return (
    <div
      className={cn("shrink-0 border-b border-daintree-accent/40 bg-daintree-accent/5", className)}
      data-testid="fleet-scope-composer-header"
    >
      <div className="flex items-center gap-2 px-3 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-daintree-accent/90">
        <span aria-live="polite">
          Broadcasting to {agentCount} {agentWord} across {worktreeCount} {worktreeWord}
        </span>
      </div>
      {!isDeckOpen && <FleetComposer />}
    </div>
  );
}
