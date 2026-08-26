import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Network } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { formatTimeAgo } from "@/utils/timeAgo";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { codexClient } from "@/clients/codexClient";
import { useCodexSubagents } from "@/hooks/useCodexSubagents";
import {
  codexUnavailableMessage,
  subagentStatusLabel,
  subagentStatusTone,
  subagentSubtitle,
  subagentTitle,
} from "./codexSubagentDisplay";
import type {
  CodexSubagent,
  CodexSubagentTranscriptResult,
} from "@shared/types/ipc/codexSubagents";

const TONE_CLASSES: Record<"error" | "active" | "muted", string> = {
  error: "text-status-error",
  active: "text-status-info",
  muted: "text-daintree-text/40",
};

function TranscriptBody({
  transcript,
  onRetry,
}: {
  transcript: CodexSubagentTranscriptResult;
  onRetry: () => void;
}) {
  if (transcript.status === "unavailable") {
    return (
      <div className="flex flex-col items-start gap-1">
        <p className="text-xs text-daintree-text/50">
          {codexUnavailableMessage(transcript.reason)}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="text-xs text-daintree-text/70 hover:text-daintree-text underline underline-offset-2 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }
  if (transcript.turns.length === 0) {
    return <p className="text-xs text-daintree-text/50">No turns recorded yet</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {transcript.turns.map((turn) => (
        <div key={turn.turnId} className="flex flex-col gap-1">
          {turn.messages.map((message, index) => (
            <div key={`${turn.turnId}-${index}`} className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-daintree-text/40">
                {message.role === "user" ? "Task" : "Reply"}
              </span>
              <p className="text-xs text-daintree-text/80 whitespace-pre-wrap break-words">
                {message.text}
              </p>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SubagentRow({ terminalId, subagent }: { terminalId: string; subagent: CodexSubagent }) {
  const [isOpen, setIsOpen] = useState(false);
  const [transcript, setTranscript] = useState<CodexSubagentTranscriptResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // The child's `updatedAt` at the moment we last fetched. Holding the version
  // rather than a boolean is what makes a child that ran again reload instead
  // of showing turns from before its latest run.
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const showSpinner = useDohertyGate(isLoading);
  const subtitle = subagentSubtitle(subagent);
  const tone = subagentStatusTone(subagent.status);
  const panelId = `codex-subagent-${subagent.threadId}`;

  const load = useCallback(() => {
    if (isLoading) return;
    setIsLoading(true);
    setLoadedFor(subagent.updatedAt);
    void codexClient
      .readSubagentTranscript({ terminalId, threadId: subagent.threadId })
      .then(setTranscript)
      .catch((error: unknown) => {
        logWarn(
          `[CodexSubagentChip] transcript read failed: ${formatErrorMessage(error, "unknown error")}`
        );
        setTranscript({ status: "unavailable", reason: "protocol-error" });
      })
      .finally(() => setIsLoading(false));
  }, [isLoading, terminalId, subagent.threadId, subagent.updatedAt]);

  // Fetch on expand, and again if the child has run since we last looked.
  // Driving this from state rather than the click handler is what keeps an
  // already-open row from going blank when its version changes.
  useEffect(() => {
    if (!isOpen || loadedFor === subagent.updatedAt) return;
    load();
  }, [isOpen, loadedFor, subagent.updatedAt, load]);

  // Clearing the version is the retry: the effect above sees the mismatch and
  // refetches, so there is one load path rather than two.
  const retry = useCallback(() => setLoadedFor(null), []);

  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <li className="border-b border-divider last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-overlay-subtle transition-colors"
      >
        <Chevron className="w-3 h-3 mt-0.5 shrink-0 text-daintree-text/40" aria-hidden="true" />
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="text-xs font-medium text-daintree-text truncate">
              {subagentTitle(subagent)}
            </span>
            <span className={cn("text-[10px] shrink-0", TONE_CLASSES[tone])}>
              {subagentStatusLabel(subagent.status)}
            </span>
          </span>
          {subtitle && (
            <span className="text-[11px] text-daintree-text/50 truncate">{subtitle}</span>
          )}
        </span>
        {subagent.updatedAt > 0 && (
          <span className="text-[10px] text-daintree-text/35 shrink-0 mt-0.5 tabular-nums">
            {formatTimeAgo(subagent.updatedAt)}
          </span>
        )}
      </button>
      <div
        id={panelId}
        role="region"
        aria-label={`${subagentTitle(subagent)} transcript`}
        hidden={!isOpen}
        className="px-3 pb-3 pl-8"
      >
        {isOpen &&
          (transcript === null ? (
            showSpinner ? (
              <span className="flex items-center gap-2 text-xs text-daintree-text/50" role="status">
                <Spinner size="sm" />
                Loading transcript
              </span>
            ) : null
          ) : (
            <TranscriptBody transcript={transcript} onRetry={retry} />
          ))}
      </div>
    </li>
  );
}

/**
 * Read-only list of the subagent threads a Codex session spawned, hung off the
 * terminal's own header rather than a floating overlay — the bottom-right
 * corner of a pane already belongs to `ArtifactOverlay` and the fleet pill, and
 * a Codex TUI is full-height, so a footer strip would cost it rows.
 *
 * Renders nothing until a query actually finds children, so a Codex terminal
 * that never delegates never grows an affordance. Nothing here can steer a
 * child: the protocol reports these threads as parent-owned, and Daintree only
 * ever reads them.
 */
export function CodexSubagentChip({ terminalId }: { terminalId: string }) {
  const { isCodex, agentState, hasPty, generation } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[terminalId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      return {
        // Live detection wins, but launch affinity keeps the chip alive across
        // a restore before detection rehydrates.
        isCodex: pty?.runtimeIdentity?.agentId === "codex" || pty?.launchAgentId === "codex",
        agentState: pty?.agentState,
        hasPty: pty?.hasPty !== false,
        // Distinguishes a respawn from the process that held this panel id
        // before it, so a reused pane can't inherit the old session's list.
        generation: pty?.startedAt,
      };
    })
  );

  const enabled = isCodex && hasPty;
  const { result, isLoading, refresh } = useCodexSubagents(terminalId, {
    enabled,
    agentState,
    generation,
  });

  if (!enabled || result?.status !== "ok" || result.subagents.length === 0) return null;

  const { subagents } = result;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs font-sans bg-overlay-soft text-daintree-text/60 px-1.5 py-0.5 rounded border border-divider hover:text-daintree-text transition-colors"
          aria-label={`${subagents.length} Codex subagent${subagents.length === 1 ? "" : "s"}`}
        >
          <Network className="w-3 h-3" aria-hidden="true" />
          <span className="tabular-nums">{subagents.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
          <span className="text-xs font-medium text-daintree-text">Codex subagents</span>
          <button
            type="button"
            onClick={refresh}
            disabled={isLoading}
            className="text-daintree-text/40 hover:text-daintree-text transition-colors disabled:opacity-50 disabled:pointer-events-none"
            aria-label="Refresh subagents"
          >
            <RefreshCw className={cn("w-3 h-3", isLoading && "animate-spin")} aria-hidden="true" />
          </button>
        </div>
        <ul className="max-h-80 overflow-y-auto">
          {subagents.map((subagent) => (
            <SubagentRow key={subagent.threadId} terminalId={terminalId} subagent={subagent} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
