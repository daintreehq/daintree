import { Fragment, useId } from "react";
import type { CdpStackFrame, CdpStackTrace } from "@shared/types/ipc/webviewConsole";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DisclosureChevron } from "./DisclosureChevron";
import {
  frameFileName,
  frameName,
  framePath,
  isLibraryFrame,
  primaryFrame,
  segmentFrames,
} from "./stackFrames";
import { pluralize } from "@/lib/pluralize";
import { useRowFocusTooltip } from "./rowFocusTooltip";

interface StackTraceProps {
  stackTrace: CdpStackTrace;
  expanded: boolean;
  /** First-frame indexes of the library runs the user has opened. */
  openRuns: readonly number[];
  onToggle: () => void;
  onToggleRun: (start: number) => void;
}

/** The console's disclosure toggle: stacks, library runs and group headers. */
export const DISCLOSURE_TOGGLE_CLASS =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] px-1 -mx-1 text-text-secondary hover:bg-overlay-soft hover:text-text-primary transition-colors duration-150 ease-out select-none";

/**
 * A path that wraps at its separators before it ever breaks a name, and keeps
 * its `:line:column` in one piece: a column number alone on a line reads as
 * part of the next frame.
 */
function BreakablePath({ path, line, column }: { path: string; line: number; column: number }) {
  const parts = path.split("/");
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
      <wbr />
      <span className="whitespace-nowrap">
        :{line}:{column}
      </span>
    </>
  );
}

function FrameRow({ frame }: { frame: CdpStackFrame }) {
  const path = framePath(frame);
  const library = isLibraryFrame(frame);
  return (
    <li className="flex flex-wrap gap-x-2 min-w-0">
      <span
        className={cn(
          "min-w-0 wrap-anywhere",
          library ? "text-text-secondary" : "text-text-primary"
        )}
      >
        {frameName(frame)}
      </span>
      {path ? (
        <span className="min-w-0 wrap-break-word text-text-secondary">
          <BreakablePath path={path} line={frame.lineNumber} column={frame.columnNumber} />
        </span>
      ) : (
        <span className="italic text-text-secondary">source unavailable</span>
      )}
    </li>
  );
}

function LibraryRun({
  frames,
  isOpen,
  onToggle,
}: {
  frames: CdpStackFrame[];
  isOpen: boolean;
  onToggle: () => void;
}) {
  const listId = useId();
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={listId}
        className={DISCLOSURE_TOGGLE_CLASS}
      >
        <DisclosureChevron expanded={isOpen} />
        {frames.length} library frames
      </button>
      <ol id={listId} hidden={!isOpen}>
        {frames.map((frame, i) => (
          <FrameRow key={i} frame={frame} />
        ))}
      </ol>
    </li>
  );
}

/**
 * The source of a message: filename and line, with the full path in a tooltip.
 * The row owns the keyboard, so the tooltip opens on the pointer or with the
 * row's keyboard focus rather than adding a tab stop, and the row keeps one
 * shape either way. Assistive tech gets the full location as text.
 */
export function StackLocation({ stackTrace }: { stackTrace: CdpStackTrace }) {
  const tooltip = useRowFocusTooltip();
  const frame = primaryFrame(stackTrace.callFrames);
  if (!frame) return null;
  const full = `${framePath(frame)}:${frame.lineNumber}:${frame.columnNumber}`;
  return (
    <span className="ml-auto flex min-w-0 max-w-full text-text-secondary select-none">
      <span className="sr-only">Source: {full}</span>
      <Tooltip open={tooltip.open} onOpenChange={tooltip.onOpenChange}>
        <TooltipTrigger asChild>
          {/* Only the filename gives way in a narrow pane; the line number is
              the part of the answer that can't be recovered anywhere else. */}
          <span aria-hidden="true" className="flex min-w-0" {...tooltip.triggerProps}>
            <span className="min-w-0 truncate">{frameFileName(frame)}</span>
            <span className="shrink-0">:{frame.lineNumber}</span>
          </span>
        </TooltipTrigger>
        {/* Below the source, so a tooltip opened by keyboard focus never covers
            the message being read. A path has no spaces to wrap at, so it may
            break anywhere. */}
        <TooltipContent side="bottom" align="end" className="wrap-anywhere">
          {full}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

export function StackTrace({
  stackTrace,
  expanded: isExpanded,
  openRuns,
  onToggle,
  onToggleRun,
}: StackTraceProps) {
  const listId = useId();
  const frames = stackTrace.callFrames;

  if (frames.length === 0) return null;

  return (
    // A 24px-tall target: an expandable object argument can sit directly on
    // the message line above, so the spacing exception can't be relied on
    // (WCAG 2.5.8).
    <div className="mt-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={listId}
        className={cn(DISCLOSURE_TOGGLE_CLASS, "min-h-6")}
      >
        <DisclosureChevron expanded={isExpanded} />
        Stack trace
        <span className="text-text-secondary">
          <span aria-hidden="true">· </span>
          <span className="sr-only">, </span>
          {pluralize(frames.length, "frame")}
        </span>
      </button>
      <ol
        id={listId}
        hidden={!isExpanded}
        className="mt-0.5 ml-1.5 pl-3 border-l border-overlay select-text"
      >
        {isExpanded &&
          segmentFrames(frames).map((segment) =>
            segment.kind === "frame" ? (
              <FrameRow key={segment.index} frame={segment.frame} />
            ) : (
              <LibraryRun
                key={segment.start}
                frames={segment.frames.map((x) => x.frame)}
                isOpen={openRuns.includes(segment.start)}
                onToggle={() => onToggleRun(segment.start)}
              />
            )
          )}
      </ol>
    </div>
  );
}
