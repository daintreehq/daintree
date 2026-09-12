import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { RadioTower, ChevronDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { isTerminalFleetEligible } from "@/store/fleetEligibility";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useFleetTargetOverridesStore } from "@/store/fleetTargetOverridesStore";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { splitByRecipeVariables } from "@/utils/recipeVariables";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { FleetTargetPreview } from "./fleetExecution";

export function FleetDraftingPill(): ReactElement | null {
  const armOrder = useFleetArmingStore((s) => s.armOrder);
  // What Enter will actually reach: the armed panes that pass the same
  // eligibility gate the broadcast applies at dispatch, minus this pane. A
  // membership count here overstated the fan-out whenever an armed pane had
  // lost its PTY.
  const skippedIds = useFleetTargetOverridesStore((s) => s.skippedIds);
  const peerCount = usePanelStore((state) => {
    let n = 0;
    let primaryEligible = false;
    for (const id of armOrder) {
      if (!isTerminalFleetEligible(state.panelsById[id])) continue;
      if (id === state.focusedId) {
        primaryEligible = true;
        continue;
      }
      if (skippedIds.has(id)) continue;
      n += 1;
    }
    // This pane is the primary; if it is not the focused one (or focus sits
    // elsewhere), the membership still includes it once.
    return primaryEligible ? n : Math.max(n - 1, 0);
  });

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

  const peerNoun = peerCount === 1 ? "peer" : "peers";
  const reachLabel = `Mirroring to ${peerCount} ${peerNoun}`;

  // Stay mounted while the preview is open even if exclusions bring the reach
  // to zero — the user needs the popover to undo them.
  if (peerCount < 1 && !open) return null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
  };

  return (
    <div data-testid="fleet-drafting-pill" className="flex items-center">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={reachLabel}
            data-testid="fleet-drafting-pill-trigger"
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full",
              "bg-category-amber-subtle border border-category-amber-border text-category-amber-text shadow-[var(--theme-shadow-floating)]",
              "text-xs font-medium transition-colors",
              hasVariables && "cursor-pointer hover:bg-category-amber-subtle/80"
            )}
          >
            <RadioTower className="h-3 w-3" aria-hidden="true" />
            <span>{reachLabel}</span>
            {hasDivergence && (
              <span
                data-testid="fleet-drafting-pill-divergence-dot"
                aria-label={`${overridesCount + skippedCount} per-target edit${overridesCount + skippedCount === 1 ? "" : "s"} pending`}
                className="tabular-nums"
              >
                {[
                  overridesCount > 0 ? `${overridesCount} edited` : null,
                  skippedCount > 0 ? `${skippedCount} skipped` : null,
                ]
                  .filter((part) => part !== null)
                  .map((part) => ` · ${part}`)
                  .join("")}
              </span>
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
          className="flex max-h-[400px] w-[400px] flex-col overflow-hidden p-1"
        >
          <div className="shrink-0 px-2 py-1 text-3xs font-medium uppercase tracking-wide text-text-secondary">
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
            // The list can run past the popover's cap; the shadow says so where
            // an overlay scrollbar would not.
            <ScrollShadow>
              <ul className="flex flex-col gap-0.5">
                {previews.map((p) => (
                  <FleetResolutionRow key={p.terminalId} preview={p} />
                ))}
              </ul>
            </ScrollShadow>
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
  // The preview's unresolved list describes the template. Once the user has
  // overridden the payload, only the variables they kept are still a problem.
  const visibleUnresolved = isOverridden
    ? unresolvedVars.filter((v) => currentValue.includes(`{{${v}}}`))
    : unresolvedVars;

  return (
    <li
      data-testid="fleet-resolution-row"
      data-skipped={isSkipped ? "true" : undefined}
      className={cn("rounded-[var(--radius-md)] px-2 py-1.5", excluded && "opacity-50")}
    >
      <div className="flex items-center gap-2 text-2xs font-medium text-text-secondary">
        {/* An ineligible row keeps a disabled box so the column stays aligned
            and the row reads as "cannot include" rather than "no control". */}
        <Checkbox
          size="sm"
          checked={!isSkipped && !excluded}
          disabled={excluded}
          onCheckedChange={(next) => setSkipped(terminalId, next !== true)}
          data-testid="fleet-resolution-row-include"
          aria-label={`Include ${title} in broadcast`}
        />
        <span className={cn("truncate", isSkipped && "line-through opacity-50")}>{title}</span>
        {excluded && exclusionReason && (
          <span className="inline-flex items-center gap-0.5 text-3xs text-category-rose-text shrink-0">
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
            {exclusionReason}
          </span>
        )}
        {isSkipped && !excluded && (
          <span className="ml-auto shrink-0 text-3xs text-text-secondary">Skipped</span>
        )}
        {showsOverride && (
          <span
            className="ml-auto shrink-0 text-3xs text-category-amber-text"
            data-testid="fleet-resolution-row-overridden"
          >
            Edited
          </span>
        )}
      </div>
      <div
        className={cn(
          "mt-0.5 text-2xs leading-relaxed text-text-secondary break-all",
          isSkipped && "opacity-50"
        )}
      >
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
        <div className="mt-1 border-t border-border-subtle pt-1">
          <div
            className={cn(
              "mb-0.5 text-2xs uppercase tracking-wide text-text-secondary",
              isSkipped && "opacity-50"
            )}
          >
            {isOverridden ? "Edited" : "Resolved"}
          </div>
          <Textarea
            ref={textareaRef}
            variant="code"
            density="compact"
            resize="none"
            value={currentValue}
            onChange={(e) => handleTextareaChange(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            disabled={isSkipped}
            rows={1}
            data-fleet-override-textarea="true"
            data-testid="fleet-resolution-row-textarea"
            aria-label={`Override payload for ${title}`}
            // Grows with its content up to a cap so the payload is readable
            // in full rather than clipped at one row.
            className={cn(
              "field-sizing-content max-h-24 text-2xs leading-relaxed break-all",
              isSkipped && "line-through",
              resolvedPayload === "" && !isOverridden && "text-text-placeholder"
            )}
            placeholder={resolvedPayload === "" ? "(empty)" : undefined}
          />
          {visibleUnresolved.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {visibleUnresolved.map((v) => (
                <span
                  key={v}
                  className="inline-flex items-center rounded-full px-1.5 py-px text-3xs bg-category-rose-subtle text-category-rose-text"
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
