import { useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  dismissLayoutOffer,
  openOfferedLayout,
  selectProjectDefaultLayout,
} from "@/hooks/useProjectLayoutSeed";
import { startPluginLayoutRecipe } from "@/services/layout/applyPluginLayout";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import { useProjectLayoutSeedStore } from "@/store/projectLayoutSeedStore";
import { useProjectStore } from "@/store/projectStore";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logWarn } from "@/utils/logger";

const BANNER_CLASS = "rounded-[var(--radius-sm)] border border-border-default bg-surface-panel";

/**
 * A project plugin's first-open layout (#13782), at the top of the panel grid
 * beside the plugin trust strip that usually comes just before it.
 *
 * Two states, one strip. When the user had already opened something by the
 * time the plugin's layout arrived, it offers "Open <plugin>'s layout"; × turns
 * the offer down for good, since the layout stays in the command palette. Once
 * a layout has been opened, the recipes it left unstarted wait here as Start
 * buttons, each through the layout's own confirmation — a layout never starts
 * a terminal on open.
 */
export function ProjectLayoutSeedNotice() {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  return (
    <ErrorBoundary
      variant="component"
      componentName="ProjectLayoutSeedNotice"
      resetKeys={[projectId ?? "null"]}
    >
      <NoticeBody />
    </ErrorBoundary>
  );
}

function NoticeBody() {
  const status = useProjectLayoutSeedStore((s) => s.status);
  const waiting = useProjectLayoutSeedStore((s) => s.waiting);
  const setWaiting = useProjectLayoutSeedStore((s) => s.setWaiting);
  const recipeStarted = useProjectLayoutSeedStore((s) => s.recipeStarted);
  const layouts = usePluginLayoutsStore((s) => s.layouts);
  const [busy, setBusy] = useState<string | null>(null);
  // A promise chain rather than try/finally, which the React Compiler can't
  // lower even inside a handler.
  const run = (id: string, work: () => Promise<void>) => {
    setBusy(id);
    void Promise.resolve()
      .then(work)
      .catch((error: unknown) => logWarn("[ProjectLayoutSeed] Notice action failed", { error }))
      .finally(() => setBusy(null));
  };

  const offered = status === "offered" ? selectProjectDefaultLayout(layouts) : null;
  if (offered !== null) {
    return (
      <div className="mx-1 mt-1 shrink-0">
        <InlineStatusBanner
          icon={LayoutTemplate}
          layout="strip"
          title={`${offered.pluginName} has a layout for this project`}
          description={
            offered.entries.some((entry) => entry.target.type === "recipe")
              ? "Its terminals wait for you to start them."
              : undefined
          }
          severity="neutral"
          role="status"
          actions={[
            {
              id: "open",
              label: `Open ${offered.pluginName}'s layout`,
              variant: "primary",
              onClick: () => run("open", () => openOfferedLayout(offered)),
              loading: busy === "open",
              disabled: busy !== null && busy !== "open",
            },
          ]}
          className={BANNER_CLASS}
          onClose={() => run("dismiss", dismissLayoutOffer)}
          closeDisabled={busy !== null}
          closeAriaLabel="Dismiss"
          closeTitle="Dismiss — the layout stays in the command palette"
        />
      </div>
    );
  }

  // Only while the plugin still offers the layout: its recipes resolve through
  // it, and a Start that could only fail is no next step.
  if (waiting === null || !layouts.some((layout) => layout.id === waiting.layoutId)) return null;

  const { layoutId } = waiting;
  const start = (recipeId: string): void =>
    run(recipeId, () =>
      startPluginLayoutRecipe(layoutId, recipeId, { dispatchSource: "user" }).then(
        (result) => {
          if (result.status === "applied") recipeStarted(recipeId);
        },
        (error: unknown) => {
          notify({
            type: "error",
            priority: "high",
            title: "Terminals not started",
            message: formatErrorMessage(error, "The layout's recipe couldn't start"),
            context: { eventKind: "uiFeedback" },
            action: { label: "Retry", onClick: () => start(recipeId) },
          });
        }
      )
    );

  return (
    <div className="mx-1 mt-1 shrink-0">
      <InlineStatusBanner
        icon={LayoutTemplate}
        layout="strip"
        title={`Opened ${waiting.layoutName} from ${waiting.pluginName}`}
        description="Its terminals haven't started. Start each one when you're ready."
        severity="neutral"
        role="status"
        actions={waiting.recipes.map((recipe): BannerAction => ({
          id: recipe.id,
          label: `Start ${recipe.name}`,
          variant: "primary",
          onClick: () => start(recipe.id),
          loading: busy === recipe.id,
          disabled: busy !== null && busy !== recipe.id,
        }))}
        className={BANNER_CLASS}
        onClose={() => setWaiting(null)}
        closeDisabled={busy !== null}
        closeAriaLabel="Dismiss"
        closeTitle="Dismiss — the layout stays in the command palette"
      />
    </div>
  );
}
