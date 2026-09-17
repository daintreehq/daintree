import { useState, type Ref } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderClock, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { FindCodexSessionAction } from "@/components/Terminal/FindCodexSessionAction";
import { getAgentConfig } from "@/config/agents";
import { usePanelStore } from "@/store/panelStore";
import {
  launchFromRestoreRecovery,
  type RestoreRecoveryChoice,
  type RestoreRecoveryLaunchResult,
} from "@/services/terminal/restoreRecoveryLaunch";
import { isPtyPanel, type RestoreRecoveryReason } from "@shared/types/panel";

interface RecoveryCopy {
  title: string;
  description: string;
}

// Says what restore saw and what is left to choose. Never "lost": the
// conversation is still there, restore just wouldn't guess which one it was.
const REASON_COPY: Record<RestoreRecoveryReason, RecoveryCopy> = {
  "sibling-owns-session-id": {
    title: "Conversation already open in another pane",
    description:
      "Another pane restored this conversation, so this one waited instead of opening it twice. Pick a conversation for this pane, or start a new one.",
  },
  "sibling-owns-resume-latest-slot": {
    title: "Choose this pane's conversation",
    description:
      "Several panes began in the same folder without a saved conversation, so restore couldn't tell which one was this pane's.",
  },
  "session-unresolved": {
    title: "Choose this pane's conversation",
    description:
      "This pane now works in another worktree and had no saved conversation, so restore couldn't name it safely.",
  },
  "destination-unavailable": {
    title: "Choose how this pane continues",
    description: "Resume its conversation or start a new one.",
  },
};

const AWAITING_DESTINATION_COPY: RecoveryCopy = {
  title: "Worktree no longer available",
  description:
    "This pane's worktree isn't part of this project anymore, so it hasn't started. Move it onto a worktree, or keep the folder it began in.",
};

const OUTCOME_MESSAGES: Partial<Record<RestoreRecoveryLaunchResult, RecoveryCopy>> = {
  "held-elsewhere": {
    title: "Conversation already open",
    description: "Another pane is using that conversation. Pick a different one.",
  },
  unavailable: {
    title: "Couldn't start this pane",
    description: "The pane changed while it was starting. Try again.",
  },
};

function FolderRow({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-xs">
      <dt className="shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-text-primary" title={path}>
        {path}
      </dd>
    </div>
  );
}

export interface RestoreRecoveryGateProps {
  panelId: string;
  /** The pane's focus handler moves keyboard focus into this surface. */
  containerRef?: Ref<HTMLDivElement>;
}

/**
 * The in-pane surface of a pane restore held instead of launching (#12434).
 *
 * Nothing here runs on its own: no picker opens and nothing takes focus on
 * mount, so a restart that holds several panes doesn't stack prompts. Every
 * way out is an explicit choice — resume the conversation restore already
 * knew, pick one from the folder it began in, or start a new one where the
 * pane now runs.
 */
export function RestoreRecoveryGate({ panelId, containerRef }: RestoreRecoveryGateProps) {
  const { recovery, agentId, cwd, conversationCwd } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[panelId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      return {
        recovery: pty?.restoreRecovery,
        agentId: pty?.launchAgentId,
        cwd: pty?.cwd ?? "",
        conversationCwd: pty?.conversationCwd,
      };
    })
  );
  const confirmDestination = usePanelStore((state) => state.confirmRestoreRecoveryDestination);
  const [isLaunching, setIsLaunching] = useState(false);
  const [outcome, setOutcome] = useState<RestoreRecoveryLaunchResult | null>(null);

  if (!recovery) return null;

  const agentName = (agentId && getAgentConfig(agentId)?.name) || agentId || "Agent";
  const awaitingDestination = recovery.awaitingDestination === true;
  const copy = awaitingDestination ? AWAITING_DESTINATION_COPY : REASON_COPY[recovery.reason];
  const originCwd = conversationCwd || cwd;
  const outcomeMessage = outcome ? OUTCOME_MESSAGES[outcome] : undefined;

  const launch = async (choice: RestoreRecoveryChoice): Promise<RestoreRecoveryLaunchResult> => {
    setIsLaunching(true);
    setOutcome(null);
    try {
      const result = await launchFromRestoreRecovery(panelId, choice);
      if (result !== "launched") setOutcome(result);
      return result;
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="flex-1 min-h-0 bg-surface-canvas flex flex-col items-center overflow-auto"
    >
      <div className="my-auto w-full max-w-lg space-y-4 px-6 py-8">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-default flex items-center justify-center">
            <FolderClock className="w-4 h-4 text-text-secondary" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{copy.title}</h2>
            <p className="text-xs text-text-secondary">{agentName} hasn't started in this pane</p>
          </div>
        </div>

        <p className="text-xs text-text-secondary">{copy.description}</p>

        <dl className="space-y-1">
          <FolderRow label="Conversation folder" path={originCwd} />
          {!awaitingDestination && <FolderRow label="Runs in" path={cwd} />}
        </dl>

        {outcomeMessage && (
          <InlineStatusBanner
            severity="warning"
            icon={FolderClock}
            title={outcomeMessage.title}
            description={outcomeMessage.description}
            role="status"
            ariaLive="polite"
          />
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {awaitingDestination ? (
            <Button size="sm" variant="outline" onClick={() => confirmDestination(panelId)}>
              Keep original folder
            </Button>
          ) : (
            <>
              <FindCodexSessionAction
                panelId={panelId}
                variant="gate"
                onOpenSession={(sessionId) => launch({ kind: "resume", sessionId })}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={isLaunching}
                onClick={() => void launch({ kind: "fresh" })}
              >
                <Play aria-hidden="true" />
                Start new session
              </Button>
              {recovery.sessionId !== undefined && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isLaunching}
                  onClick={() => {
                    const sessionId = recovery.sessionId;
                    if (sessionId !== undefined) void launch({ kind: "resume", sessionId });
                  }}
                >
                  <RotateCcw aria-hidden="true" />
                  Resume session
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
