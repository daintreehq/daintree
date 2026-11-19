import { useEffect, useState } from "react";
import type { IdlePausePolicy, IdlePauseUnavailableReason } from "@shared/types/idlePause";
import { worktreeClient } from "@/clients";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { PathSegments } from "@/components/ui/PathSegments";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** As on the command approval dialog: the commands can land under a pointer aimed at the menu row. */
const CONFIRM_COOLDOWN_MS = 1_200;

const UNAVAILABLE_TEXT: Record<IdlePauseUnavailableReason, string> = {
  "no-environment": "This worktree has no resource environment to pause.",
  repository:
    "This environment comes from the repository, so it can't pause unattended. Define it in Project settings to use idle pause.",
  "no-pause": "This environment has no pause commands. Add some in Project settings first.",
};

export interface IdlePauseDialogProps {
  isOpen: boolean;
  worktreeId: string;
  onClose: () => void;
}

/**
 * Turns idle pause on or off for the worktree's environment on this device
 * (#17925). Turning it on shows the pause commands that will run, read fresh
 * by the host, and is refused if they changed before the confirm landed.
 */
export function IdlePauseDialog({ isOpen, worktreeId, onClose }: IdlePauseDialogProps) {
  // `undefined` while loading.
  const [policy, setPolicy] = useState<IdlePausePolicy | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [loadCount, setLoadCount] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setPolicy(undefined);
    setLoadError(null);
    worktreeClient.getIdlePause(worktreeId).then(
      (next) => {
        if (!cancelled) setPolicy(next);
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(formatErrorMessage(err, "Couldn't read the environment"));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktreeId, loadCount]);

  useEffect(() => {
    if (!isOpen) setSaveError(null);
  }, [isOpen]);

  const isLoading = isOpen && policy === undefined && loadError === null;
  const showSpinner = useDeferredLoading(isLoading, UI_DOHERTY_THRESHOLD);
  const showSaveSpinner = useDeferredLoading(isSaving, UI_DOHERTY_THRESHOLD);

  const available = policy?.status === "available" ? policy : null;
  const enabled = available?.enabled === true;

  const handleConfirm = async () => {
    if (!available) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await worktreeClient.setIdlePause(
        worktreeId,
        !enabled,
        enabled ? undefined : available.fingerprint
      );
      onClose();
    } catch (err) {
      setSaveError(formatErrorMessage(err, "Couldn't change idle pause"));
      // Whatever is on disk now is what the next confirm must be about.
      setLoadCount((count) => count + 1);
    } finally {
      setIsSaving(false);
    }
  };

  const environment = available ? `'${available.environment}'` : "this environment";

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      variant="default"
      size="lg"
      initialFocus="cancel"
      title={
        enabled
          ? `Turn off idle pause for ${environment}?`
          : `Pause ${environment} when its host goes idle?`
      }
      description={
        enabled
          ? "Its machine stays running until someone pauses it."
          : "Once the machine a worktree in this environment opened as a host has gone idle, this device runs these pause commands with nobody there. A host you already had is never paused this way."
      }
      confirmLabel={enabled ? "Turn off idle pause" : "Turn on idle pause"}
      cancelLabel={policy?.status === "unavailable" ? "Close" : "Cancel"}
      onConfirm={handleConfirm}
      isConfirmLoading={showSaveSpinner}
      isBusy={isSaving}
      confirmDisabled={!available}
      confirmCooldownMs={enabled ? undefined : CONFIRM_COOLDOWN_MS}
      cooldownKey={available?.fingerprint}
      hasPreview
      bodyResetKey={available?.fingerprint}
    >
      <div className="min-h-[5.5rem] space-y-4">
        {saveError !== null && <InlineError role="alert">{saveError}</InlineError>}
        {loadError !== null ? (
          <InlineError
            role="alert"
            action={
              <Button
                variant="outline"
                size="xs"
                onClick={() => setLoadCount((count) => count + 1)}
                className="-my-1 shrink-0"
              >
                Retry
              </Button>
            }
          >
            {loadError}
          </InlineError>
        ) : policy === undefined ? (
          showSpinner ? (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Spinner size="xs" />
              <span>Reading the environment…</span>
            </div>
          ) : null
        ) : policy.status === "unavailable" ? (
          <Callout severity="info">{UNAVAILABLE_TEXT[policy.reason]}</Callout>
        ) : (
          <>
            {policy.changed && (
              <Callout severity="warning">
                The pause commands changed since idle pause was turned on, so it's off. Turn it on
                again to confirm these.
              </Callout>
            )}
            <section className="space-y-2" aria-label={policy.sourcePath}>
              <p className="font-mono text-xs text-text-secondary">
                <PathSegments path={policy.sourcePath} />
              </p>
              <ol
                aria-label="Pause commands"
                className="divide-y divide-border-subtle rounded-[var(--radius-md)] bg-surface-inset"
              >
                {policy.commands.map((command, index) => (
                  <li key={index} className="px-3 py-1.5">
                    <pre className="pl-4 -indent-4 font-mono text-xs leading-5 text-text-primary whitespace-pre-wrap break-all select-text">
                      {command}
                    </pre>
                  </li>
                ))}
              </ol>
            </section>
            <p className="text-xs text-text-secondary">
              Saved on this device for these exact lines, with each worktree&apos;s own values
              filled in. Any change to them turns idle pause off until you confirm again.
            </p>
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
