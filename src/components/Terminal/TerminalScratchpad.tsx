import { useEffect, useId, useRef, useState } from "react";
import { PanelRightClose } from "lucide-react";
import { NotebookPen } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { flushPanelPersistence } from "@/store/slices";
import { isPtyPanel } from "@shared/types/panel";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import {
  SCRATCHPAD_DEFAULT_WIDTH,
  SCRATCHPAD_MAX_CHARS,
  SCRATCHPAD_MAX_WIDTH,
  SCRATCHPAD_MIN_WIDTH,
  SCRATCHPAD_RESIZE_STEP,
  SCRATCHPAD_RESIZE_STEP_COARSE,
  clampScratchpadWidth,
  SCRATCHPAD_BOUNDARY_ATTR,
  SCRATCHPAD_COUNT_THRESHOLD,
} from "@/lib/terminalScratchpad";

interface TerminalScratchpadProps {
  terminalId: string;
}

/**
 * A terminal's Scratchpad (#12835): a Markdown notes column on the right of the
 * pane. Renders nothing until opened from the header's overflow menu, and
 * nothing while collapsed — the header owns the expand control then.
 *
 * Never takes focus on its own: opening, expanding and resizing leave the
 * keyboard where it was, and only a click into the editor moves it.
 */
export function TerminalScratchpad({ terminalId }: TerminalScratchpadProps) {
  const scratchpad = usePanelStore((state) => {
    const panel = state.panelsById[terminalId];
    return panel && isPtyPanel(panel) ? panel.scratchpad : undefined;
  });
  const setScratchpadContent = usePanelStore((state) => state.setScratchpadContent);
  const setScratchpadWidth = usePanelStore((state) => state.setScratchpadWidth);
  const collapseScratchpad = usePanelStore((state) => state.collapseScratchpad);

  const columnId = useId();
  const editorId = useId();
  const hintId = useId();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const columnRef = useRef<HTMLElement>(null);
  // Cleared synchronously when a gesture ends, before the unlock, so a rearm
  // frame already queued cannot take the lock back after release.
  const gestureActiveRef = useRef(false);
  const isDragging = dragWidth !== null;

  // Resize ownership, mirroring the two-pane split: the terminal's grid is held
  // for the whole gesture and settles once, rather than refitting the PTY on
  // every pointer move.
  useEffect(() => {
    if (!isDragging) return;
    let rafId = 0;
    const rearm = () => {
      if (!gestureActiveRef.current) return;
      terminalInstanceService.lockResize(terminalId, true);
      rafId = requestAnimationFrame(rearm);
    };
    rafId = requestAnimationFrame(rearm);
    return () => cancelAnimationFrame(rafId);
  }, [isDragging, terminalId]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  // The half-pane cap, tracked so the separator announces the width actually
  // on screen and the range a drag can actually reach.
  const [paneCap, setPaneCap] = useState<number | null>(null);
  const isOpen = scratchpad !== undefined && !scratchpad.collapsed;
  useEffect(() => {
    const pane = columnRef.current?.parentElement;
    if (!isOpen || !pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const paneWidth = entry?.contentRect.width ?? 0;
      setPaneCap(paneWidth > 0 ? Math.floor(paneWidth / 2) : null);
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [isOpen]);

  const committedWidth = scratchpad?.width ?? SCRATCHPAD_DEFAULT_WIDTH;
  const width = dragWidth ?? committedWidth;
  const reachableMax = Math.min(SCRATCHPAD_MAX_WIDTH, paneCap ?? Infinity);
  const reachableMin = Math.min(SCRATCHPAD_MIN_WIDTH, reachableMax);
  const shownWidth = Math.round(Math.min(width, reachableMax));

  // The column is capped at half the pane, so a resize works from the width
  // actually on screen and never asks for more than the pane can show —
  // otherwise part of the drag moves nothing.
  const measure = (): { rendered: number; max: number } => {
    const column = columnRef.current;
    const pane = column?.parentElement?.getBoundingClientRect().width ?? 0;
    const rendered = column?.getBoundingClientRect().width || committedWidth;
    const max = pane > 0 ? Math.floor(pane / 2) : Infinity;
    return { rendered, max };
  };
  // The half-pane cap wins over the column minimum: in a pane only just wide
  // enough for its terminal, the minimum would otherwise fight the cap the
  // column renders at, and no drag could move it.
  const clampToPane = (next: number, max: number) => Math.min(clampScratchpadWidth(next), max);

  const handleResizeStart = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.detail > 1) return;
    e.preventDefault();
    const startX = e.clientX;
    const { rendered: startWidth, max } = measure();
    const owner = terminalId;
    let latest = startWidth;
    let moved = false;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;

    const finish = (commit: boolean) => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleBlur);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      dragCleanupRef.current = null;
      if (!moved) return;
      gestureActiveRef.current = false;
      if (commit) setScratchpadWidth(owner, latest);
      setDragWidth(null);
      terminalInstanceService.lockResize(owner, false);
      terminalInstanceService.runResizePass([owner]);
    };
    // The column sits on the right, so dragging its left edge leftwards widens it.
    const handleMouseMove = (ev: MouseEvent) => {
      if (ev.buttons === 0) {
        finish(true);
        return;
      }
      if (!moved) {
        if (Math.abs(ev.clientX - startX) <= 3) return;
        moved = true;
        gestureActiveRef.current = true;
        // Before the first width write, so no frame publishes mid-gesture geometry.
        terminalInstanceService.lockResize(owner, true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }
      latest = clampToPane(startWidth - (ev.clientX - startX), max);
      setDragWidth(latest);
    };
    const handleMouseUp = () => finish(true);
    const handleBlur = () => finish(true);

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", handleBlur);
    dragCleanupRef.current = () => finish(false);
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? SCRATCHPAD_RESIZE_STEP_COARSE : SCRATCHPAD_RESIZE_STEP;
    const { rendered, max } = measure();
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = rendered + step;
        break;
      case "ArrowRight":
        next = rendered - step;
        break;
      case "Home":
        next = SCRATCHPAD_MIN_WIDTH;
        break;
      case "End":
        next = SCRATCHPAD_MAX_WIDTH;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    setScratchpadWidth(terminalId, clampToPane(next, max));
  };

  if (!scratchpad || scratchpad.collapsed) return null;

  // One label for both outcomes: with notes the header keeps an expand
  // control, without them there is nothing left to bring back.
  const hideLabel = "Hide scratchpad";

  const nearLimit = scratchpad.content.length >= SCRATCHPAD_COUNT_THRESHOLD;

  return (
    <aside
      ref={columnRef}
      id={columnId}
      {...{ [SCRATCHPAD_BOUNDARY_ATTR]: terminalId }}
      aria-label="Scratchpad"
      data-testid="terminal-scratchpad"
      className="group/scratchpad relative flex min-h-0 shrink-0 flex-col border-l border-border-default bg-surface-panel"
      // Capped at half the pane so the terminal always keeps the larger share.
      style={{ width, maxWidth: "50%" }}
    >
      <div
        role="separator"
        aria-label="Resize scratchpad"
        aria-orientation="vertical"
        aria-controls={columnId}
        aria-valuenow={shownWidth}
        aria-valuemin={reachableMin}
        aria-valuemax={reachableMax}
        aria-valuetext={`${shownWidth} pixels wide`}
        tabIndex={0}
        data-testid="terminal-scratchpad-resize"
        className={cn(
          "group absolute -left-1.5 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center",
          "transition-colors outline-hidden focus-visible:bg-overlay-medium focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
          // Hover styling is off while resizing, or it outranks the drag state.
          isDragging ? "bg-overlay-medium" : "hover:bg-overlay-soft"
        )}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setScratchpadWidth(terminalId, SCRATCHPAD_DEFAULT_WIDTH)}
        onKeyDown={handleResizeKeyDown}
      >
        <div
          className={cn(
            "h-8 rounded-full transition-[width] delay-100 duration-150",
            isDragging
              ? "w-0.5 bg-text-primary/50"
              : "w-px bg-text-primary/20 group-hover:w-0.5 group-hover:bg-text-primary/35 group-focus-visible:w-0.5 group-focus-visible:bg-text-primary/50"
          )}
        />
      </div>

      {/* The title bar lifts while the notes are being written — the caret
          plus this lift is the editor's focus cue, in place of a ring. */}
      <SurfaceHeader
        density="compact"
        className={cn(
          "gap-2 bg-overlay-subtle transition-colors duration-150 ease-out",
          "group-has-[textarea:focus-visible]/scratchpad:border-border-strong group-has-[textarea:focus-visible]/scratchpad:bg-overlay-medium"
        )}
      >
        <label
          htmlFor={editorId}
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs font-medium text-text-secondary transition-colors duration-150 ease-out",
            "group-has-[textarea:focus-visible]/scratchpad:text-text-primary"
          )}
        >
          <NotebookPen aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">Scratchpad</span>
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="-mr-1.5 [&_svg]:size-3.5"
              aria-label={hideLabel}
              data-testid="terminal-scratchpad-collapse"
              onClick={(e) => {
                e.stopPropagation();
                collapseScratchpad(terminalId);
              }}
            >
              <PanelRightClose aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{hideLabel}</TooltipContent>
        </Tooltip>
      </SurfaceHeader>

      <textarea
        id={editorId}
        aria-describedby={hintId}
        spellCheck={false}
        maxLength={SCRATCHPAD_MAX_CHARS}
        placeholder="Write a note…"
        className={cn(
          "block min-h-0 w-full flex-1 resize-none border-0 bg-transparent px-3 py-2",
          "font-mono text-xs leading-5 text-text-primary placeholder:text-text-secondary",
          // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the title bar lifts via group-has-[textarea:focus-visible]; a ring here would trace the pane's own edges
          "outline-hidden"
        )}
        value={scratchpad.content}
        onChange={(e) => setScratchpadContent(terminalId, e.target.value)}
        // The save is debounced; leaving the editor is a natural point to
        // write the last keystrokes out rather than wait on the timer.
        onBlur={() => flushPanelPersistence()}
        data-testid="terminal-scratchpad-editor"
      />

      <div
        className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border-default px-3 text-2xs text-text-secondary"
        data-testid="terminal-scratchpad-status"
      >
        <span id={hintId} className="truncate">
          Deleted with this terminal
        </span>
        {nearLimit && (
          <span className="shrink-0 tabular-nums" data-testid="terminal-scratchpad-count">
            {scratchpad.content.length.toLocaleString()} / {SCRATCHPAD_MAX_CHARS.toLocaleString()}
          </span>
        )}
      </div>
    </aside>
  );
}
