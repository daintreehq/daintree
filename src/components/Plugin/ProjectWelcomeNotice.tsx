import { useState } from "react";
import { CirclePlay } from "lucide-react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import {
  dismissProjectWelcomeHandoff,
  skipProjectWelcome,
  startProjectWelcome,
} from "@/hooks/useProjectApplicationWelcome";
import { actionService } from "@/services/ActionService";
import { isStagedConfirmation } from "@/services/actions/confirmationStaged";
import {
  useProjectWelcomeStore,
  type ProjectWelcomeHandoff,
  type ProjectWelcomeOffer,
} from "@/store/projectWelcomeStore";
import { logWarn } from "@/utils/logger";

// Same placement as the layout seed strip it follows.
const BANNER_CLASS =
  "mx-1 mt-1 shrink-0 rounded-[var(--radius-sm)] border border-border-default bg-surface-panel";

/**
 * A project application's welcome (#14106), at the top of its Home or grid.
 *
 * Two states, one strip. While the welcome is on offer: Start plays it in the
 * tour dialog, Skip turns it down until the application ships a new welcome
 * revision. Once it is finished or skipped, the application's first workflow
 * waits here as one button the user may press — nothing runs on its own, and
 * the workflow goes through its own confirmation and, for an agent it starts,
 * the launch-time check for the project's required tools (#14096).
 */
export function ProjectWelcomeNotice() {
  const offer = useProjectWelcomeStore((s) => s.offer);
  const handoff = useProjectWelcomeStore((s) => s.handoff);
  const [busy, setBusy] = useState<string | null>(null);
  // Said on the strip it happened on, which stays up to retry from: a Skip that
  // wasn't recorded, or a workflow that didn't go through.
  const [failure, setFailure] = useState<NoticeFailure | null>(null);
  // A promise chain rather than try/finally, which the React Compiler can't
  // lower even inside a handler.
  const run = (id: string, work: () => Promise<void>, onFailure?: (error: unknown) => void) => {
    setBusy(id);
    void Promise.resolve()
      .then(work)
      // Cleared only once it worked: a Retry keeps its banner, and its button,
      // up while it runs.
      .then(() => setFailure(null))
      .catch((error: unknown) => {
        logWarn("[ProjectWelcome] Notice action failed", { error });
        onFailure?.(error);
      })
      .finally(() => setBusy(null));
  };

  if (offer !== null) {
    const skip = () =>
      run("skip", skipProjectWelcome, () => setFailure({ key: offerKey(offer), message: "" }));
    if (failure?.key === offerKey(offer)) {
      return (
        <InlineStatusBanner
          layout="strip"
          title="Couldn't skip the welcome"
          description="Your answer wasn't saved, so the welcome is still on offer."
          severity="error"
          role="alert"
          action={{
            id: "retry",
            label: "Retry",
            variant: "primary",
            onClick: skip,
            loading: busy === "skip",
          }}
          className={BANNER_CLASS}
          onClose={() => setFailure(null)}
          closeAriaLabel="Dismiss"
          data-testid="project-welcome-offer"
        />
      );
    }
    return (
      <InlineStatusBanner
        icon={CirclePlay}
        layout="strip"
        title={`Take the ${offer.minutes}-minute ${offer.appName} welcome`}
        description="A narrated look at what it does. Nothing runs until you start it."
        severity="neutral"
        role="status"
        actions={[
          {
            id: "start",
            label: "Start welcome",
            variant: "primary",
            onClick: () => run("start", startProjectWelcome),
            loading: busy === "start",
            disabled: busy !== null && busy !== "start",
          },
          {
            id: "skip",
            label: "Skip",
            variant: "dismiss",
            onClick: skip,
            loading: busy === "skip",
            disabled: busy !== null && busy !== "skip",
          },
        ]}
        className={BANNER_CLASS}
        data-testid="project-welcome-offer"
      />
    );
  }

  if (handoff === null) return null;
  // The strip goes only once the workflow went through; until then it is the
  // one place to run it again from.
  const runWorkflow = () => {
    const key = handoffKey(handoff);
    run(
      "workflow",
      async () => {
        const result = await actionService.dispatch(handoff.actionId, undefined, {
          source: "user",
        });
        if (result.ok) {
          // Only the hand-off it was pressed on: a workflow that changed while
          // this one ran has its own strip to keep.
          const current = useProjectWelcomeStore.getState().handoff;
          if (current !== null && handoffKey(current) === key) dismissProjectWelcomeHandoff();
          return;
        }
        // A dialog now asking the user is not a failure to report.
        if (isStagedConfirmation(result.error)) return;
        throw new Error(result.error.message);
      },
      (error) => setFailure({ key, message: formatErrorMessage(error, "").trim() })
    );
  };
  if (failure?.key === handoffKey(handoff)) {
    return (
      <InlineStatusBanner
        layout="strip"
        title={`Couldn't run ${handoff.title}`}
        description={failure.message || undefined}
        severity="error"
        role="alert"
        action={{
          id: "retry",
          label: "Retry",
          variant: "primary",
          onClick: runWorkflow,
          loading: busy === "workflow",
        }}
        className={BANNER_CLASS}
        onClose={() => setFailure(null)}
        closeAriaLabel="Dismiss"
      />
    );
  }
  return (
    <InlineStatusBanner
      icon={CirclePlay}
      layout="strip"
      title={`Next in ${handoff.appName}: ${handoff.title}`}
      description={handoff.skipped ? `Replay ${handoff.tourTitle} any time from Help` : undefined}
      severity="neutral"
      role="status"
      actions={[
        {
          id: "workflow",
          label: handoff.title,
          variant: "primary",
          onClick: runWorkflow,
          loading: busy === "workflow",
        },
      ]}
      className={BANNER_CLASS}
      onClose={dismissProjectWelcomeHandoff}
      closeDisabled={busy === "workflow"}
      closeAriaLabel="Dismiss"
      closeTitle="Dismiss"
    />
  );
}

interface NoticeFailure {
  /** Which offer or hand-off it belongs to, so a new one never shows an old failure. */
  key: string;
  message: string;
}

function offerKey(offer: ProjectWelcomeOffer): string {
  return `offer\n${offer.ownerId}\n${offer.localTourId}\n${offer.version}`;
}

function handoffKey(handoff: ProjectWelcomeHandoff): string {
  return `handoff\n${handoff.actionId}`;
}
