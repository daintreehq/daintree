import { useCallback, useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { AssistantPanelView } from "./AssistantPanelView";
import { useAssistantSession } from "./useAssistantSession";
import { assistantStoreForSlot, type AssistantSessionState } from "@/store/assistantStore";
import { DEFAULT_ASSISTANT_SLOT } from "@shared/config/assistantSlots";
import type { AssistantReference } from "./AssistantMessage";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { actionService } from "@/services/ActionService";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useAssistantTimerNotificationsFromStore } from "./useAssistantTimerNotifications";

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
  /**
   * Which parallel session (#12108) this panel is.
   *
   * One number decides everything lane-shaped: the engine's state namespace in main,
   * the store the transcript reduces into, and the composer's draft key. Defaults to
   * the lane every install had before parallel sessions existed.
   */
  slot?: number;
  /** Project root; the engine's working directory. */
  projectPath: string | null;
  /** False while the panel is closed — the engine is not started. */
  active: boolean;
  /**
   * Whether the panel is on screen right now.
   *
   * Distinct from `active`, which latches on first open and stays true so the engine
   * survives the panel being dismissed. Anything that costs work per second — the
   * timer countdowns — must key off THIS, because hiding the panel slides it
   * off-canvas rather than unmounting it. Defaults to true so a caller that does not
   * know simply gets the old always-on behaviour.
   */
  visible?: boolean;
  /** Bump to tear down the current session and start a fresh one. */
  restartNonce?: number;
  /**
   * Whether the operations deck is showing.
   *
   * Owned above the panel because the way IN is the panel header's overflow menu, which
   * sits outside this tree. Passed through untouched — the view holds the deck itself,
   * since it replaces the transcript rather than the whole panel.
   */
  operationsOpen?: boolean;
  onOperationsOpenChange?: (open: boolean) => void;
  className?: string;
}

export function AssistantPanel({
  projectId,
  slot = DEFAULT_ASSISTANT_SLOT,
  projectPath,
  active,
  visible = true,
  restartNonce = 0,
  operationsOpen,
  onOperationsOpenChange,
  className,
}: AssistantPanelProps) {
  // This lane's store. Every read and write below goes through it rather than through
  // a module singleton, which is what lets two sessions run side by side without either
  // one's turns, approvals or spend landing in the other's transcript.
  const store = assistantStoreForSlot(slot);

  const {
    submit,
    interrupt,
    decideApproval,
    answerQuestion,
    requestOperations,
    requestTimers,
    cancelTimer,
    retractInterjection,
  } = useAssistantSession({
    projectId,
    cwd: projectPath,
    // The engine boots whenever the panel is open. Whether the account can actually
    // buy a turn is the ENGINE's question to answer, in its own transcript, via
    // `/login` — Daintree no longer reads the account to pre-empt it. Booting costs
    // nothing by itself; only a turn is billable, and no turn runs before the user types.
    enabled: active,
    restartNonce,
    slot,
  });

  // Select the DATA half of the store. `useShallow` keeps the panel from re-rendering
  // on every action-identity change, and the action functions are stable anyway.
  // Recorded then decided, in that order: the grant must exist before the approval is
  // answered, or the next request arrives before there is anything to cover it.
  const grantTool = useCallback(
    (approval: { approvalId: string; grantKey: string }, uses: number) => {
      // The grant covers `uses` calls IN TOTAL, and this approval is the first of
      // them. Storing the full count here and then approving would authorise one more
      // than the button offered.
      const remaining = uses === Number.POSITIVE_INFINITY ? uses : uses - 1;
      if (remaining > 0) store.getState().grantTool(approval.grantKey, remaining);
      decideApproval(approval.approvalId, "approved");
    },
    [decideApproval, store]
  );

  // Stable identity: the store's actions never change, so this cannot re-trigger the
  // composer's drain effect.
  const takeRetractedDraft = useCallback(() => {
    store.getState().takeRetractedDraft();
  }, [store]);

  const state = useStore(
    store,
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
      mcpToolCount: s.mcpToolCount,
      commands: s.commands,
      operations: s.operations,
      timers: s.timers,
      timersStale: s.timersStale,
      pendingFiredTimerIds: s.pendingFiredTimerIds,
      timerCancelPending: s.timerCancelPending,
      timerCancelErrors: s.timerCancelErrors,
      toolGrants: s.toolGrants,
      queuedInterjections: s.queuedInterjections,
      retractedDraft: s.retractedDraft,
      lastActivityAt: s.lastActivityAt,
      turnStartedAt: s.turnStartedAt,
      phaseIsWake: s.phaseIsWake,
      pendingQuestion: s.pendingQuestion,
      awaitingLocalCommand: s.awaitingLocalCommand,
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

  // Mounted here rather than in the view, because the view is replaced by the deck
  // and a timer firing must be announced whether or not anyone is looking at the
  // list. This component lives for the whole armed session.
  useAssistantTimerNotificationsFromStore(requestTimers, store);

  const snapshot = useMemo<AssistantSessionState>(() => state, [state]);

  // Whether issue and PR references in prose become links at all.
  //
  // Resolved HERE rather than in the view, because it is a fact about the project and
  // the view is presentational — and because gating on a real provider is what stops
  // this panel inventing a github.com URL for a project that does not use GitHub. No
  // provider, no recognition: the reference stays plain text rather than becoming a
  // link that goes nowhere.
  const { providerId, loading: forgeLoading } = useResolvedForgeProvider(projectId);
  const forgeAvailable = !forgeLoading && providerId !== null && projectPath !== null;

  // Stable across renders, which the memoized message component depends on: it takes
  // this as a prop and re-renders on every frame of a streaming turn, so a fresh
  // closure each render would defeat the memo boundary that keeps markdown parsing off
  // the per-token path.
  const activateReference = useCallback(
    (reference: AssistantReference) => {
      if (projectPath === null) return;
      // Dispatched through `ActionService` rather than `forgeClient` directly, so the
      // click goes through the same audited, provider-routed path as the same action
      // invoked from a menu or by an agent. Both of these are `danger: "safe"` and both
      // hand off to the system browser — they read, they do not mutate.
      const [actionId, args] =
        reference.kind === "pr"
          ? (["forge.openPR", { cwd: projectPath, prNumber: reference.number }] as const)
          : (["forge.openIssue", { cwd: projectPath, issueNumber: reference.number }] as const);
      // A click that does nothing has to say so — in the PANEL.
      //
      // The user cannot observe this otherwise: the whole visible effect of a working
      // click is a browser window appearing somewhere else, so a failure looks exactly
      // like a link that was never a link.
      //
      // Reported as a panel notice rather than a toast, because everything the assistant
      // does stays inside the assistant. The reader clicked a reference in this
      // transcript; the answer belongs beside it, not on a surface that spans the whole
      // window and outlives the panel it came from. The cost is the one-click recovery
      // a toast could carry, so the message names the route instead.
      //
      // Not for a number that does not exist, though — that resolves fine and the forge
      // serves its own 404 in the browser, which is the forge's answer to give. What
      // reaches here is the provider failing to resolve or the browser failing to open.
      const reportFailure = (detail: unknown) => {
        console.warn("[assistant] could not open the reference", reference, detail);
        const label = reference.kind === "pr" ? "pull request" : "issue";
        const list = reference.kind === "pr" ? "pull requests" : "issues";
        store
          .getState()
          .pushNotice(
            "warning",
            `Couldn't reach the forge to open ${label} #${reference.number}. ` +
              `Check the connection, or open the ${list} list from the toolbar.`
          );
      };
      safeFireAndForget(
        actionService
          .dispatch(actionId, args, { source: "user" })
          .then((result) => {
            // `dispatch` RESOLVES with a result union — it does not reject when the
            // action fails. A bare `.catch` here would therefore have caught only an
            // unexpected throw and let every ordinary failure (NOT_FOUND, a validation
            // error, the action itself throwing) pass silently and invisibly.
            if (result.ok) return;
            reportFailure(result.error);
          })
          .catch(reportFailure)
      );
    },
    [projectPath, store]
  );

  return (
    <AssistantPanelView
      state={snapshot}
      onSubmit={submit}
      onInterrupt={interrupt}
      onDecideApproval={decideApproval}
      onAnswerQuestion={answerQuestion}
      onGrantTool={grantTool}
      onRequestOperations={requestOperations}
      onRequestTimers={requestTimers}
      onCancelTimer={cancelTimer}
      visible={visible}
      operationsOpen={operationsOpen}
      onOperationsOpenChange={onOperationsOpenChange}
      onRetractInterjection={retractInterjection}
      onRetractedDraftConsumed={takeRetractedDraft}
      // The composer's `@` file completion resolves against this. The view has taken a
      // `cwd` since it was written and this container has held `projectPath` the whole
      // time, but the two were never joined — so the prop was `undefined` everywhere
      // except the preview harness, and `@` in the assistant's composer had no root to
      // search. Nothing failed loudly; the completion menu simply never had anything
      // to offer.
      cwd={projectPath}
      // Per lane, so two sessions do not share one draft. Slot 0 keeps the historical
      // id, which is what stops an in-progress message disappearing on upgrade — the
      // draft store is keyed by this string and a renamed key reads as an empty box.
      composerId={
        slot === DEFAULT_ASSISTANT_SLOT ? "daintree-assistant" : `daintree-assistant-s${slot}`
      }
      onActivateReference={activateReference}
      forgeAvailable={forgeAvailable}
      className={className}
    />
  );
}
