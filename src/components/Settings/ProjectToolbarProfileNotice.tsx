import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { useProjectToolbarOverlay, useResolvedPresentation } from "@/hooks/useResolvedPresentation";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { pluralize } from "@/lib/pluralize";
import {
  PRESENTATION_FEATURE_IDS,
  isToolbarPresentationFeature,
} from "@shared/config/presentationProfile";

/**
 * Settings → Toolbar's word on the current project's own toolbar (#13783).
 * Everything else on the page is app-wide; this says that a project lays its
 * own toolbar over it, and resets that overlay — never the app-wide layout.
 *
 * Renders nothing until the project's profile has loaded, or when it sets
 * nothing for the toolbar.
 */
export function ProjectToolbarProfileNotice() {
  const project = useProjectStore((s) => s.currentProject);
  const overlay = useProjectToolbarOverlay();
  const presentation = useResolvedPresentation();
  const useProjectToolbar = useProjectPresentationStore((s) => s.useProjectToolbar);
  const promoted = useProjectPresentationStore((s) => s.promotedPluginButtons);
  const failedSave = useProjectPresentationStore((s) => s.failedSave);
  const resetToolbar = useProjectPresentationStore((s) => s.resetToolbar);
  const retryFailedSave = useProjectPresentationStore((s) => s.retryFailedSave);

  if (project == null || !overlay.available) return null;
  if (!overlay.hasOverrides && useProjectToolbar !== true) return null;

  const demoted = PRESENTATION_FEATURE_IDS.filter(
    (id) => isToolbarPresentationFeature(id) && presentation[id] === "demoted"
  ).length;
  const changes = [
    demoted > 0 ? `moves ${pluralize(demoted, "item")} into …` : null,
    promoted.length > 0 ? `shows ${pluralize(promoted.length, "plugin button")}` : null,
  ].filter((change): change is string => change !== null);
  const summary = overlay.active
    ? changes.length > 0
      ? `${project.name} ${changes.join(" and ")}. Buttons and order below apply everywhere else`
      : `${project.name} uses its own toolbar. Buttons and order below apply everywhere else`
    : `${project.name} has its own toolbar, turned off from the toolbar's menu. Its choices are kept`;

  return (
    <SettingsSection title="This project">
      <SettingsGroup>
        <SettingsRow
          label={overlay.active ? "Using this project's toolbar" : "Project toolbar off"}
          description={summary}
          rootAttributes={{ "data-testid": "project-toolbar-notice" }}
          control={({ descriptionId, disabled }) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void resetToolbar()}
              disabled={disabled}
              // The row's label is a state, not what the button does.
              aria-label="Reset this project's toolbar"
              aria-describedby={descriptionId}
            >
              Reset
            </Button>
          )}
        />
        {failedSave?.kind === "resetToolbar" && (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={retryFailedSave}>
                Retry
              </Button>
            }
          >
            <InlineError as="span" role="alert">
              Couldn&apos;t reset this project&apos;s toolbar
            </InlineError>
          </SettingsEmptyRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
