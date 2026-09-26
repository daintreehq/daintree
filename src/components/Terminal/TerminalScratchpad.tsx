import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  scratchpadHasContent,
} from "@/lib/terminalScratchpad";

/** DOM boundary the pane's focus handoff checks before pulling focus back to the terminal. */
export const SCRATCHPAD_BOUNDARY_ATTR = "data-terminal-scratchpad";

export function isScratchpadElement(element: Element | null | undefined): boolean {
  return !!element?.closest(`[${SCRATCHPAD_BOUNDARY_ATTR}]`);
}

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

  const editorId = useId();
  const hintId = useId();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const isDragging = dragWidth !== null;

  // Resize ownership, mirroring the two-pane split: the terminal's grid is held
  // for the whole gesture and settles once, rather than refitting the PTY on
  // every pointer move.
  useEffect(() => {
    if (!isDragging) return;
    let rafId = 0;
    const rearm = () => {
      terminalInstanceService.lockResize(terminalId, true);
      rafId = requestAnimationFrame(rearm);
    };
    rafId = requestAnimationFrame(rearm);
    return () => cancelAnimationFrame(rafId);
  }, [isDragging, terminalId]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const committedWidth = scratchpad?.width ?? SCRATCHPAD_DEFAULT_WIDTH;
  const width = dragWidth ?? committedWidth;

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || e.detail > 1) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = committedWidth;
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
        if (commit) setScratchpadWidth(terminalId, latest);
        setDragWidth(null);
        terminalInstanceService.lockResize(terminalId, false);
        terminalInstanceService.runResizePass([terminalId]);
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
          // Before the first width write, so no frame publishes mid-gesture geometry.
          terminalInstanceService.lockResize(terminalId, true);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }
        latest = clampScratchpadWidth(startWidth - (ev.clientX - startX));
        setDragWidth(latest);
      };
      const handleMouseUp = () => finish(true);
      const handleBlur = () => finish(true);

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("blur", handleBlur);
      dragCleanupRef.current = () => finish(false);
    },
    [committedWidth, setScratchpadWidth, terminalId]
  );

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? SCRATCHPAD_RESIZE_STEP_COARSE : SCRATCHPAD_RESIZE_STEP;
      let next: number;
      switch (e.key) {
        case "ArrowLeft":
          next = committedWidth + step;
          break;
        case "ArrowRight":
          next = committedWidth - step;
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
      setScratchpadWidth(terminalId, next);
    },
    [committedWidth, setScratchpadWidth, terminalId]
  );

  if (!scratchpad || scratchpad.collapsed) return null;

  const hasContent = scratchpadHasContent(scratchpad);
  const collapseLabel = hasContent ? "Collapse scratchpad" : "Close scratchpad";

  return (
    <aside
      {...{ [SCRATCHPAD_BOUNDARY_ATTR]: "" }}
      aria-label="Scratchpad"
      data-testid="terminal-scratchpad"
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border-default bg-surface-panel"
      // Capped at half the pane so the terminal always keeps the larger share.
      style={{ width, maxWidth: "50%" }}
    >
      <div
        role="separator"
        aria-label="Resize scratchpad"
        aria-orientation="vertical"
        aria-controls={editorId}
        aria-valuenow={Math.round(width)}
        aria-valuemin={SCRATCHPAD_MIN_WIDTH}
        aria-valuemax={SCRATCHPAD_MAX_WIDTH}
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

      <div className="flex shrink-0 items-start gap-2 px-3 pt-2 pb-1.5">
        <div className="min-w-0 flex-1">
          <label htmlFor={editorId} className="block text-xs font-medium text-text-primary">
            Scratchpad
          </label>
          <p id={hintId} className="text-xs text-text-secondary">
            Temporary notes, deleted with this terminal
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="-mr-1 [&_svg]:size-3.5"
              aria-label={collapseLabel}
              data-testid="terminal-scratchpad-collapse"
              onClick={(e) => {
                e.stopPropagation();
                collapseScratchpad(terminalId);
              }}
            >
              <PanelRightClose aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{collapseLabel}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <Textarea
          id={editorId}
          aria-describedby={hintId}
          variant="code"
          density="compact"
          resize="none"
          spellCheck={false}
          maxLength={SCRATCHPAD_MAX_CHARS}
          placeholder={
            "A command to run next, something to check when it finishes…\n\nMarkdown works here."
          }
          className="min-h-0 flex-1 leading-5"
          value={scratchpad.content}
          onChange={(e) => setScratchpadContent(terminalId, e.target.value)}
          // The save is debounced; leaving the editor is a natural point to
          // write the last keystrokes out rather than wait on the timer.
          onBlur={() => flushPanelPersistence()}
          data-testid="terminal-scratchpad-editor"
        />
      </div>
    </aside>
  );
}
