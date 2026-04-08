import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import type { ChecklistState, ChecklistItemId } from "@shared/types/ipc/maps";
import { CHECKLIST_ITEMS } from "./checklistItems";

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

  useEffect(() => {
    const rafId = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(rafId);
  }, []);

  const completedCount = Object.values(checklist.items).filter(Boolean).length;
  const totalCount = CHECKLIST_ITEMS.length;

  return createPortal(
    <div
      className={cn(
        "fixed bottom-4 z-[var(--z-toast)] pointer-events-none p-4",
        "flex justify-end w-full max-w-[320px]"
      )}
      style={{ right: "calc(var(--portal-right-offset, 0px))" }}
    >
      <div
        className={cn(
          "pointer-events-auto relative w-full",
          "rounded-[var(--radius-sm)] border",
          "text-sm text-canopy-text",
          "shadow-[var(--theme-shadow-floating)]",
          "transition-[transform,opacity] duration-300 ease-out",
          isVisible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
          "bg-[color-mix(in_oklab,var(--color-canopy-accent)_8%,var(--color-canopy-bg))]",
          "border-[color:color-mix(in_oklab,var(--color-canopy-accent)_20%,transparent)]",
          "backdrop-blur-sm"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5">
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex items-center gap-2 text-left flex-1 min-w-0"
          >
            <h4 className="font-medium leading-tight tracking-tight text-xs font-mono text-canopy-accent">
              Getting Started
            </h4>
            <span className="text-[10px] text-canopy-text/50 font-mono tabular-nums">
              {completedCount}/{totalCount}
            </span>
            {collapsed ? (
              <ChevronUp className="h-3 w-3 text-canopy-text/50 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 text-canopy-text/50 shrink-0" />
            )}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss checklist"
            className={cn(
              "rounded-[var(--radius-xs)]",
              "h-6 w-6 flex items-center justify-center shrink-0",
              "text-canopy-text/60 transition-colors",
              "hover:text-canopy-text/90 hover:bg-tint/10",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Collapsible body */}
        <div
          className={cn(
            "overflow-hidden transition-[height] duration-300 ease-in-out",
            collapsed ? "h-0" : "h-auto"
          )}
          {...(collapsed ? { inert: true } : {})}
        >
          <div className="px-3 pb-3 space-y-1.5">
            {CHECKLIST_ITEMS.map(
              ({ id, label, description, icon: Icon, actionId, actionArgs, markOnClick }) => {
                const done = checklist.items[id];
                const content = (
                  <>
                    <div
                      className={cn(
                        "h-4 w-4 rounded-full border flex items-center justify-center shrink-0 transition-colors duration-200",
                        done ? "bg-canopy-accent border-canopy-accent" : "border-canopy-text/30"
                      )}
                    >
                      {done && <Check className="h-2.5 w-2.5 text-canopy-bg" />}
                    </div>
                    <Icon
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        done ? "text-canopy-text/40" : "text-canopy-text/70"
                      )}
                    />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span
                        className={cn(
                          "text-xs leading-snug",
                          done ? "line-through text-canopy-text/40" : "text-canopy-text/90"
                        )}
                      >
                        {label}
                      </span>
                      {description && (
                        <span
                          className={cn(
                            "text-[10px] leading-snug",
                            done ? "text-canopy-text/30" : "text-canopy-text/50"
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
                  "transition-colors duration-200",
                  done ? "opacity-60" : "opacity-100"
                );

                if (done) {
                  return (
                    <div key={id} className={sharedClasses}>
                      {content}
                    </div>
                  );
                }

                return (
                  <button
                    key={id}
                    type="button"
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
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
                    )}
                  >
                    {content}
                  </button>
                );
              }
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
