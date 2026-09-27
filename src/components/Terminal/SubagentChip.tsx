import { useCallback, useEffect, useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Network } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Spinner } from "@/components/ui/Spinner";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { formatTimeAgo } from "@/utils/timeAgo";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { SUBAGENT_PROVIDERS, toSubagentProvider } from "@/clients/subagentProviders";
import { useSubagents } from "@/hooks/useSubagents";
import {
  subagentAttentionRank,
  subagentStatusLabel,
  subagentStatusTone,
  subagentSubtitle,
  subagentTitle,
  subagentUnavailableMessage,
} from "./subagentDisplay";
import type {
  AgentSubagent,
  AgentSubagentTranscriptResult,
  SubagentProvider,
} from "@shared/types/ipc/agentSubagents";
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";

const TONE_CLASSES: Record<"error" | "waiting" | "muted", string> = {
  error: "text-status-error",
  waiting: "text-state-waiting",
  muted: "text-text-secondary",
};

/** The header's own control ring (see `PanelHeader`), so the chip focuses like its neighbours. */
const CHIP_FOCUS_CLASS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary";

/**
 * Children that need the user first, the provider's order otherwise. Sorting
 * is stable, and the list only changes when a lookup answers, so nothing moves
 * under the pointer while the popover is being read.
 */
function byAttention(subagents: AgentSubagent[]): AgentSubagent[] {
  return subagents
    .map((subagent, index) => ({ subagent, index }))
    .sort(
      (a, b) =>
        subagentAttentionRank(a.subagent.status) - subagentAttentionRank(b.subagent.status) ||
        a.index - b.index
    )
    .map(({ subagent }) => subagent);
}

function TranscriptBody({
  transcript,
  provider,
  onRetry,
}: {
  transcript: AgentSubagentTranscriptResult;
  provider: SubagentProvider;
  onRetry: () => void;
}) {
  if (transcript.status === "unavailable") {
    return (
      <div className="flex flex-col items-start gap-1">
        <p className="text-xs text-text-secondary">
          {subagentUnavailableMessage(transcript.reason, SUBAGENT_PROVIDERS[provider].label)}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "rounded-sm text-xs text-text-secondary hover:text-text-primary underline underline-offset-2 transition-colors",
            CHIP_FOCUS_CLASS
          )}
        >
          Retry
        </button>
      </div>
    );
  }
  if (transcript.messages.length === 0) {
    return <p className="text-xs text-text-secondary">No messages recorded yet</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {transcript.truncated && (
        <p className="text-3xs text-text-placeholder">Showing the latest messages</p>
      )}
      {transcript.messages.map((message, index) => (
        <div key={`${transcript.subagentId}-${index}`} className="flex flex-col gap-0.5">
          <span className="text-3xs uppercase tracking-wider text-text-secondary">
            {message.role === "task" ? "Task" : "Reply"}
          </span>
          <p className="text-xs text-text-primary whitespace-pre-wrap break-words">
            {message.text}
          </p>
        </div>
      ))}
    </div>
  );
}

function SubagentRow({
  terminalId,
  provider,
  subagent,
}: {
  terminalId: string;
  provider: SubagentProvider;
  subagent: AgentSubagent;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [transcript, setTranscript] = useState<AgentSubagentTranscriptResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // The child's `updatedAt` at the moment we last fetched. Holding the version
  // rather than a boolean is what makes a child that ran again reload instead
  // of showing messages from before its latest run.
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const showSpinner = useDeferredLoading(isLoading, UI_INLINE_LOADING_GATE_MS);
  const subtitle = subagentSubtitle(subagent);
  const tone = subagentStatusTone(subagent.status);
  const panelId = `subagent-${terminalId}-${provider}-${subagent.id}`;

  const load = useCallback(() => {
    if (isLoading) return;
    setIsLoading(true);
    setLoadedFor(subagent.updatedAt);
    void SUBAGENT_PROVIDERS[provider]
      .readTranscript({ terminalId, subagentId: subagent.id })
      .then(setTranscript)
      .catch((error: unknown) => {
        logWarn(
          `[SubagentChip] transcript read failed: ${formatErrorMessage(error, "unknown error")}`
        );
        setTranscript({
          status: "unavailable",
          reason: SUBAGENT_PROVIDERS[provider].fallbackReason,
        });
      })
      .finally(() => setIsLoading(false));
  }, [isLoading, provider, terminalId, subagent.id, subagent.updatedAt]);

  // Fetch on expand, and again if the child has run since we last looked.
  // Driving this from state rather than the click handler is what keeps an
  // already-open row from going blank when its version changes.
  useEffect(() => {
    if (!isOpen || loadedFor === subagent.updatedAt) return;
    load();
  }, [isOpen, loadedFor, subagent.updatedAt, load]);

  // Clearing the version is the retry: the effect above sees the mismatch and
  // refetches, so there is one load path rather than two.
  // The failed answer is dropped with it, so the retry shows its own progress
  // rather than leaving the old error standing while the read runs.
  const retry = useCallback(() => {
    setTranscript(null);
    setLoadedFor(null);
  }, []);

  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <li className="border-b border-divider last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className={cn(
          "w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-overlay-subtle transition-colors",
          PALETTE_ROW_FOCUS_CLASS
        )}
      >
        <Chevron className="w-3 h-3 mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
        {/* Two lines, two columns: what the child is on the left, what state
            it is in and when on the right, so the status sits in one column
            the eye can run down whatever each name's length. */}
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="flex items-baseline gap-3">
            <span className="flex-1 min-w-0 text-xs font-medium text-text-primary truncate">
              {subagentTitle(subagent)}
            </span>
            <span className={cn("shrink-0 text-2xs font-medium", TONE_CLASSES[tone])}>
              {subagentStatusLabel(subagent.status)}
            </span>
          </span>
          {(subtitle || subagent.updatedAt > 0) && (
            <span className="flex items-baseline gap-3">
              <span className="flex-1 min-w-0 text-2xs text-text-secondary truncate">
                {subtitle}
              </span>
              {subagent.updatedAt > 0 && (
                <span className="shrink-0 text-3xs text-text-secondary tabular-nums">
                  {formatTimeAgo(subagent.updatedAt)}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      {/* No `role="region"`: a landmark per expanded child floods the
          landmark list once a few are open, and `aria-controls` already ties
          each panel to its row. */}
      <div id={panelId} hidden={!isOpen} className="px-3 pb-3 pl-8">
        {isOpen && (
          <>
            {showSpinner && (
              <span
                className="mb-2 flex items-center gap-2 text-xs text-text-secondary"
                role="status"
              >
                <Spinner size="sm" />
                {transcript === null ? "Loading transcript" : "Loading newer messages"}
              </span>
            )}
            {transcript !== null && (
              <TranscriptBody transcript={transcript} provider={provider} onRetry={retry} />
            )}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Read-only list of the child sessions this terminal's agent spawned, hung off
 * the terminal's own header rather than a floating overlay — the bottom-right
 * corner of a pane already belongs to `ArtifactOverlay` and the fleet pill, and
 * an agent TUI is full-height, so a footer strip would cost it rows.
 *
 * One component for every provider that can report children. Renders nothing
 * until a query actually finds some, so a terminal that never delegates never
 * grows an affordance. Nothing here can steer a child: both providers are read
 * paths, and there is no way in from this UI.
 */
export function SubagentChip({ terminalId }: { terminalId: string }) {
  const { provider, agentState, hasPty, generation } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[terminalId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      return {
        // Live detection wins, with launch affinity as the fallback so the chip
        // survives a restore until detection rehydrates. Precedence rather than
        // a union: a pane relaunched onto another agent must not keep answering
        // for the one it was launched as.
        provider: toSubagentProvider(pty?.runtimeIdentity?.agentId ?? pty?.launchAgentId),
        agentState: pty?.agentState,
        hasPty: pty?.hasPty !== false,
        // Distinguishes a respawn from the process that held this panel id
        // before it, so a reused pane can't inherit the old session's list.
        generation: pty?.startedAt,
      };
    })
  );

  const active = hasPty ? provider : null;
  const headingId = useId();
  const { result, isLoading, refresh, refreshError } = useSubagents(terminalId, {
    provider: active,
    agentState,
    generation,
  });

  // The provider check is belt-and-braces over the hook's own key guard: a list
  // read from one agent's store must never be rendered as another's.
  if (!active || result?.status !== "ok" || result.provider !== active) return null;
  if (result.subagents.length === 0) return null;

  const subagents = byAttention(result.subagents);
  const label = SUBAGENT_PROVIDERS[result.provider].label;
  const count = subagents.length;
  const waiting = subagents.filter((subagent) => subagent.status.type === "blocked").length;
  const summary = `${count} ${label} subagent${count === 1 ? "" : "s"}`;
  const waitingNote = waiting > 0 ? `${waiting} waiting on you` : null;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1 shrink-0 text-xs font-sans bg-overlay-soft px-1.5 py-0.5 rounded-full border border-divider hover:text-text-primary transition-colors",
                // The chip borrows the waiting hue only while a child is
                // blocked on the user — the one thing worth seeing from the
                // header without opening anything.
                waiting > 0 ? "text-state-waiting" : "text-text-secondary",
                CHIP_FOCUS_CLASS
              )}
              aria-label={waitingNote ? `${summary}, ${waitingNote}` : summary}
            >
              <Network className="w-3 h-3" aria-hidden="true" />
              <span className="tabular-nums">{count}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{summary}</span>
            <span>{waitingNote ? `${waitingNote}. Click to review.` : "Click to review."}</span>
          </div>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-0" aria-labelledby={headingId}>
        <div className="flex items-center justify-between gap-2 pl-3 pr-1.5 py-1.5 border-b border-divider">
          <span id={headingId} className="text-xs font-medium text-text-primary">
            {label} subagents
          </span>
          <button
            type="button"
            onClick={() => {
              if (!isLoading) refresh();
            }}
            // Not `disabled`: that would drop keyboard focus to the page the
            // moment the button is pressed. The spin is the busy state.
            aria-disabled={isLoading}
            className={cn(
              "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-secondary hover:bg-overlay-soft hover:text-text-primary transition-colors",
              CHIP_FOCUS_CLASS
            )}
            aria-label="Refresh subagents"
          >
            <SpinningIcon icon={RefreshCw} active={isLoading} className="w-3.5 h-3.5" aria-hidden />
          </button>
        </div>
        {/* Always mounted, so a failed refresh is announced when it lands. */}
        <div role="status" aria-live="polite">
          {refreshError && (
            <p className="px-3 py-2 border-b border-divider text-2xs text-text-secondary">
              Couldn't refresh: {subagentUnavailableMessage(refreshError, label)}. Showing the last
              list.
            </p>
          )}
        </div>
        <ScrollShadow compact className="max-h-80">
          <ul>
            {subagents.map((subagent) => (
              <SubagentRow
                key={`${result.provider}:${subagent.id}`}
                terminalId={terminalId}
                provider={result.provider}
                subagent={subagent}
              />
            ))}
          </ul>
        </ScrollShadow>
      </PopoverContent>
    </Popover>
  );
}
