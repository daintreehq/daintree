import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InlineError } from "@/components/ui/field";
import type {
  LifecycleCommandReview,
  LifecycleCommandReviewGroup,
  LifecycleCommandReviewSource,
} from "@shared/types/worktree";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { worktreeClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { PathSegments } from "@/components/ui/PathSegments";

/**
 * Click-carry-over guard, as on `McpConfirmDialog`: the review can land under a
 * pointer that was aimed at the button which opened the dialog.
 */
const APPROVE_COOLDOWN_MS = 1_200;

type Phase = "setup" | "teardown" | "resources";

const PHASE_LABEL: Record<Phase, string> = {
  setup: "Setup",
  teardown: "Teardown",
  resources: "Resources",
};

/** Labels are built host-side in `lifecycleCommandTrust.ts`; everything else is a resource field. */
function phaseOf(group: LifecycleCommandReviewGroup): Phase {
  if (group.label === "Setup") return "setup";
  if (group.label === "Teardown") return "teardown";
  return "resources";
}

/**
 * When each resource field runs. `provider` is the one value that never runs
 * itself; it reaches every command as an environment variable.
 */
const RESOURCE_FIELD_TRIGGER: Record<string, string> = {
  provision: "Runs when resources are provisioned",
  teardown: "Runs when resources are torn down",
  resume: "Runs when resources are resumed",
  pause: "Runs when resources are paused",
  status: "Runs on each status check, which can repeat on a schedule",
  connect: "Runs when you connect to resources",
  provider: "A value, not a command: every command gets it as DAINTREE_RESOURCE_PROVIDER",
};

function resourceTrigger(label: string): string | undefined {
  return RESOURCE_FIELD_TRIGGER[label.slice(label.lastIndexOf(" ") + 1)];
}

/**
 * Lines may only end at whitespace: each token is an atomic box, so a flag is
 * never split at its own hyphens ("--" then "config…"). A token wider than the
 * whole line still breaks inside itself rather than overflowing. The text is
 * the command's own characters, whitespace included.
 */
function CommandText({ command }: { command: string }) {
  return command.split(/(\s+)/).map((part, i) =>
    i % 2 === 1 || part === "" ? (
      part
    ) : (
      <span key={i} className="inline-block max-w-full indent-0 break-all">
        {part}
      </span>
    )
  );
}

function phasesOf(source: LifecycleCommandReviewSource) {
  const phases = new Map<Phase, LifecycleCommandReviewGroup[]>();
  for (const group of source.groups) {
    const phase = phaseOf(group);
    phases.set(phase, [...(phases.get(phase) ?? []), group]);
  }
  return [...phases];
}

export interface LifecycleCommandApprovalDialogProps {
  isOpen: boolean;
  worktreeId: string;
  /** The worktree's setup was skipped for approval and runs once this approves. */
  setupAwaitingApproval: boolean;
  onClose: () => void;
}

/**
 * Shows the repository commands a worktree would run and lets the user
 * approve them (#12408). The only way approval is granted: the host re-reads
 * the commands on open, and approval is submitted against the fingerprint of
 * exactly what this dialog displayed, so a change made while it is open is
 * refused rather than approved unseen.
 */
export function LifecycleCommandApprovalDialog({
  isOpen,
  worktreeId,
  setupAwaitingApproval,
  onClose,
}: LifecycleCommandApprovalDialogProps) {
  // `undefined` while loading, `null` when nothing is waiting. The approve
  // button keys off the loaded review itself, never off the dialog being open.
  const [review, setReview] = useState<LifecycleCommandReview | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [loadCount, setLoadCount] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setReview(undefined);
    setLoadError(null);
    worktreeClient.getLifecycleCommandReview(worktreeId).then(
      (next) => {
        if (!cancelled) setReview(next);
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(formatErrorMessage(err, "Couldn't read the commands"));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktreeId, loadCount]);

  useEffect(() => {
    if (!isOpen) setApproveError(null);
  }, [isOpen]);

  const isLoading = isOpen && review === undefined && loadError === null;
  const showSpinner = useDeferredLoading(isLoading, UI_DOHERTY_THRESHOLD);
  const showApproveSpinner = useDeferredLoading(isApproving, UI_DOHERTY_THRESHOLD);

  const handleApprove = async () => {
    if (!review) return;
    setIsApproving(true);
    setApproveError(null);
    try {
      await worktreeClient.approveLifecycleCommands(worktreeId, review.fingerprint);
      onClose();
    } catch (err) {
      setApproveError(formatErrorMessage(err, "Couldn't approve the commands"));
      // Whatever is on disk now is what the next approval must be about.
      setLoadCount((count) => count + 1);
    } finally {
      setIsApproving(false);
    }
  };

  const hasSetupGroup = review?.sources.some((source) =>
    source.groups.some((group) => phaseOf(group) === "setup")
  );

  /** Set on the resource group approving starts, rather than approves for later. */
  const runsNowLabel = (group: LifecycleCommandReviewGroup): string | undefined => {
    if (!setupAwaitingApproval) return undefined;
    if (group.label === review?.provisionAfterSetup) {
      return hasSetupGroup ? "Runs right after setup" : "Runs as soon as you approve";
    }
    return undefined;
  };

  const phaseTrigger: Record<Phase, string | undefined> = {
    setup: setupAwaitingApproval ? undefined : "Runs when a worktree is created",
    teardown: "Runs when a worktree is deleted",
    resources: undefined,
  };

  const nothingWaiting = review === null;

  return (
    <ConfirmDialog
      isOpen={isOpen}
      // Not dismissible while an approval is in flight — `isBusy` locks it from
      // the first frame, before the spinner's gate: its answer belongs to this
      // opening, and would otherwise close or annotate the next one.
      onClose={onClose}
      variant="default"
      size="lg"
      initialFocus="cancel"
      title={nothingWaiting ? "No commands need approval" : "Approve repository commands?"}
      description={
        nothingWaiting
          ? "These commands are already approved, or they're your own."
          : "These come from the repository and run with your account. Approve them only if you trust whoever wrote them — on a pull request branch, that's its author."
      }
      confirmLabel={setupAwaitingApproval ? "Approve and run setup" : "Approve commands"}
      cancelLabel={nothingWaiting ? "Close" : "Cancel"}
      onConfirm={handleApprove}
      isConfirmLoading={showApproveSpinner}
      isBusy={isApproving}
      confirmDisabled={!review}
      confirmCooldownMs={APPROVE_COOLDOWN_MS}
      cooldownKey={review?.fingerprint}
      hasPreview
      bodyResetKey={review?.fingerprint}
      // Short rows overflow routinely; the full fade would wash out a whole command.
      compactBodyShadow
    >
      <div className="min-h-[5.5rem] space-y-5">
        {/* Above the refreshed commands, since the body scrolls back to the top. */}
        {approveError !== null && <InlineError role="alert">{approveError}</InlineError>}
        {loadError !== null ? (
          <InlineError
            role="alert"
            action={
              <Button
                variant="ghost"
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
        ) : review === undefined ? (
          showSpinner ? (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Spinner size="xs" />
              <span>Reading commands…</span>
            </div>
          ) : null
        ) : review === null ? null : (
          <>
            {review.sources.map((source) => (
              <section key={source.path} className="space-y-4" aria-label={source.path}>
                <p className="font-mono text-xs text-text-secondary">
                  <PathSegments path={source.path} />
                </p>
                {phasesOf(source).map(([phase, groups]) => (
                  <div key={phase} className="space-y-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className={SECTION_LABEL_CLASS}>{PHASE_LABEL[phase]}</h3>
                      {phase === "setup" && setupAwaitingApproval ? (
                        <Badge className="text-text-primary">Runs as soon as you approve</Badge>
                      ) : (
                        phaseTrigger[phase] && (
                          <span className="text-xs text-text-secondary">{phaseTrigger[phase]}</span>
                        )
                      )}
                    </div>
                    {groups.map((group) => {
                      const runsNow = phase === "resources" ? runsNowLabel(group) : undefined;
                      const trigger =
                        phase === "resources" ? resourceTrigger(group.label) : undefined;
                      return (
                        <div key={group.label} className="space-y-1">
                          {phase === "resources" && (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <p className="text-xs font-medium text-text-primary">{group.label}</p>
                              {runsNow ? (
                                <Badge className="text-text-primary">{runsNow}</Badge>
                              ) : (
                                trigger && (
                                  <span className="text-xs text-text-secondary">{trigger}</span>
                                )
                              )}
                            </div>
                          )}
                          <ol
                            aria-label={group.label}
                            className="divide-y divide-border-subtle rounded-[var(--radius-md)] bg-surface-inset"
                          >
                            {group.commands.map((command, index) => (
                              <li key={index} className="px-3 py-1.5">
                                {/* Hanging indent: a wrapped or continued line sits
                                    in from the line that starts the command. */}
                                <pre className="pl-4 -indent-4 font-mono text-xs leading-5 text-text-primary whitespace-pre-wrap select-text">
                                  <CommandText command={command} />
                                </pre>
                              </li>
                            ))}
                          </ol>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </section>
            ))}
            <p className="text-xs text-text-secondary">
              Approval is saved for this project and covers these exact lines, not the scripts they
              call. Any change to them asks again.
            </p>
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
