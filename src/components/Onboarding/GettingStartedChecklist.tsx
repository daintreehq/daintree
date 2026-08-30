import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronUp, Download, X } from "lucide-react";
import { useReducedMotion } from "framer-motion";
import { DURATION_200 } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { KbdChord } from "@/components/ui/Kbd";
import type { ChecklistState, ChecklistItemId } from "@shared/types/ipc/maps";
import { CHECKLIST_ITEMS } from "./checklistItems";

const CHECKLIST_BODY_ID = "getting-started-checklist-body";

// Teaches the shortcut at the moment of highest engagement: the checklist CTA
// the user is about to click. Reads the live effective binding so rebinds
// show correctly; renders nothing for unbound actions.
function RowShortcut({ actionId }: { actionId: string }) {
  const combo = useEffectiveCombo(actionId);
  if (!combo) return null;
  return <KbdChord shortcut={combo} className="shrink-0 opacity-60" />;
}

interface CheckBadgeProps {
  done: boolean;
  isPopping: boolean;
  onPopEnd: () => void;
}

// Renders the round check badge for a checklist row. The pop animation is
// driven from the parent (see GettingStartedChecklist) so that toggling
// `done` — which swaps the row's parent element between <button> and <div>
// and would otherwise remount this component — does not lose pop state.
function CheckBadge({ done, isPopping, onPopEnd }: CheckBadgeProps) {
  return (
    <div
      onAnimationEnd={onPopEnd}
      className={cn(
        "h-4 w-4 rounded-full border flex items-center justify-center shrink-0 transition-colors duration-150",
        done ? "bg-accent-primary border-accent-primary" : "border-daintree-text/30",
        isPopping && "animate-badge-bump"
      )}
    >
      {done && <Check className="h-2.5 w-2.5 text-accent-primary-foreground" />}
    </div>
  );
}

interface GettingStartedChecklistProps {
  checklist: ChecklistState;
  collapsed: boolean;
  onDismiss: () => void;
  onToggleCollapse: () => void;
  onMarkItem?: (id: ChecklistItemId) => void;
}

export function GettingStartedChecklist({
  checklist,
  collapsed,
  onDismiss,
  onToggleCollapse,
  onMarkItem,
}: GettingStartedChecklistProps) {
  const [isVisible, setIsVisible] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const items = checklist.items;
  const prevItemsRef = useRef(items);
  const popTimersRef = useRef(new Map<ChecklistItemId, ReturnType<typeof setTimeout>>());
  const mountedRef = useRef(true);
  const [poppingItems, setPoppingItems] = useState<Set<ChecklistItemId>>(() => new Set());

  useEffect(() => {
    const rafId = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(rafId);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const timers = popTimersRef.current;
    return () => {
      mountedRef.current = false;
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // When an item flips from incomplete → complete, pop its badge for 200ms.
  // The 200ms setTimeout is a safety fallback for the moments when
  // `animationend` does not fire (reduced motion, data-reduce-animations,
  // performance mode) — it ensures isPopping is cleared even when the CSS
  // animation is suppressed. Mirrors the toaster `bumpFallbackRef` pattern.
  useEffect(() => {
    const prev = prevItemsRef.current;
    prevItemsRef.current = items;
    if (prefersReducedMotion) return;

    const newlyDone: ChecklistItemId[] = [];
    for (const { id } of CHECKLIST_ITEMS) {
      if (items[id] && !prev[id]) newlyDone.push(id);
    }
    if (newlyDone.length === 0) return;

    setPoppingItems((current) => {
      const next = new Set(current);
      for (const id of newlyDone) next.add(id);
      return next;
    });

    for (const id of newlyDone) {
      const existing = popTimersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        if (!mountedRef.current) return;
        setPoppingItems((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        popTimersRef.current.delete(id);
      }, DURATION_200);
      popTimersRef.current.set(id, timer);
    }
  }, [items, prefersReducedMotion]);

  const clearPop = (id: ChecklistItemId) => {
    setPoppingItems((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    const existing = popTimersRef.current.get(id);
    if (existing) {
      clearTimeout(existing);
      popTimersRef.current.delete(id);
    }
  };

  const completedCount = Object.values(items).filter(Boolean).length;
  const allComplete = completedCount === CHECKLIST_ITEMS.length;
  // Endowed-progress accounting (real items + always-complete "Install
  // Daintree") mirrors WelcomeScreen's inline checklist so visible progress
  // never regresses across the surface transition.
  const counterLabel = allComplete
    ? "All set"
    : `${1 + completedCount}/${CHECKLIST_ITEMS.length + 1}`;
  const counterAnimateKey = allComplete ? "all-set" : String(completedCount);

  const panelRef = useRef<HTMLDivElement>(null);
  const [isFocusWithin, setIsFocusWithin] = useState(false);

  const handleEscape = useCallback(() => {
    onToggleCollapse();
  }, [onToggleCollapse]);

  useEscapeStack(isFocusWithin, handleEscape);

  return createPortal(
    <div
      className={cn(
        "fixed bottom-4 z-[var(--z-toast)] pointer-events-none p-4",
        "flex justify-end w-full max-w-[320px]"
      )}
      style={{ right: "calc(var(--right-obstruction-offset, 0px))" }}
    >
      <div
        ref={panelRef}
        role="region"
        aria-label="Getting started checklist"
        data-getting-started-checklist=""
        onFocus={() => setIsFocusWithin(true)}
        onBlur={(e) => {
          if (!panelRef.current?.contains(e.relatedTarget as Node | null)) {
            setIsFocusWithin(false);
          }
        }}
        className={cn(
          "pointer-events-auto relative w-full",
          "rounded-[var(--radius-sm)] border",
          "text-sm text-text-primary",
          "shadow-[var(--theme-shadow-floating)]",
          "transition-[translate,opacity,background-color,border-color] duration-200 ease-out",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:translate-none",
          isVisible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
          allComplete
            ? "bg-surface-panel border-border-default"
            : [
                "bg-[color-mix(in_oklab,var(--color-accent-primary)_8%,var(--color-surface-canvas))]",
                "border-[color:color-mix(in_oklab,var(--color-accent-primary)_20%,transparent)]",
              ],
          "backdrop-blur-sm"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-expanded={!collapsed}
                aria-controls={CHECKLIST_BODY_ID}
                className="flex items-center gap-2 text-left flex-1 min-w-0"
              >
                <h4 className="font-medium leading-tight tracking-tight text-xs font-mono text-accent-primary">
                  Getting started
                </h4>
                <AnimatedLabel
                  label={counterLabel}
                  animateKey={counterAnimateKey}
                  textClassName={cn(
                    "text-3xs font-mono tabular-nums",
                    allComplete ? "text-accent-primary" : "text-text-secondary"
                  )}
                />
                {collapsed ? (
                  <ChevronUp className="h-3 w-3 text-daintree-text/50 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-daintree-text/50 shrink-0" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{collapsed ? "Expand" : "Collapse"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss checklist"
                className={cn(
                  "rounded-[var(--radius-xs)]",
                  "h-6 w-6 flex items-center justify-center shrink-0",
                  "text-daintree-text/60 transition-colors",
                  "hover:text-daintree-text/90 hover:bg-tint/10",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Dismiss — reopen from Help → Getting Started
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Collapsible body */}
        <div
          id={CHECKLIST_BODY_ID}
          className={cn(
            "overflow-hidden transition-[height] duration-300 ease-in-out",
            "motion-reduce:transition-none motion-reduce:duration-0",
            collapsed ? "h-0" : "h-auto"
          )}
          {...(collapsed ? { inert: true } : {})}
        >
          <div className="px-3 pb-3 space-y-1.5">
            {/* Endowed progress: Install Daintree (always complete) */}
            <div className="flex items-start gap-2.5 rounded-[var(--radius-xs)] px-2 py-1.5 opacity-60">
              <div className="h-4 w-4 rounded-full bg-accent-primary border border-accent-primary flex items-center justify-center shrink-0">
                <Check className="h-2.5 w-2.5 text-accent-primary-foreground" />
              </div>
              <Download className="h-3.5 w-3.5 text-daintree-text/40 shrink-0" />
              <span className="text-xs leading-snug text-daintree-text/40">Install Daintree</span>
            </div>
            {CHECKLIST_ITEMS.map(
              ({ id, label, description, icon: Icon, actionId, actionArgs, markOnClick }) => {
                const done = items[id];
                const isPopping = poppingItems.has(id);
                const content = (
                  <>
                    <CheckBadge done={done} isPopping={isPopping} onPopEnd={() => clearPop(id)} />
                    <Icon
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        done ? "text-daintree-text/40" : "text-daintree-text/70"
                      )}
                    />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2 min-w-0">
                        <span
                          className={cn(
                            "text-xs leading-snug",
                            done ? "line-through text-daintree-text/40" : "text-text-primary"
                          )}
                        >
                          {label}
                        </span>
                        {!done && <RowShortcut actionId={actionId} />}
                      </span>
                      {description && (
                        <span
                          className={cn(
                            "text-3xs leading-snug",
                            done ? "text-text-placeholder" : "text-text-secondary"
                          )}
                        >
                          {description}
                        </span>
                      )}
                    </div>
                  </>
                );

                const sharedClasses = cn(
                  "flex items-start gap-2.5 rounded-[var(--radius-xs)] px-2 py-1.5",
                  "transition-colors duration-150",
                  done ? "opacity-60" : "opacity-100"
                );

                if (done) {
                  return (
                    <div key={id} data-checklist-item={id} className={sharedClasses}>
                      {content}
                    </div>
                  );
                }

                return (
                  <button
                    key={id}
                    type="button"
                    data-checklist-item={id}
                    onClick={() => {
                      void actionService.dispatch(actionId, actionArgs, {
                        source: "user",
                      });
                      if (markOnClick) onMarkItem?.(id);
                    }}
                    className={cn(
                      sharedClasses,
                      "w-full text-left cursor-pointer",
                      "hover:bg-tint/10",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                    )}
                  >
                    {content}
                  </button>
                );
              }
            )}
            {/* Utility link, deliberately not a checklist milestone — the
                item IDs are persisted completion state, so adding one would
                regress previously completed checklists. */}
            <button
              type="button"
              onClick={() => {
                void actionService.dispatch("help.shortcuts", undefined, { source: "user" });
              }}
              className={cn(
                "w-full text-left px-2 py-1 rounded-[var(--radius-xs)]",
                "text-3xs text-text-secondary transition-colors duration-150",
                "hover:text-text-primary hover:bg-tint/10",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
              )}
            >
              View keyboard shortcuts
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
