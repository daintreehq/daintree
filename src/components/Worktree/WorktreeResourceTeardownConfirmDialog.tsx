import { useEffect } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { useWorktreeResourceTeardownConfirmStore } from "@/store/worktreeResourceTeardownConfirmStore";

const CONFIRM_COOLDOWN_MS = 1_200;

function WorktreeResourceTeardownConfirmDialogInner() {
  const pending = useWorktreeResourceTeardownConfirmStore((s) => s.pendingConfirm);
  const requestSeq = useWorktreeResourceTeardownConfirmStore((s) => s.requestSeq);
  const resolveConfirmation = useWorktreeResourceTeardownConfirmStore((s) => s.resolveConfirmation);
  if (!pending) return null;

  const { label, commands, approved } = pending.request;
  const hasCommands = commands.length > 0;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title={`Tear down resource for '${label}'?`}
      description="This runs the project's resource-teardown commands for this worktree. Tearing down a remote or shared environment may require manual steps to recreate."
      confirmLabel="Tear down resource"
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      // A request that supersedes another lands in this same open dialog, so
      // each one re-arms the read-time gate and the initial focus: a press or
      // focus already on the old one's confirm can't approve the new one. Kept
      // mounted rather than remounted so focus still returns to the opener.
      confirmCooldownMs={CONFIRM_COOLDOWN_MS}
      cooldownKey={requestSeq}
      focusResetKey={requestSeq}
      bodyResetKey={requestSeq}
      onConfirm={() => resolveConfirmation(true)}
    >
      <div className="space-y-1.5" data-testid="resource-teardown-preview">
        <span className={SECTION_LABEL_CLASS}>
          {hasCommands && approved ? "Commands that will run" : "Teardown commands"}
        </span>
        <pre className="max-h-48 overflow-y-auto rounded-[var(--radius-md)] border border-border-default bg-surface-canvas p-3 font-mono text-xs text-text-primary whitespace-pre-wrap break-all select-text">
          {hasCommands ? commands.join("\n") : "No teardown commands found."}
        </pre>
        {hasCommands && !approved && (
          <p className="text-xs text-text-secondary">
            They come from a repository config that isn&apos;t approved yet, so none of them run
            until it is.
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

/**
 * Host for the confirmation `worktree.resource.teardown` awaits. Mounted
 * app-wide: the palette closes on pick, so a dialog it owned would unmount
 * under the request.
 */
export function WorktreeResourceTeardownConfirmDialog() {
  const requestSeq = useWorktreeResourceTeardownConfirmStore((s) => s.requestSeq);

  // A host torn down mid-request must not leave the action awaiting forever.
  useEffect(
    () => () => useWorktreeResourceTeardownConfirmStore.getState().resolveConfirmation(false),
    []
  );

  return (
    <ErrorBoundary
      variant="component"
      componentName="WorktreeResourceTeardownConfirmDialog"
      resetKeys={[requestSeq]}
      onError={() => useWorktreeResourceTeardownConfirmStore.getState().resolveConfirmation(false)}
    >
      <WorktreeResourceTeardownConfirmDialogInner />
    </ErrorBoundary>
  );
}
