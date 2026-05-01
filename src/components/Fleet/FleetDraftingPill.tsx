import { type ReactElement, memo } from "react";
import { RadioTower, ChevronDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { splitByRecipeVariables } from "@/utils/recipeVariables";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { FleetTargetPreview } from "./fleetExecution";

export function FleetDraftingPill(): ReactElement | null {
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const fleetSize = armedIds.size;
  const peerCount = fleetSize - 1;

  const open = useFleetResolutionPreviewStore((s) => s.open);
  const hasVariables = useFleetResolutionPreviewStore((s) => s.hasVariables);
  const previews = useFleetResolutionPreviewStore((s) => s.previews);
  const setOpen = useFleetResolutionPreviewStore((s) => s.setOpen);

  useEscapeStack(open, () => setOpen(false));

  if (peerCount < 1) return null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
  };

  return (
    <div data-testid="fleet-drafting-pill" className="flex items-center text-[11px]">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Drafting for ${fleetSize} agents`}
            data-testid="fleet-drafting-pill-trigger"
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors",
              "bg-category-amber-subtle text-category-amber-text",
              hasVariables && "cursor-pointer hover:bg-category-amber-subtle/80"
            )}
          >
            <RadioTower className="h-3 w-3" aria-hidden="true" />
            <span>
              Mirroring to {peerCount} {peerCount === 1 ? "peer" : "peers"}
            </span>
            {hasVariables && (
              <ChevronDown
                className={cn("h-3 w-3 transition-transform duration-150", open && "rotate-180")}
                aria-hidden="true"
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={4}
          data-testid="fleet-resolution-popover"
          className="max-h-[320px] w-[360px] overflow-y-auto p-1"
        >
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-daintree-text/50">
            Fleet broadcast preview
          </div>
          {previews.length === 0 ? (
            <div className="px-2 py-1 text-[12px] text-daintree-text/60">No armed terminals</div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {previews.map((p) => (
                <FleetResolutionRow key={p.terminalId} preview={p} />
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface FleetResolutionRowProps {
  preview: FleetTargetPreview;
}

const FleetResolutionRow = memo(function FleetResolutionRow({
  preview,
}: FleetResolutionRowProps): ReactElement {
  const { title, resolvedPayload, unresolvedVars, excluded, exclusionReason } = preview;
  const draft = useFleetResolutionPreviewStore((s) => s.draft);
  const parts = splitByRecipeVariables(draft);

  return (
    <li
      data-testid="fleet-resolution-row"
      className={cn("rounded px-2 py-1.5", excluded && "opacity-50")}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-daintree-text/70">
        <span className="truncate">{title}</span>
        {excluded && exclusionReason && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-category-rose-text shrink-0">
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
            {exclusionReason}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] leading-relaxed text-daintree-text/60 break-all">
        {parts.map((part, i) =>
          part.isVar ? (
            <span
              key={i}
              className="inline rounded-sm bg-category-amber-subtle px-0.5 text-category-amber-text"
            >
              {part.text}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          )
        )}
      </div>
      {!excluded && (
        <div className="mt-1 border-t border-border-subtle pt-0.5">
          <div className="flex items-start gap-1.5">
            <span className="text-[9px] uppercase tracking-wide text-daintree-text/40 mt-px shrink-0">
              resolved
            </span>
            <span
              data-testid="fleet-resolution-resolved-text"
              className="text-[11px] leading-relaxed break-all text-daintree-text"
            >
              {resolvedPayload !== "" ? (
                resolvedPayload
              ) : (
                <span className="text-daintree-text/40">(empty)</span>
              )}
            </span>
          </div>
          {unresolvedVars.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {unresolvedVars.map((v) => (
                <span
                  key={v}
                  className="inline-flex items-center rounded-full px-1.5 py-px text-[9px] bg-category-rose-subtle text-category-rose-text"
                >
                  {`{{${v}}}`} unresolved
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
});
