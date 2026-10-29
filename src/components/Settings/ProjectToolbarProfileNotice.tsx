import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SECTION_SETTINGS } from "@/components/Settings/settingsSectionOwners";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { useProjectToolbarOverlay, useResolvedPresentation } from "@/hooks/useResolvedPresentation";
import { useProjectStore } from "@/store/projectStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject } from "@/store/viewWorkspace";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { pluralize } from "@/lib/pluralize";
import {
  PRESENTATION_FEATURE_IDS,
  isToolbarPresentationFeature,
} from "@shared/config/presentationProfile";

/**
 * Settings → Toolbar's switch for the current project's own toolbar (#13783).
 * Everything else on the page is app-wide; this turns the project's overlay on
 * and off. It is the keyboard and Windows route to the toggle the toolbar's
 * empty-space menu also offers (#15232): that menu is right-click only, and on
 * Windows the OS claims the click.
 *
 * Renders nothing until the project's profile has loaded.
 */
export function ProjectToolbarProfileNotice() {
  // The view's own project, which is the one main writes — not the globally
  // broadcast `currentProject`, which a sibling window can repoint.
  const viewWorkspaceId = getViewWorkspaceId();
  const project = useProjectStore((s) => selectViewProject(viewWorkspaceId, s));
  const overlay = useProjectToolbarOverlay();
  const presentation = useResolvedPresentation();
  const promoted = useProjectPresentationStore((s) => s.promotedPluginButtons);
  const failedSave = useProjectPresentationStore((s) => s.failedSave);
  const setToolbarEnabled = useProjectPresentationStore((s) => s.setToolbarEnabled);
  const retryFailedSave = useProjectPresentationStore((s) => s.retryFailedSave);

  if (project == null || !overlay.available) return null;

  const demoted = PRESENTATION_FEATURE_IDS.filter(
    (id) => isToolbarPresentationFeature(id) && presentation[id] === "demoted"
  ).length;
  const changes = [
    demoted > 0 ? `moves ${pluralize(demoted, "item")} into …` : null,
    promoted.length > 0 ? `shows ${pluralize(promoted.length, "plugin button")}` : null,
  ].filter((change): change is string => change !== null);
  // The overlay sits on the app-wide layout below rather than replacing it,
  // so that layout still shapes this project's toolbar.
  const summary = overlay.active
    ? changes.length > 0
      ? `${project.name} ${changes.join(" and ")}, on top of the buttons and order below`
      : `Buttons shown or hidden from the toolbar apply to ${project.name} only, on top of the buttons and order below`
    : overlay.hasOverrides
      ? `${project.name} uses the app-wide toolbar. Its own choices are kept for when this is back on`
      : `Lets buttons shown or hidden from the toolbar apply to ${project.name} only`;

  return (
    <SettingsSection title="This project" settings={SECTION_SETTINGS.projectToolbar}>
      <SettingsGroup rootAttributes={{ "data-testid": "project-toolbar-notice" }}>
        <SettingsSwitchCard
          title="Use this project's toolbar"
          subtitle={summary}
          isEnabled={overlay.active}
          onChange={() => void setToolbarEnabled(!overlay.active)}
        />
        {failedSave?.kind === "toolbarEnabled" && (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={retryFailedSave}>
                Retry
              </Button>
            }
          >
            <InlineError as="span" role="alert">
              Couldn&apos;t save this project&apos;s toolbar
            </InlineError>
          </SettingsEmptyRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}

/**
 * "Reset this project's toolbar", a row for the page's closing reset group.
 * It clears choices that have no undo, so it asks first. Renders nothing
 * when the project's profile sets nothing for the toolbar.
 */
export function ProjectToolbarResetRow() {
  const viewWorkspaceId = getViewWorkspaceId();
  const project = useProjectStore((s) => selectViewProject(viewWorkspaceId, s));
  const overlay = useProjectToolbarOverlay();
  const useProjectToolbar = useProjectPresentationStore((s) => s.useProjectToolbar);
  const failedSave = useProjectPresentationStore((s) => s.failedSave);
  const resetToolbar = useProjectPresentationStore((s) => s.resetToolbar);
  const retryFailedSave = useProjectPresentationStore((s) => s.retryFailedSave);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  if (project == null || !overlay.available) return null;
  if (!overlay.hasOverrides && useProjectToolbar === null) return null;

  return (
    <>
      <SettingsRow
        label="Reset this project's toolbar"
        description={`Clears which items ${project.name} shows or moves into …, the plugin buttons it adds and whether it uses its own toolbar`}
        rootAttributes={{ "data-testid": "project-toolbar-reset" }}
        control={({ descriptionId, disabled }) => (
          <Button
            type="button"
            variant="ghost-danger"
            size="sm"
            onClick={() => setIsConfirmOpen(true)}
            disabled={disabled}
            aria-describedby={descriptionId}
          >
            Reset project toolbar
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
      <ConfirmDialog
        isOpen={isConfirmOpen}
        variant="destructive"
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={() => {
          setIsConfirmOpen(false);
          void resetToolbar();
        }}
        title={`Reset ${project.name}'s toolbar?`}
        description={`The items ${project.name} shows or moves into …, the plugin buttons it adds and whether it uses its own toolbar are all cleared, so it goes back to the app-wide toolbar. The app-wide toolbar isn't changed.`}
        confirmLabel="Reset project toolbar"
      />
    </>
  );
}
