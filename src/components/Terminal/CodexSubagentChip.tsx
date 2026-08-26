import { useCallback, useState } from "react";
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

function TranscriptBody({ transcript }: { transcript: CodexSubagentTranscriptResult }) {
  if (transcript.status === "unavailable") {
    return (
      <p className="text-xs text-daintree-text/50">{codexUnavailableMessage(transcript.reason)}</p>
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
  const showSpinner = useDohertyGate(isLoading);
  const subtitle = subagentSubtitle(subagent);
  const tone = subagentStatusTone(subagent.status);

  const toggle = useCallback(() => {
    const next = !isOpen;
    setIsOpen(next);
    if (!next || transcript !== null || isLoading) return;
    setIsLoading(true);
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
  }, [isOpen, isLoading, transcript, terminalId, subagent.threadId]);

  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <li className="border-b border-divider last:border-b-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
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
      {isOpen && (
        <div className="px-3 pb-3 pl-8">
          {transcript === null ? (
            showSpinner ? (
              <Spinner size="sm" />
            ) : null
          ) : (
            <TranscriptBody transcript={transcript} />
          )}
        </div>
      )}
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
  const { isCodex, agentState, hasPty } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[terminalId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      return {
        // Live detection wins, but launch affinity keeps the chip alive across
        // a restore before detection rehydrates.
        isCodex: pty?.runtimeIdentity?.agentId === "codex" || pty?.launchAgentId === "codex",
        agentState: pty?.agentState,
        hasPty: pty?.hasPty !== false,
      };
    })
  );

  const enabled = isCodex && hasPty;
  const { result, isLoading, refresh } = useCodexSubagents(terminalId, { enabled, agentState });

  if (!enabled || result?.status !== "ok" || result.subagents.length === 0) return null;

  const { subagents, candidates } = result;

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
        {candidates.length > 0 && (
          // Correlation is by folder plus recency, so a second Codex session in
          // the same worktree makes the parent a guess. Say so rather than
          // present another session's children as this terminal's.
          <p className="px-3 py-2 text-[11px] text-status-warning border-b border-divider">
            More than one Codex session ran here, so this list is a best guess
          </p>
        )}
        <ul className="max-h-80 overflow-y-auto">
          {subagents.map((subagent) => (
            <SubagentRow key={subagent.threadId} terminalId={terminalId} subagent={subagent} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
