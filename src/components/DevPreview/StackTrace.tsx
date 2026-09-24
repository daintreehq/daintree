import { Fragment, useId } from "react";
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
  /** First-frame indexes of the library runs the user has opened. */
  openRuns: readonly number[];
  onToggle: () => void;
  onToggleRun: (start: number) => void;
}

const TOGGLE_CLASS =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] px-1 -mx-1 text-text-secondary hover:bg-overlay-soft hover:text-text-primary transition-colors duration-150 ease-out select-none";

/** The console's one disclosure glyph: stacks, library runs, groups, objects. */
export function DisclosureChevron({ expanded }: { expanded: boolean }) {
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
      <span
        className={cn(
          "min-w-0 wrap-anywhere",
          library ? "text-text-secondary" : "text-text-primary"
        )}
      >
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
        className={TOGGLE_CLASS}
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
 * The source of a message, on its own line: filename and line at rest, the
 * full path when the row has keyboard focus — the keyboard's equivalent of
 * the hover title, without adding a tab stop. Assistive tech always gets the
 * full location.
 */
export function StackLocation({ stackTrace }: { stackTrace: CdpStackTrace }) {
  const frame = primaryFrame(stackTrace.callFrames);
  if (!frame) return null;
  const full = `${framePath(frame)}:${frame.lineNumber}:${frame.columnNumber}`;
  return (
    <span
      className="ml-auto flex min-w-0 max-w-full text-text-secondary select-none"
      title={frameFullLocation(frame)}
    >
      <span className="sr-only">Source: {full}</span>
      {/* Only the filename gives way in a narrow pane; the line number is
          the part of the answer that can't be recovered anywhere else. */}
      <span aria-hidden="true" className="flex min-w-0 group-focus-visible/row:hidden">
        <span className="min-w-0 truncate">{frameFileName(frame)}</span>
        <span className="shrink-0">:{frame.lineNumber}</span>
      </span>
      <span
        aria-hidden="true"
        className="hidden min-w-0 wrap-break-word group-focus-visible/row:inline"
      >
        <BreakablePath path={framePath(frame)} />:{frame.lineNumber}:{frame.columnNumber}
      </span>
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
    // mt-1 keeps this target 24px from an expandable object argument on the
    // message line above (WCAG 2.5.8's spacing exception).
    <div className="mt-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={listId}
        className={TOGGLE_CLASS}
      >
        <DisclosureChevron expanded={isExpanded} />
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
