import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { AssistantPanelView } from "./AssistantPanelView";
import { useAssistantSession } from "./useAssistantSession";
import { useAssistantStore, type AssistantSessionState } from "@/store/assistantStore";

/**
 * The connected assistant panel: binds the store to a live engine session and renders
 * the view.
 *
 * Split from `AssistantPanelView` so the view stays presentational and can be driven
 * from captured state for visual review in every theme. A panel that can only be seen
 * with a live engine mid-turn is a panel nobody checks.
 */

export interface AssistantPanelProps {
  projectId: string | null;
  /** Project root; the engine's working directory. */
  projectPath: string | null;
  /** Shown in the masthead. */
  projectName?: string | null;
  /** False while the panel is closed — the engine is not started. */
  active: boolean;
  /** Bump to tear down the current session and start a fresh one. */
  restartNonce?: number;
  className?: string;
}

export function AssistantPanel({
  projectId,
  projectPath,
  projectName,
  active,
  restartNonce = 0,
  className,
}: AssistantPanelProps) {
  const { submit, interrupt, decideApproval } = useAssistantSession({
    projectId,
    cwd: projectPath,
    enabled: active,
    restartNonce,
  });

  // Select the DATA half of the store. `useShallow` keeps the panel from re-rendering
  // on every action-identity change, and the action functions are stable anyway.
  const state = useAssistantStore(
    useShallow((s) => ({
      sessionId: s.sessionId,
      connection: s.connection,
      engineVersion: s.engineVersion,
      tier: s.tier,
      tierGloss: s.tierGloss,
      backend: s.backend,
      routing: s.routing,
      logFile: s.logFile,
      mcpUnavailable: s.mcpUnavailable,
      autoApprove: s.autoApprove,
      stoppedReason: s.stoppedReason,
      error: s.error,
      turns: s.turns,
      toolCalls: s.toolCalls,
      approvals: s.approvals,
      notices: s.notices,
      phase: s.phase,
      usage: s.usage,
      cost: s.cost,
      rateLimited: s.rateLimited,
      droppedFrames: s.droppedFrames,
    }))
  );

  const snapshot = useMemo<AssistantSessionState>(() => state, [state]);

  return (
    <AssistantPanelView
      state={snapshot}
      projectName={projectName}
      onSubmit={submit}
      onInterrupt={interrupt}
      onDecideApproval={decideApproval}
      className={className}
    />
  );
}
