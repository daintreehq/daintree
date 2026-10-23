import { useState } from "react";
import { CirclePlay } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { skipProjectWelcome, startProjectWelcome } from "@/hooks/useProjectApplicationWelcome";
import { actionService } from "@/services/ActionService";
import { useProjectWelcomeStore } from "@/store/projectWelcomeStore";
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
  const setHandoff = useProjectWelcomeStore((s) => s.setHandoff);
  const [busy, setBusy] = useState<string | null>(null);
  // A promise chain rather than try/finally, which the React Compiler can't
  // lower even inside a handler.
  const run = (id: string, work: () => Promise<void>) => {
    setBusy(id);
    void Promise.resolve()
      .then(work)
      .catch((error: unknown) => logWarn("[ProjectWelcome] Notice action failed", { error }))
      .finally(() => setBusy(null));
  };

  if (offer !== null) {
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
            onClick: () => run("skip", skipProjectWelcome),
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
  return (
    <InlineStatusBanner
      icon={CirclePlay}
      layout="strip"
      title={`Next in ${handoff.appName}: ${handoff.title}`}
      description={handoff.skipped ? `Replay ${handoff.tourTitle} any time from Help.` : undefined}
      severity="neutral"
      role="status"
      actions={[
        {
          id: "workflow",
          label: handoff.title,
          variant: "primary",
          onClick: () => {
            setHandoff(null);
            void actionService.dispatch(handoff.actionId, undefined, { source: "user" });
          },
        },
      ]}
      className={BANNER_CLASS}
      onClose={() => setHandoff(null)}
      closeAriaLabel="Dismiss"
      closeTitle="Dismiss"
    />
  );
}
