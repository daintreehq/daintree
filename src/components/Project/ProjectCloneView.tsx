import { useEffect, useRef, useState } from "react";
import { Check, CircleSlash, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SkeletonHint } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { projectClient, systemClient } from "@/clients";
import { useDohertyGate } from "@/hooks";
import { useProjectCloneJob } from "@/hooks/useProjectCloneJob";
import { actionService } from "@/services/ActionService";
import { useProjectStore } from "@/store/projectStore";
import { reloadView } from "@/utils/reloadView";
import {
  buildCloneSignInAction,
  loadCloneForgeProviders,
  type CloneForgeProvider,
} from "./cloneSignIn";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { Project } from "@shared/types";
import type { ProjectCloneJobSnapshot } from "@shared/types/ipc/projectClone";

/** The house rule for a wait with nothing to show, as the clone dialog uses it. */
const STILL_WORKING_AFTER_MS = 5000;

/** Within this of the bottom, new output keeps the log pinned to its end. */
const STICK_TO_BOTTOM_PX = 24;

type CloneViewState = "running" | "failed" | "cancelled" | "succeeded";

function viewState(project: Project, job: ProjectCloneJobSnapshot | null): CloneViewState {
  if (job) return job.status;
  if (project.cloneState === "failed") return "failed";
  if (project.cloneState === "cancelled") return "cancelled";
  return "running";
}

function CloneOutput({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const text = lines.join("\n");

  useEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (lines.length === 0) return null;
  return (
    <pre
      ref={ref}
      tabIndex={0}
      aria-label="Git output"
      onScroll={(event) => {
        const el = event.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX;
      }}
      className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-md)] border border-border-default bg-surface-canvas px-3 py-2 font-mono text-xs leading-relaxed text-text-secondary"
    >
      {text}
    </pre>
  );
}

/**
 * What a project's panel grid shows while its repository is cloning, or after
 * a clone that ended without a checkout (#16352). It follows the clone main
 * runs, so it is the same wherever and whenever the project is opened: the
 * current git phase with its percentage, the phases done, and git's output.
 * Stop ends the clone and removes what it wrote; a failed or stopped clone
 * offers Retry and Remove project. Once the checkout lands the view reloads
 * into a normal project (see `projectStore`).
 */
export function ProjectCloneView({ project }: { project: Project }) {
  const job = useProjectCloneJob(project.id);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [forgeProviders, setForgeProviders] = useState<CloneForgeProvider[]>([]);

  const state = viewState(project, job);
  const authFailed = state === "failed" && job?.gitReason === "auth-failed";

  // Read only for a failure that sign-in could fix; the banner stays plain
  // until the providers arrive or if they never do.
  useEffect(() => {
    if (!authFailed) return;
    let cancelled = false;
    void loadCloneForgeProviders().then((providers) => {
      if (!cancelled) setForgeProviders(providers);
    });
    return () => {
      cancelled = true;
    };
  }, [authFailed]);
  const stages = job?.stages ?? [];
  const currentIndex = stages.findIndex((stage) => stage.key === job?.currentStageKey);
  const currentStage = currentIndex === -1 ? null : (stages[currentIndex] ?? null);
  // A wait with nothing measured yet shows nothing for its first 400ms, so a
  // view that is about to learn the phase never flashes "Connecting…".
  const showConnecting = useDohertyGate(state === "running" && currentStage === null);

  // The clone landed while this view held an older row (it hydrated from one
  // read before the success, so the update that reloads views passed it by).
  // Main keeps the finished job's answer for exactly this view.
  const landed = job?.status === "succeeded";
  useEffect(() => {
    if (landed) reloadView();
  }, [landed]);
  const completedStages =
    state === "running" ? (currentIndex === -1 ? [] : stages.slice(0, currentIndex)) : [];
  const source = job?.source ?? null;
  const targetPath = job?.targetPath ?? project.path;
  const canRetry = job?.canRetry ?? false;
  const signInAction =
    authFailed && source !== null ? buildCloneSignInAction(source, forgeProviders) : null;

  const stop = () => {
    setActionError(null);
    void projectClient.stopBackgroundClone(project.id).catch((error: unknown) => {
      setActionError({
        title: "Couldn't stop the clone",
        message: formatErrorMessage(error, "Couldn't stop the clone"),
      });
    });
  };

  // The project on screen is closed first, as the switcher closes the active
  // project: its view's pending saves are dropped, so none can write back the
  // state the removal deletes.
  const remove = async () => {
    const { currentProject, closeActiveProject } = useProjectStore.getState();
    if (currentProject?.id === project.id) await closeActiveProject(project.id);
    await actionService.dispatch("project.remove", { projectId: project.id }, { source: "user" });
  };

  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    setActionError(null);
    void projectClient
      .retryBackgroundClone(project.id)
      .catch((error: unknown) => {
        setActionError({
          title: "Couldn't retry the clone",
          message: formatErrorMessage(error, "Couldn't retry the clone"),
        });
      })
      .finally(() => setRetrying(false));
  };

  const cleanupBanner = job?.cleanupError ? (
    <InlineStatusBanner
      severity="error"
      title="Partial clone not removed"
      description="Close any Git processes using it, then delete the folder manually."
      contextLine={targetPath}
      contextLineTruncate="middle"
      action={
        {
          id: "reveal-partial-clone",
          label: "Show in folder",
          icon: FolderOpen,
          variant: "primary",
          onClick: () => void systemClient.showItemInFolderUnconfined(targetPath),
          ariaLabel: "Show the partial clone in the file manager",
        } satisfies BannerAction
      }
      className="rounded-[var(--radius-md)]"
    />
  ) : null;

  const stageText = currentStage ? currentStage.label : "Connecting";

  return (
    <div className="flex h-full w-full justify-center overflow-y-auto px-6 py-12">
      <section
        aria-label={`Clone of ${project.name}`}
        className="flex w-full max-w-xl flex-col gap-5"
      >
        <header className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="text-2xl leading-none">
            {project.emoji}
          </span>
          <div className="min-w-0 space-y-0.5">
            <h2 className="truncate text-base font-semibold text-text-primary">
              {state === "succeeded" ? `Opening ${project.name}…` : `Cloning ${project.name}`}
            </h2>
            {source !== null && (
              <TruncatedTooltip content={source}>
                <p className="truncate font-mono text-xs text-text-secondary">{source}</p>
              </TruncatedTooltip>
            )}
          </div>
        </header>

        {state === "running" && (currentStage !== null || showConnecting) && (
          <div className="space-y-2">
            {/* The phase alone is announced, so percentage ticks stay quiet. */}
            <span className="sr-only" role="status" aria-live="polite">
              {stageText}
            </span>
            <div className="flex items-center gap-2">
              <Spinner size="sm" className="shrink-0 text-text-secondary" />
              <span aria-hidden="true" className="text-sm text-text-primary">
                {currentStage ? currentStage.label : "Connecting…"}
              </span>
              {currentStage && (
                <span
                  aria-hidden="true"
                  className="ml-auto text-xs tabular-nums text-text-secondary"
                >
                  {currentStage.percent}%
                </span>
              )}
            </div>
            {/* Each git phase counts from zero, so the bar is the live phase's. */}
            <ProgressBar label={stageText} value={currentStage ? currentStage.percent : null} />
            {!currentStage && (
              <SkeletonHint message="Still working…" firstThreshold={STILL_WORKING_AFTER_MS} />
            )}
            {completedStages.length > 0 && (
              <ul className="space-y-1 pt-1">
                {completedStages.map((stage) => (
                  <li
                    key={stage.key}
                    className="flex items-center gap-2 text-xs text-text-secondary"
                  >
                    <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{stage.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {state === "succeeded" && (
          <p className="text-sm text-text-secondary" role="status">
            Repository cloned
          </p>
        )}

        {state === "failed" && (
          <InlineStatusBanner
            severity="error"
            title="Clone failed"
            description={job?.error ?? "The clone ended without a checkout."}
            action={signInAction ?? undefined}
            className="rounded-[var(--radius-md)]"
          />
        )}

        {state === "cancelled" && (
          <InlineStatusBanner
            icon={CircleSlash}
            severity="neutral"
            title="Clone stopped"
            description={
              job?.cleanupError
                ? "The clone was stopped before it finished."
                : "The clone was stopped before it finished, and what it wrote was removed."
            }
            role="status"
            className="rounded-[var(--radius-md)]"
          />
        )}

        {cleanupBanner}

        {actionError !== null && (
          <InlineStatusBanner
            severity="error"
            title={actionError.title}
            description={actionError.message}
            onClose={() => setActionError(null)}
            closeAriaLabel="Dismiss"
            className="rounded-[var(--radius-md)]"
          />
        )}

        <CloneOutput lines={job?.output ?? []} />

        {state === "running" && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={stop} loading={job?.stopping ?? false}>
              Stop clone
            </Button>
          </div>
        )}

        {(state === "failed" || state === "cancelled") && (
          <div className="flex items-center justify-end gap-3">
            <Button variant="ghost-danger" onClick={() => setConfirmRemove(true)}>
              Remove project
            </Button>
            {canRetry && (
              <Button variant="contrast" onClick={retry} loading={retrying}>
                Retry
              </Button>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove '${project.name}'?`}
        description={
          job?.cleanupError
            ? "Takes the project out of your list. The partial clone left on disk stays where it is."
            : "Takes the project out of your list. Nothing was cloned, so nothing on disk changes."
        }
        confirmLabel="Remove project"
        variant="destructive"
        onConfirm={() => {
          setConfirmRemove(false);
          void remove().catch((error: unknown) => {
            setActionError({
              title: "Couldn't remove the project",
              message: formatErrorMessage(error, "Couldn't remove the project"),
            });
          });
        }}
      />
    </div>
  );
}
