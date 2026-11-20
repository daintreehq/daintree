import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { STATE_COLORS, STATE_ICONS, STATE_LABELS } from "@/components/Worktree/terminalStateConfig";
import { decisionsClient } from "@/clients/decisionsClient";
import { useSkeletonDisplayFloor, useSkeletonGate } from "@/hooks/useDeferredLoading";
import { cn } from "@/lib/utils";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type {
  DecisionQuestionPane,
  DecisionQuestionPaneResult,
  DecisionQuestionReference,
} from "@shared/types/decisionsQuestion";

type PaneRead =
  | { state: "reading"; last: DecisionQuestionPaneResult | null }
  | { state: "read"; result: DecisionQuestionPaneResult }
  | { state: "failed" };

const WAITING_FOR: Record<WaitingReason, string> = {
  prompt: "at its prompt",
  question: "on a question",
  approval: "for approval",
  error: "on an error",
};

/**
 * A short word for the live region on how a read came out, so a screen reader
 * hears it without the terminal's lines, which stay in their own labelled box.
 */
function outcomeText(read: PaneRead | null): string {
  if (read === null || read.state === "reading") return "";
  if (read.state === "failed") return "The terminal couldn't be read";
  switch (read.result.result) {
    case "read":
      return "Recent terminal output read";
    case "closed":
      return "Terminal closed";
    case "moved":
      return "The answer was moved to another terminal";
    case "needs-update":
      return "The Remote Host needs updating";
    case "host-not-connected":
      return "The Remote Host isn't connected";
    case "off":
    case "not-running":
      return "Decisions isn't running";
    case "unreadable":
    case "not-found":
      return "The terminal couldn't be read";
  }
}

function isAgentState(state: string): state is AgentState {
  return Object.hasOwn(STATE_LABELS, state);
}

function isWaitingReason(reason: string | null): reason is WaitingReason {
  return reason !== null && Object.hasOwn(WAITING_FOR, reason);
}

/** What the pane's machine observed of its agent, in its own words: never more than it saw. */
function observedStateText(pane: Pick<DecisionQuestionPane, "agentState" | "waitingReason">) {
  if (!isAgentState(pane.agentState)) return "Agent state not observed";
  const reason =
    pane.agentState === "waiting" && isWaitingReason(pane.waitingReason)
      ? ` ${WAITING_FOR[pane.waitingReason]}`
      : "";
  return `Agent ${STATE_LABELS[pane.agentState]}${reason}`;
}

/**
 * The asking pane, on demand (#18037): its observed agent state and its
 * screen's newest lines, read on the machine that owns it each time it is
 * opened or refreshed, and never otherwise. Collapsed, it reads nothing.
 * Read-only: nothing here reaches the pane. Mounted once per question shown,
 * so another question, or another opening, starts collapsed.
 */
export function DecisionAskingPane({ reference }: { reference: DecisionQuestionReference }) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<PaneRead | null>(null);
  // Rises with each read and each collapse, so only the newest read lands, and none after a collapse.
  const turn = useRef(0);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();

  useEffect(
    () => () => {
      turn.current += 1;
    },
    []
  );

  const readPane = (last: DecisionQuestionPaneResult | null) => {
    const mine = ++turn.current;
    setRead({ state: "reading", last });
    decisionsClient.getQuestionPaneByReference(reference).then(
      (result) => {
        if (mine === turn.current) setRead({ state: "read", result });
      },
      () => {
        if (mine === turn.current) setRead({ state: "failed" });
      }
    );
  };

  const toggle = () => {
    if (open) {
      turn.current += 1;
      setRead(null);
      setOpen(false);
      return;
    }
    setOpen(true);
    readPane(null);
  };

  const reading = read?.state === "reading";
  const shown = read?.state === "read" ? read.result : read?.state === "reading" ? read.last : null;
  const gated = useSkeletonGate(reading && shown === null);
  const showSkeleton = useSkeletonDisplayFloor(gated);
  const refresh = () => {
    if (!reading) readPane(shown);
  };
  // A Retry goes with the result it sat in: the keyboard waits on Refresh, which stays.
  const retry = () => {
    refreshRef.current?.focus({ preventScroll: true });
    refresh();
  };

  return (
    <section
      className="flex flex-col items-start gap-2"
      aria-label="The asking terminal"
      data-testid="decision-asking-pane"
    >
      <div className="-ml-2 flex items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={toggle}
          data-testid="decision-asking-pane-toggle"
        >
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          )}
          Recent terminal output
        </Button>
        {open && (
          <Button
            ref={refreshRef}
            variant="ghost"
            size="xs"
            aria-disabled={reading || undefined}
            onClick={refresh}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            data-testid="decision-asking-pane-refresh"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </Button>
        )}
      </div>
      {open && (
        <div id={bodyId} className="flex w-full flex-col gap-2">
          {/* A skeleton once shown keeps its floor, rather than tearing down in the frame it came. */}
          {showSkeleton ? (
            <Skeleton label="Reading the terminal" className="flex flex-col gap-2">
              <SkeletonBone className="h-3 w-1/3" />
              <SkeletonBone className="h-24 w-full" />
            </Skeleton>
          ) : read?.state === "failed" ? (
            <Unreadable onRetry={retry} />
          ) : (
            shown !== null && <PaneResult result={shown} onRetry={retry} />
          )}
        </div>
      )}
      {/* Mounted while open, so each outcome is announced as it changes. */}
      {open && (
        <p role="status" className="sr-only">
          {outcomeText(read)}
        </p>
      )}
    </section>
  );
}

function PaneResult({
  result,
  onRetry,
}: {
  result: DecisionQuestionPaneResult;
  onRetry: () => void;
}) {
  switch (result.result) {
    case "read":
      return <PaneView pane={result.pane} />;
    case "closed":
      return <Note testId="decision-asking-pane-closed">Terminal closed</Note>;
    case "moved":
      return (
        <Note testId="decision-asking-pane-moved">
          The answer was moved to another terminal, so the one that asked can&apos;t be shown
        </Note>
      );
    case "needs-update":
      return (
        <Callout severity="info" size="compact" data-testid="decision-asking-pane-needs-update">
          Update the Remote Host to see its terminal output here.
        </Callout>
      );
    case "host-not-connected":
      return (
        <Callout
          severity="warning"
          size="compact"
          action={<RetryButton onRetry={onRetry} />}
          data-testid="decision-asking-pane-host-away"
        >
          The Remote Host that asked isn&apos;t connected.
        </Callout>
      );
    case "off":
    case "not-running":
      return (
        <Callout
          severity="warning"
          size="compact"
          action={<RetryButton onRetry={onRetry} />}
          data-testid="decision-asking-pane-not-running"
        >
          Decisions isn&apos;t running, so the terminal can&apos;t be read.
        </Callout>
      );
    case "unreadable":
    case "not-found":
      return <Unreadable onRetry={onRetry} />;
  }
}

/** When the pane was read, as a clock time: it is a still, which an age would have to keep ticking. */
function readAtText(observedAt: string): string | null {
  const at = new Date(observedAt);
  if (Number.isNaN(at.getTime())) return null;
  return `Read at ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
}

function PaneView({ pane }: { pane: DecisionQuestionPane }) {
  const known = isAgentState(pane.agentState) ? pane.agentState : null;
  const readAt = readAtText(pane.observedAt);
  const Glyph = known === null ? null : STATE_ICONS[known];
  return (
    <div className="flex w-full flex-col gap-1.5" data-testid="decision-asking-pane-view">
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-text-secondary">
        {Glyph !== null && known !== null && (
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            <Glyph className={cn("size-3", STATE_COLORS[known])} />
          </span>
        )}
        <span className="text-text-primary" data-testid="decision-asking-pane-state">
          {observedStateText(pane)}
        </span>
        {pane.paneTitle !== "" && (
          <>
            <FactSeparator />
            <span className="min-w-0 truncate" data-testid="decision-asking-pane-title">
              {pane.paneTitle}
            </span>
          </>
        )}
        {readAt !== null && (
          <>
            <FactSeparator />
            <time
              dateTime={pane.observedAt}
              className="tabular-nums"
              data-testid="decision-asking-pane-read-at"
            >
              {readAt}
            </time>
          </>
        )}
      </p>
      {pane.lines.length === 0 ? (
        <Note testId="decision-asking-pane-empty">Nothing on screen</Note>
      ) : (
        <pre
          // Its own stop, so the keyboard scrolls lines wider or longer than the box.
          tabIndex={0}
          aria-label="Recent terminal lines"
          className="max-h-72 w-full overflow-auto rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2 font-mono text-xs leading-4 whitespace-pre text-text-primary"
          data-testid="decision-asking-pane-lines"
        >
          {pane.lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

function Note({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p className="text-xs text-text-secondary [text-wrap:pretty]" data-testid={testId}>
      {children}
    </p>
  );
}

function Unreadable({ onRetry }: { onRetry: () => void }) {
  return (
    <Callout
      severity="warning"
      size="compact"
      action={<RetryButton onRetry={onRetry} />}
      data-testid="decision-asking-pane-unreadable"
    >
      The terminal couldn&apos;t be read.
    </Callout>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="outline" size="xs" onClick={onRetry}>
      Retry
    </Button>
  );
}
