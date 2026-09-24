import { Fragment, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { CdpStackFrame, CdpStackTrace } from "@shared/types/ipc/webviewConsole";
import { cn } from "@/lib/utils";
import {
  frameFileName,
  frameFullLocation,
  frameName,
  framePath,
  isLibraryFrame,
  primaryFrame,
  segmentFrames,
} from "./stackFrames";

interface StackTraceProps {
  stackTrace: CdpStackTrace;
  expanded: boolean;
  onToggle: () => void;
}

const TOGGLE_CLASS =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] px-1 -mx-1 text-text-secondary hover:bg-overlay-soft hover:text-text-primary transition-colors duration-150 ease-out select-none";

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      data-animated-chevron
      aria-hidden="true"
      className={cn(
        "w-3 h-3 shrink-0 transition-transform duration-150 ease-out",
        expanded && "rotate-90"
      )}
    />
  );
}

/** A path that wraps at its separators before it ever breaks a name. */
function BreakablePath({ path }: { path: string }) {
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
    </>
  );
}

function FrameRow({ frame }: { frame: CdpStackFrame }) {
  const path = framePath(frame);
  const library = isLibraryFrame(frame);
  return (
    <li className="flex flex-wrap gap-x-2 min-w-0">
      <span className={library ? "text-text-secondary" : "text-text-primary"}>
        {frameName(frame)}
      </span>
      {path ? (
        <span
          className="min-w-0 wrap-break-word text-text-secondary"
          title={frameFullLocation(frame)}
        >
          <BreakablePath path={path} />:{frame.lineNumber}:{frame.columnNumber}
        </span>
      ) : (
        <span className="italic text-text-secondary">source unavailable</span>
      )}
    </li>
  );
}

function LibraryRun({ frames }: { frames: CdpStackFrame[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const listId = useId();
  return (
    <li>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-controls={listId}
        className={TOGGLE_CLASS}
      >
        <Chevron expanded={isOpen} />
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
 * The top frame's file and line, for the message line itself — so where a
 * message came from reads without expanding anything.
 */
export function StackLocation({ stackTrace }: { stackTrace: CdpStackTrace }) {
  const frame = primaryFrame(stackTrace.callFrames);
  if (!frame) return null;
  return (
    <span
      className="ml-auto min-w-0 max-w-full truncate text-text-secondary select-none"
      title={frameFullLocation(frame)}
    >
      {frameFileName(frame)}:{frame.lineNumber}
    </span>
  );
}

export function StackTrace({ stackTrace, expanded: isExpanded, onToggle }: StackTraceProps) {
  const listId = useId();
  const frames = stackTrace.callFrames;

  if (frames.length === 0) return null;

  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={listId}
        className={TOGGLE_CLASS}
      >
        <Chevron expanded={isExpanded} />
        Stack trace
        <span className="text-text-secondary">
          <span aria-hidden="true">· </span>
          <span className="sr-only">, </span>
          {frames.length} {frames.length === 1 ? "frame" : "frames"}
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
              <LibraryRun key={segment.start} frames={segment.frames.map((x) => x.frame)} />
            )
          )}
      </ol>
    </div>
  );
}
