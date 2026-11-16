import { useLayoutEffect, useRef, useState } from "react";
import type { WorktreeLifecycleStatus } from "@shared/types/worktree";
import { stripAnsiAndOscCodes } from "@shared/utils/urlUtils";
import { ChevronRight } from "lucide-react";
import { FactRun } from "@/components/ui/FactSeparator";
import { useWallClock } from "@/hooks/useWallClock";
import { cn } from "@/lib/utils";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";

/** Marks where focus goes when a run's body leaves while holding it. */
const LIFECYCLE_FOCUS_RETURN_ATTR = "data-lifecycle-focus-return";

// Within this many pixels of the end, the log counts as following it.
const FOLLOW_SLACK_PX = 8;

/** Until the elapsed label next changes: every second for a minute, then every minute. */
function nextElapsedDelay(elapsedMs: number): number {
  const step = elapsedMs < 60_000 ? 1_000 : 60_000;
  return step - (elapsedMs % step);
}

/**
 * How long the running command has been running, or how long the whole run
 * took once it has settled. Ticks only while the run is running.
 */
function useRunElapsed(status: WorktreeLifecycleStatus): number {
  const running = status.state === "running";
  const since = (running ? status.commandStartedAt : undefined) ?? status.startedAt;
  const now = useWallClock(`${since}:${running}`, (at) =>
    running ? nextElapsedDelay(at - since) : null
  );
  return (running ? now : (status.completedAt ?? now)) - since;
}

/** The name a run's output region is read out by. */
function outputLabel(status: WorktreeLifecycleStatus): string {
  if (status.phase === "setup") return "Setup output";
  if (status.phase === "teardown") return "Teardown output";
  return "Resource command output";
}

function commandProgress(status: WorktreeLifecycleStatus): string | undefined {
  const { commandIndex, totalCommands } = status;
  if (commandIndex === undefined || !totalCommands) return undefined;
  return `Command ${commandIndex + 1} of ${totalCommands}`;
}

/** Which command of how many, and for how long, after whatever `lead` names. */
export function LifecycleRunFacts({
  status,
  lead,
}: {
  status: WorktreeLifecycleStatus;
  lead?: string;
}) {
  const elapsed = formatElapsedDuration(useRunElapsed(status));
  const progress = status.state === "running" ? commandProgress(status) : undefined;
  const facts = [lead, progress, elapsed].filter((fact): fact is string => !!fact);
  return <FactRun facts={facts} />;
}

/**
 * Output as a terminal would have left it: escape sequences dropped, and a
 * line rewritten in place with carriage returns (a progress bar) shown as its
 * last state rather than every state run together.
 */
function displayOutput(output: string): string {
  return stripAnsiAndOscCodes(output)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const trimmed = line.replace(/\r+$/, "");
      return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
    })
    .join("\n");
}

/**
 * A command run's output. Opens at its end and follows new output while the
 * reader stays there; scrolling up to read earlier lines stops it following
 * until they scroll back down. Not a live region: a streaming log read aloud
 * line by line would drown everything else out.
 */
export function LifecycleOutputLog({
  output,
  label,
  className,
}: {
  output: string;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const followingRef = useRef(true);
  const text = displayOutput(output);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      tabIndex={0}
      role="region"
      aria-label={label}
      onScroll={(event) => {
        const el = event.currentTarget;
        followingRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
      }}
      className={cn(
        "max-h-32 overflow-auto rounded-[var(--radius-md)] p-2 font-mono text-2xs text-text-secondary whitespace-pre-wrap break-all select-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
        className
      )}
    >
      {text}
    </pre>
  );
}

/**
 * What a running command run is doing: the command, and what it has printed so
 * far. It goes the moment the run settles, so a reader focused in it is handed
 * to the nearest ancestor marked {@link LIFECYCLE_FOCUS_RETURN_ATTR}, when
 * there is one, rather than to <body>.
 */
export function LifecycleRunBody({ status }: { status: WorktreeLifecycleStatus }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const output = status.output ?? "";

  // Found through the DOM, which is in place when this runs; an ancestor's ref
  // mounting in the same commit is not attached yet. Layout cleanup runs before
  // React detaches the node, so the containment check still sees the focus.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const fallback = root?.parentElement?.closest<HTMLElement>(`[${LIFECYCLE_FOCUS_RETURN_ATTR}]`);
    if (!root || !fallback) return;
    return () => {
      if (root.contains(document.activeElement)) fallback.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-1.5">
      {status.currentCommand && (
        // An inline script can run to kilobytes; it scrolls rather than
        // pushing the output out of reach.
        <code className="max-h-[4lh] overflow-y-auto font-mono text-2xs text-text-primary break-all">
          {status.currentCommand}
        </code>
      )}
      {output.trim() ? (
        <LifecycleOutputLog
          output={output}
          label={outputLabel(status)}
          className="bg-overlay-subtle"
        />
      ) : (
        <span className="text-text-secondary">No output yet</span>
      )}
    </div>
  );
}

/**
 * The card's way into a run: a disclosure whose closed row already answers
 * "is it moving" (which command, for how long), opening onto the run's output.
 * Its body only renders while open, so a closed card never lays out a log that
 * changes twice a second.
 */
export function LifecycleRunDisclosure({
  status,
  label,
  className,
}: {
  status: WorktreeLifecycleStatus;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const running = status.state === "running";
  const output = status.output ?? "";
  return (
    <details
      // Reading, selecting or double-clicking in it never selects or folds the
      // card it sits on.
      data-card-control=""
      className={cn("group/run-log text-xs", className)}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      {/* Its own control: a click opens the log, never also selects the card
          underneath. */}
      <summary
        onClick={(event) => event.stopPropagation()}
        className="flex min-h-6 min-w-0 items-center gap-1 rounded-[var(--radius-xs)] text-text-secondary cursor-pointer select-none transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
      >
        <ChevronRight
          className="w-3 h-3 shrink-0 transition-transform duration-150 group-open/run-log:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">
          {running ? <LifecycleRunFacts status={status} lead={label} /> : label}
        </span>
      </summary>
      {open && (
        <div className="mt-1.5">
          {running ? (
            <LifecycleRunBody status={status} />
          ) : (
            <LifecycleOutputLog
              output={output}
              label={outputLabel(status)}
              className="bg-overlay-subtle"
            />
          )}
        </div>
      )}
    </details>
  );
}
