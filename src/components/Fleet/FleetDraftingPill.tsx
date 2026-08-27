import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { RadioTower, ChevronDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useFleetTargetOverridesStore } from "@/store/fleetTargetOverridesStore";
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

  const overridesCount = useFleetTargetOverridesStore(
    (s) => Object.keys(s.payloadOverrides).length
  );
  const skippedCount = useFleetTargetOverridesStore((s) => s.skippedIds.size);
  const hasDivergence = overridesCount > 0 || skippedCount > 0;

  useEscapeStack(open, () => setOpen(false));

  // Per-target overrides are ephemeral per-broadcast (#8691). The broadcast
  // pipeline (fleetEnterBroadcast.doSend) reads the snapshot taken at
  // Enter-press time and clears in its `finally`, so this effect only
  // covers the "user opened, edited, then dismissed without sending" case.
  useEffect(() => {
    if (!open) {
      useFleetTargetOverridesStore.getState().clear();
    }
  }, [open]);

  if (peerCount < 1) return null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
  };

  return (
    <div data-testid="fleet-drafting-pill" className="flex items-center">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Drafting for ${fleetSize} agents`}
            data-testid="fleet-drafting-pill-trigger"
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full",
              "bg-category-amber-subtle border border-category-amber-border text-category-amber-text shadow-[var(--theme-shadow-floating)]",
              "text-xs font-medium transition-colors",
              hasVariables && "cursor-pointer hover:bg-category-amber-subtle/80"
            )}
          >
            <RadioTower className="h-3 w-3" aria-hidden="true" />
            <span>
              Mirroring to {peerCount} {peerCount === 1 ? "peer" : "peers"}
            </span>
            {hasDivergence && (
              <span
                data-testid="fleet-drafting-pill-divergence-dot"
                aria-label={`${overridesCount + skippedCount} per-target edit${overridesCount + skippedCount === 1 ? "" : "s"} pending`}
                className="status-mark ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-category-amber-border"
              />
            )}
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
          align="start"
          sideOffset={4}
          onEscapeKeyDown={(e) => {
            // Escape inside an override textarea should clear focus or the
            // edit, not collapse the popover. Block the dismiss; the
            // textarea's own onKeyDown handles the local Escape semantics.
            const active = document.activeElement;
            if (active instanceof HTMLElement && active.dataset.fleetOverrideTextarea === "true") {
              e.preventDefault();
            }
          }}
          data-testid="fleet-resolution-popover"
          className="max-h-[400px] w-[400px] overflow-y-auto p-1"
        >
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-daintree-text/50">
            Fleet broadcast preview
          </div>
          {previews.length === 0 ? (
            <EmptyState
              variant="zero-data"
              scale="popover"
              title="No armed terminals"
              className="py-3"
            />
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

function FleetResolutionRow({ preview }: FleetResolutionRowProps): ReactElement {
  const { terminalId, title, resolvedPayload, unresolvedVars, excluded, exclusionReason } = preview;
  const draft = useFleetResolutionPreviewStore((s) => s.draft);
  const override = useFleetTargetOverridesStore((s) => s.payloadOverrides[terminalId]);
  const isSkipped = useFleetTargetOverridesStore((s) => s.skippedIds.has(terminalId));
  const setPayloadOverride = useFleetTargetOverridesStore((s) => s.setPayloadOverride);
  const clearPayloadOverride = useFleetTargetOverridesStore((s) => s.clearPayloadOverride);
  const setSkipped = useFleetTargetOverridesStore((s) => s.setSkipped);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // The textarea is a controlled input. When the user edits, we either
  // store a non-default value as an override, or clear the override if
  // they typed it back to the resolved default. This keeps the override
  // map sparse — only actual divergences live in it.
  const currentValue = override ?? resolvedPayload;
  const isOverridden = override !== undefined;

  const handleTextareaChange = useCallback(
    (next: string) => {
      if (next === resolvedPayload) {
        clearPayloadOverride(terminalId);
      } else {
        setPayloadOverride(terminalId, next);
      }
    },
    [terminalId, resolvedPayload, setPayloadOverride, clearPayloadOverride]
  );

  const handleTextareaKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter") {
        // Enter inside the override field must not bubble to the primary
        // pane's input bar — that handler would call
        // tryFleetBroadcastFromEditor and fire the broadcast mid-edit.
        // Allow Shift+Enter for multi-line overrides (already what
        // browsers do by default in a textarea), and absorb plain Enter
        // as a "commit and blur" so the user can keyboard their way out
        // of the field without sending.
        if (!e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          textareaRef.current?.blur();
        }
        return;
      }
      if (e.key === "Escape") {
        // Escape inside an override field clears the override (reverting
        // to the resolved default) and blurs. The popover-level
        // onEscapeKeyDown guard above prevents the popover from closing.
        e.preventDefault();
        e.stopPropagation();
        clearPayloadOverride(terminalId);
        textareaRef.current?.blur();
      }
    },
    [terminalId, clearPayloadOverride]
  );

  const parts = splitByRecipeVariables(draft);
  const showsOverride = isOverridden && !isSkipped;

  return (
    <li
      data-testid="fleet-resolution-row"
      data-skipped={isSkipped ? "true" : undefined}
      className={cn(
        "rounded px-2 py-1.5",
        excluded && "opacity-50",
        isSkipped && !excluded && "opacity-50"
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-daintree-text/70">
        {!excluded && (
          <label className="inline-flex shrink-0 items-center">
            <input
              type="checkbox"
              checked={!isSkipped}
              onChange={(e) => setSkipped(terminalId, !e.target.checked)}
              data-testid="fleet-resolution-row-include"
              aria-label={`Include ${title} in broadcast`}
              className="h-3 w-3 cursor-pointer rounded border-daintree-border transition-colors duration-150"
            />
          </label>
        )}
        <span className={cn("truncate", isSkipped && "line-through")}>{title}</span>
        {excluded && exclusionReason && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-category-rose-text shrink-0">
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
            {exclusionReason}
          </span>
        )}
        {isSkipped && !excluded && (
          <span className="ml-auto shrink-0 text-[10px] text-daintree-text/50">Skipped</span>
        )}
        {showsOverride && (
          <span
            className="ml-auto shrink-0 text-[10px] text-category-amber-text"
            data-testid="fleet-resolution-row-overridden"
          >
            Edited
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
              {isOverridden ? "edited" : "resolved"}
            </span>
            <textarea
              ref={textareaRef}
              value={currentValue}
              onChange={(e) => handleTextareaChange(e.target.value)}
              onKeyDown={handleTextareaKeyDown}
              disabled={isSkipped}
              rows={1}
              data-fleet-override-textarea="true"
              data-testid="fleet-resolution-row-textarea"
              aria-label={`Override payload for ${title}`}
              className={cn(
                "flex-1 resize-y bg-transparent text-[11px] leading-relaxed break-all text-daintree-text",
                "rounded-sm border border-transparent px-1 py-0.5 outline-hidden transition-colors duration-150",
                "hover:border-border-subtle focus:border-border-subtle",
                isSkipped && "cursor-not-allowed line-through",
                resolvedPayload === "" && !isOverridden && "text-daintree-text/40"
              )}
              placeholder={resolvedPayload === "" ? "(empty)" : undefined}
            />
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
}
