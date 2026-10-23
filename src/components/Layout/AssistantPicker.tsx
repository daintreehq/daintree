import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isFullAgentDirectory } from "@shared/types/agentDirectory";
import { cn } from "@/lib/utils";
import { useAgentDirectory } from "@/hooks/useAgentDirectory";
import { useProjectStore } from "@/store/projectStore";
import { useCanopyStore } from "@/store/canopyStore";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import { assistantStatus, buildAssistantItems } from "@/components/Canopy/canopyAssistants";
import {
  assistantBand,
  canopyAssistantDomId,
  openAssistantItem,
} from "@/components/Canopy/openAssistantItem";

/**
 * The live Daintree Assistants on this machine, to go to one: the same
 * directory and "Open in Assistant" Canopy uses, and none of Canopy's reading,
 * so it works whether Canopy is on or not. Opening it lists; only choosing an
 * assistant moves anything, and that never starts or resumes a session.
 */
export function AssistantPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const directory = useAgentDirectory(open);
  const projects = useProjectStore((s) => s.projects);
  const seen = useCanopyStore((s) => s.assistantHandbacksSeen);
  const seeHandback = useCanopyStore((s) => s.seeAssistantHandback);
  const items = useMemo(() => {
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return buildAssistantItems(directory, {
      projectName: (id) => names.get(id) ?? null,
      seen,
    });
  }, [directory, projects, seen]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId)
  );
  const active = items[activeIndex] ?? null;
  // The list arrives after the popover has opened and placed focus on itself:
  // the keyboard moves into it then, unless the person has gone elsewhere.
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hasList = items.length > 0;
  useEffect(() => {
    if (!hasList) return;
    const root =
      rootRef.current?.closest<HTMLElement>("[data-radix-popper-content-wrapper]") ??
      rootRef.current;
    const focused = document.activeElement;
    if (focused === null || focused === document.body || (root?.contains(focused) ?? false)) {
      listRef.current?.focus({ preventScroll: true });
    }
  }, [hasList]);

  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    setRefusal(null);
    // Seen only once it is in front of the person: a refused open shows nothing.
    void openAssistantItem(item).then((refused) => {
      if (refused !== null) {
        setRefusal(refused);
        return;
      }
      if (item.handbackAt !== null) seeHandback(item.id, item.handbackAt);
      onClose();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(items.length - 1, activeIndex + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, activeIndex - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next !== null) {
      event.preventDefault();
      setActiveId(items[next]!.id);
      document
        .getElementById(`picker-${canopyAssistantDomId(items[next]!.id)}`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  const partial = directory !== null && !isFullAgentDirectory(directory);
  return (
    <div ref={rootRef} className="flex w-80 flex-col" data-testid="assistant-picker">
      <div className="px-3 pt-2.5 pb-1.5 text-xs font-medium text-text-secondary">
        Daintree Assistants
      </div>
      {directory === null ? (
        <p className="px-3 pb-3 text-xs text-text-secondary" aria-busy="true">
          &nbsp;
        </p>
      ) : items.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-text-secondary">
          {partial
            ? "Daintree couldn't list every assistant just now."
            : "No assistant is running. Start one from the Assistant panel."}
        </p>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Daintree Assistants"
          aria-activedescendant={active ? `picker-${canopyAssistantDomId(active.id)}` : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- focus is shown on the active option (aria-activedescendant), which always carries the highlight
          className="flex max-h-80 flex-col overflow-y-auto pb-1.5 outline-hidden"
        >
          {items.map((item, index) => (
            <div
              key={item.id}
              id={`picker-${canopyAssistantDomId(item.id)}`}
              role="option"
              aria-selected={index === activeIndex}
              data-ask={item.ask ?? undefined}
              onPointerMove={() => setActiveId(item.id)}
              onClick={() => choose(index)}
              className={cn(
                "mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5",
                index === activeIndex && "bg-overlay-highlight"
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                <PilotRunState
                  band={assistantBand(item)}
                  agentState={item.agentState ?? undefined}
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm leading-5 text-text-primary">
                  {item.scopeLabel}
                </span>
                <span
                  className={cn(
                    "truncate text-xs leading-4",
                    item.ask ? "text-text-primary" : "text-text-secondary"
                  )}
                >
                  {[assistantStatus(item), item.agentName].filter(Boolean).join(" · ")}
                </span>
              </span>
            </div>
          ))}
          {partial && (
            <p className="px-3 pt-1 text-xs text-text-secondary">
              Some assistants may be missing from this list.
            </p>
          )}
        </div>
      )}
      {refusal !== null && (
        <p
          role="status"
          className="border-t border-border-default px-3 py-2 text-xs text-text-primary"
        >
          {refusal}
        </p>
      )}
    </div>
  );
}
