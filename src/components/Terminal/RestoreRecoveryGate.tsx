import { useEffect, useState, type MouseEvent, type PointerEvent, type Ref } from "react";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useShallow } from "zustand/react/shallow";
import { FolderClock, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { FindCodexSessionAction } from "@/components/Terminal/FindCodexSessionAction";
import { getAgentConfig } from "@/config/agents";
import { usePanelStore } from "@/store/panelStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import {
  launchFromRestoreRecovery,
  type RestoreRecoveryChoice,
  type RestoreRecoveryLaunchResult,
} from "@/services/terminal/restoreRecoveryLaunch";
import { isPtyPanel, type RestoreRecoveryReason } from "@shared/types/panel";
import { resolveResumeOnRestart } from "@shared/types/agentSettings";
import { resolveConversationSearchCwd } from "@/utils/restoreRecovery";

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
  "resume-deferred": {
    title: "Not resumed after restart",
    description:
      "Agents wait to be started after a restart, as set in Settings > General > Startup. Resume its conversation or start a new one.",
  },
};

const RESUMES_ON_FOCUS_COPY: RecoveryCopy = {
  title: "Resumes when you focus this pane",
  description:
    "Agents resume one at a time after a restart, as each pane is focused, as set in Settings > General > Startup.",
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
      <TruncatedTooltip content={path}>
        <dd className="min-w-0 truncate font-mono text-text-primary">{path}</dd>
      </TruncatedTooltip>
    </div>
  );
}

// Conversations a focus already tried to resume, so a remount — a maximize, a
// worktree switch, a tab group reusing the pane — never tries again (#13509).
const autoResumeAttempts = new Set<string>();

const autoResumeRequests = new Map<string, () => void>();
// A handoff can land before the surface it is for has subscribed.
const pendingAutoResumeRequests = new Set<string>();

/**
 * The pane's own focus handler calls this when it is handed focus on purpose —
 * a tab switch, a jump to the pane — which the selection alone can't tell
 * apart from a restore picking it.
 */
export function requestRestoreRecoveryAutoResume(panelId: string): void {
  const request = autoResumeRequests.get(panelId);
  if (request) request();
  else pendingAutoResumeRequests.add(panelId);
}

export function __resetRestoreRecoveryAutoResumeForTests(): void {
  autoResumeAttempts.clear();
  autoResumeRequests.clear();
  pendingAutoResumeRequests.clear();
}

function isInsideControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest("button, a, [role='button']") !== null;
}

export interface RestoreRecoveryGateProps {
  panelId: string;
  /** The pane is the selected one. Only a change to it counts as the user's doing. */
  isFocused?: boolean;
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
 *
 * The one exception is a pane the resume setting held (#13509) while it allows
 * resuming: the user turning to it resumes the conversation it carries, once.
 * That is the pane becoming the selected one while this surface is up, the
 * pane being handed focus, or a click on the surface — and it waits until the
 * window has focus and the view is on screen, so a project restoring behind
 * another starts nothing until it is looked at. A pane that is merely on
 * screen, or already selected when the setting changes, starts nothing, and a
 * press on one of the buttons is that button's choice.
 */
export function RestoreRecoveryGate({
  panelId,
  isFocused = false,
  containerRef,
}: RestoreRecoveryGateProps) {
  const { recovery, agentId, cwd, originCwd } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[panelId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      return {
        recovery: pty?.restoreRecovery,
        agentId: pty?.launchAgentId,
        cwd: pty?.cwd ?? "",
        originCwd: pty ? resolveConversationSearchCwd(pty) : "",
      };
    })
  );
  const confirmDestination = usePanelStore((state) => state.confirmRestoreRecoveryDestination);
  const [isLaunching, setIsLaunching] = useState(false);
  const [outcome, setOutcome] = useState<RestoreRecoveryLaunchResult | null>(null);
  // Unknown until the settings load, and unknown never resumes anything.
  const resumePolicy = useAgentSettingsStore((state) =>
    state.isInitialized ? resolveResumeOnRestart(state.settings) : undefined
  );
  const resumesOnFocusId =
    recovery?.reason === "resume-deferred" &&
    !recovery.awaitingDestination &&
    resumePolicy !== undefined &&
    resumePolicy !== "never"
      ? recovery.sessionId
      : undefined;
  const attemptKey =
    resumesOnFocusId !== undefined ? `${panelId}\u0000${resumesOnFocusId}` : undefined;
  // The user turned to this pane; cleared once acted on, or when they turn away.
  const [wantsResume, setWantsResume] = useState(false);
  const [wasFocused, setWasFocused] = useState(isFocused);
  if (isFocused !== wasFocused) {
    setWasFocused(isFocused);
    setWantsResume(isFocused);
  }

  useEffect(() => {
    autoResumeRequests.set(panelId, () => setWantsResume(true));
    if (pendingAutoResumeRequests.delete(panelId)) setWantsResume(true);
    return () => {
      autoResumeRequests.delete(panelId);
    };
  }, [panelId]);

  useEffect(() => {
    if (!wantsResume || attemptKey === undefined || resumesOnFocusId === undefined) return;
    const sessionId = resumesOnFocusId;
    const attempt = () => {
      if (autoResumeAttempts.has(attemptKey)) return;
      if (!isProjectViewObservable() || !document.hasFocus()) return;
      autoResumeAttempts.add(attemptKey);
      setWantsResume(false);
      setIsLaunching(true);
      setOutcome(null);
      void launchFromRestoreRecovery(panelId, { kind: "resume", sessionId })
        .then((result) => {
          if (result !== "launched") setOutcome(result);
        })
        .finally(() => setIsLaunching(false));
    };
    attempt();
    window.addEventListener("focus", attempt);
    const unsubscribe = subscribeProjectViewObservability((observable) => {
      if (observable) attempt();
    });
    return () => {
      window.removeEventListener("focus", attempt);
      unsubscribe();
    };
  }, [wantsResume, attemptKey, resumesOnFocusId, panelId]);

  if (!recovery) return null;

  const agentName = (agentId && getAgentConfig(agentId)?.name) || agentId || "Agent";
  const awaitingDestination = recovery.awaitingDestination === true;
  const copy = awaitingDestination
    ? AWAITING_DESTINATION_COPY
    : resumesOnFocusId !== undefined
      ? RESUMES_ON_FOCUS_COPY
      : REASON_COPY[recovery.reason];
  const outcomeMessage = outcome ? OUTCOME_MESSAGES[outcome] : undefined;

  const launch = (choice: RestoreRecoveryChoice): Promise<RestoreRecoveryLaunchResult> => {
    setIsLaunching(true);
    setOutcome(null);
    return launchFromRestoreRecovery(panelId, choice)
      .then((result) => {
        if (result !== "launched") setOutcome(result);
        return result;
      })
      .finally(() => setIsLaunching(false));
  };

  // A press on a control is a choice of its own, made before the selection the
  // same press causes could start anything.
  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (attemptKey !== undefined && isInsideControl(event.target)) {
      autoResumeAttempts.add(attemptKey);
    }
  };

  const onSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    // Portalled content (an open picker) bubbles here through React too.
    if (!(target instanceof Node) || !event.currentTarget.contains(target)) return;
    if (isInsideControl(target)) return;
    setWantsResume(true);
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onPointerDownCapture={onPointerDownCapture}
      onClick={onSurfaceClick}
      className="flex-1 min-h-0 bg-surface-canvas flex flex-col items-center overflow-auto focus-visible:-outline-offset-2"
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
            <Button
              size="sm"
              variant="contrast"
              onClick={() => confirmDestination(panelId, originCwd)}
            >
              Keep original folder
            </Button>
          ) : (
            <>
              <FindCodexSessionAction
                panelId={panelId}
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
                  variant="contrast"
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
