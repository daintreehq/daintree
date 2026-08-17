import { useCallback, useState, type ReactElement } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { useWorktreeMoveDecisionStore } from "@/store/worktreeMoveDecisionStore";
import {
  resolveWorktreeMoveDecision,
  type WorktreeMoveOutcome,
} from "@/services/terminal/worktreeMoveDecision";

/**
 * The cross-worktree move decision (#11840).
 *
 * Moving a panel relabels it; it does not move the process. This is the one
 * moment the user's attention is guaranteed to be on the gesture, so the choice
 * is resolved here rather than announced afterwards in a banner the user may
 * never see — a live-to-live move lands the panel on a worktree they aren't
 * looking at, and a dock panel isn't rendered there at all.
 *
 * Three-way, so not a `ConfirmDialog`: transfer (recommended), move the panel
 * only, or cancel. Escape cancels. There is no path that silently accepts the
 * divergence.
 */
export function WorktreeMoveDecisionDialog(): ReactElement | null {
  const pending = useWorktreeMoveDecisionStore((s) => s.pending);
  const [resolving, setResolving] = useState<WorktreeMoveOutcome | null>(null);

  const resolve = useCallback(
    (outcome: WorktreeMoveOutcome) => {
      if (pending === null || resolving !== null) return;
      setResolving(outcome);
      // `.catch` before `.finally`: a rejected transfer would otherwise surface
      // as an unhandled rejection. The resolver has already released the input
      // lock and marked the divergence by then.
      void resolveWorktreeMoveDecision(pending, outcome)
        .catch(() => undefined)
        .finally(() => setResolving(null));
    },
    [pending, resolving]
  );

  const handleCancel = useCallback(() => resolve("cancel"), [resolve]);

  if (pending === null) return null;

  const { members, destinationWorktreeLabel, agentLabel } = pending;
  const diverged = members.filter((m) => m.alignment !== "aligned");
  const isGroup = members.length > 1;
  const sessionNoun = agentLabel ? `${agentLabel} session` : "session";
  const subject = isGroup ? `these ${diverged.length} sessions` : `this ${sessionNoun}`;

  // Named where it can be named, honest where it can't: `unknown` means the
  // launch root couldn't be resolved, not that it matches.
  const single = diverged[0];
  const origin =
    !isGroup && single?.alignment === "launch-root-mismatch" && single.launchWorktreeLabel
      ? single.launchWorktreeLabel
      : null;

  return (
    <AppDialog
      isOpen
      onClose={handleCancel}
      size="md"
      initialFocus="confirm"
      data-testid="worktree-move-decision-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>
          {isGroup
            ? `Move ${diverged.length} sessions to ${destinationWorktreeLabel}?`
            : `Move ${sessionNoun} to ${destinationWorktreeLabel}?`}
        </AppDialog.Title>
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <p className="text-[13px] text-daintree-text/80">
          {origin
            ? `It's still running in ${origin} — moving the panel doesn't change where its commands and commits land.`
            : `Moving the panel doesn't change where its commands and commits land — ${subject} keeps running in the directory it launched from.`}
        </p>

        <ul className="space-y-1 text-[12px] text-daintree-text/70">
          <li>
            <span className="text-daintree-text/90">Transfer session</span> restarts it in{" "}
            {destinationWorktreeLabel} and hands the conversation over as its first prompt.
          </li>
          <li>
            <span className="text-daintree-text/90">Move panel only</span> leaves it running where
            it is, and marks the panel so it stays obvious.
          </li>
        </ul>

        {isGroup && (
          <div className="text-[12px] text-daintree-text/70">
            <p className="mb-1 text-daintree-text/90">Affected sessions</p>
            <ul className="space-y-0.5">
              {diverged.map((member) => (
                <li key={member.panelId} className="flex items-baseline justify-between gap-3">
                  <span className="truncate">{member.title}</span>
                  <span className="shrink-0 text-daintree-text/50">
                    {member.alignment === "launch-root-mismatch"
                      ? (member.launchWorktreeLabel ?? "another directory")
                      : "location unknown"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button
          variant="ghost"
          onClick={handleCancel}
          disabled={resolving !== null}
          data-confirm-role="cancel"
        >
          Cancel
        </Button>
        <Button
          variant="secondary"
          onClick={() => resolve("move-only")}
          disabled={resolving !== null}
          loading={resolving === "move-only"}
        >
          Move panel only
        </Button>
        <Button
          onClick={() => resolve("transfer")}
          disabled={resolving !== null}
          loading={resolving === "transfer"}
          data-confirm-role="confirm"
        >
          Transfer session
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
