import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { AssistantPanelView } from "./AssistantPanelView";
import { useAssistantSession } from "./useAssistantSession";
import { useAssistantStore, type AssistantSessionState } from "@/store/assistantStore";
import type { AssistantReference } from "./AssistantMessage";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { actionService } from "@/services/ActionService";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { notify } from "@/lib/notify";

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
  /** False while the panel is closed — the engine is not started. */
  active: boolean;
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
  projectPath,
  active,
  restartNonce = 0,
  operationsOpen,
  onOperationsOpenChange,
  className,
}: AssistantPanelProps) {
  const {
    submit,
    interrupt,
    decideApproval,
    answerQuestion,
    requestOperations,
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
      if (remaining > 0) useAssistantStore.getState().grantTool(approval.grantKey, remaining);
      decideApproval(approval.approvalId, "approved");
    },
    [decideApproval]
  );

  // Stable identity: the store's actions never change, so this cannot re-trigger the
  // composer's drain effect.
  const takeRetractedDraft = useCallback(() => {
    useAssistantStore.getState().takeRetractedDraft();
  }, []);

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
      mcpToolCount: s.mcpToolCount,
      commands: s.commands,
      operations: s.operations,
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
      // A click that does nothing has to say so.
      //
      // The notify() gate asks whether the user could observe this otherwise, and here
      // they cannot: the whole visible effect of a working click is a browser window
      // appearing somewhere else, so a failure looks exactly like a link that is not a
      // link. It is timely, it has a next step, and nothing else in the UI reports it.
      //
      // Not for a number that does not exist, though — that resolves fine and the forge
      // serves its own 404 in the browser, which is the forge's answer to give. What
      // reaches here is the provider failing to resolve or the browser failing to open.
      const reportFailure = (detail: unknown) => {
        console.warn("[assistant] could not open the reference", reference, detail);
        const label = reference.kind === "pr" ? "pull request" : "issue";
        notify({
          type: "error",
          title: "Reference didn't open",
          message: `Daintree couldn't reach the forge to open ${label} #${reference.number}. Check the connection and try again.`,
          // ONE contextual recovery, never "Dismiss": the list is where the reader was
          // trying to get to, and it goes through the same provider — so it either
          // works, or it fails the same way and says so once.
          action: {
            label: reference.kind === "pr" ? "Open pull requests" : "Open issues",
            actionId: reference.kind === "pr" ? "forge.openPRs" : "forge.openIssues",
            actionArgs: { cwd: projectPath },
            onClick: () => {},
          },
          // `git` rather than `connectivity`: this is one forge operation that failed in
          // direct response to a click, not the app losing its connection — and `git`
          // is the kind whose user-facing toggle a reader would look under to silence
          // forge chatter.
          context: { eventKind: "git" },
        });
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
    [projectPath]
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
      onActivateReference={activateReference}
      forgeAvailable={forgeAvailable}
      className={className}
    />
  );
}
