import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsPresetGroup } from "@/components/Settings/SettingsPresetGroup";
import {
  describeChanges,
  usePendingSuggestion,
} from "@/components/Project/ProjectPresentationNotice";
import { resolvePresentationFor } from "@/hooks/useResolvedPresentation";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { isGitBackedProject } from "@shared/types/project";
import {
  PRESENTATION_FEATURE_IDS,
  PRESENTATION_FEATURES,
  defaultPresentationLevel,
  isPresentationFeatureAvailable,
  type PresentationLevel,
} from "@shared/config/presentationProfile";

const LEVEL_LABELS: Record<PresentationLevel, string> = {
  shown: "Shown",
  demoted: "Demoted",
  hidden: "Hidden",
};

/**
 * Project settings → General → Features (#13771): this project's presentation
 * profile, one row per feature in the host's closed vocabulary. Instant apply,
 * through main, so every view of the project follows at once.
 *
 * Choosing a feature's default clears its entry rather than storing it, so
 * "modified" means exactly "set for this project", and a project that later
 * gains or loses its repository follows the new default.
 */
export function PresentationFeaturesSection({ isOpen }: { isOpen: boolean }) {
  const project = useProjectStore((s) => s.currentProject);
  const init = useProjectPresentationStore((s) => s.init);
  const refresh = useProjectPresentationStore((s) => s.refresh);
  const levels = useProjectPresentationStore((s) => s.levels);
  const loaded = useProjectPresentationStore((s) => s.loaded);
  const loadFailed = useProjectPresentationStore((s) => s.loadFailed);
  const profileProjectId = useProjectPresentationStore((s) => s.projectId);
  const failedSave = useProjectPresentationStore((s) => s.failedSave);
  const setLevel = useProjectPresentationStore((s) => s.setLevel);
  const answerSuggestion = useProjectPresentationStore((s) => s.answerSuggestion);

  useEffect(() => {
    init();
    // The repository's file can change while the project is open (a pull, a
    // template update), so opening settings reads it again.
    if (isOpen) refresh();
  }, [init, refresh, isOpen]);

  const pending = usePendingSuggestion();

  const resolved = resolvePresentationFor(project, { levels, loaded, projectId: profileProjectId });
  const gitBacked = project != null && isGitBackedProject(project);
  // Until main has answered for this project the rows show defaults and take
  // no input: a write made against an unknown profile could undo a choice the
  // user made in another window.
  const applies = project != null && loaded && profileProjectId === project.id;

  const retry = () => {
    if (failedSave === null) return;
    if (failedSave.kind === "level") void setLevel(failedSave.feature, failedSave.level);
    else void answerSuggestion(failedSave.hash, failedSave.answer);
  };

  return (
    <SettingsSection
      id="project-features"
      title="Features"
      description="How much room each built-in surface takes in this project. Demoted items move out of the way but stay one click away, and hidden ones keep their commands in the palette."
    >
      <SettingsGroup>
        {PRESENTATION_FEATURE_IDS.map((id) => {
          const feature = PRESENTATION_FEATURES[id];
          const fallback = defaultPresentationLevel(id, { gitBacked });
          const available = isPresentationFeatureAvailable(id, { gitBacked });
          return (
            <SettingsPresetGroup<PresentationLevel>
              key={id}
              id={`project-feature-${id}`}
              label={feature.label}
              description={`${feature.description} · Default: ${LEVEL_LABELS[fallback]}`}
              options={feature.levels.map((level) => ({
                value: level,
                label: LEVEL_LABELS[level],
              }))}
              value={resolved[id]}
              onChange={(level) => {
                if (level === resolved[id]) return;
                void setLevel(id, level === fallback ? null : level);
              }}
              // A stored choice stays visible even where it can't apply: it
              // takes effect the day the folder becomes a repository.
              isModified={applies && levels[id] !== undefined}
              onReset={() => void setLevel(id, null)}
              disabled={!applies || !available}
              disabledReason={
                applies && !available
                  ? "Needs a git repository. Initialize one to use it."
                  : undefined
              }
            />
          );
        })}
        {pending !== null && (
          <SettingsRow
            label="Suggested by this repository"
            description={`${describeChanges(pending.changes)} · From .daintree/presentation.json`}
            control={() => (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void answerSuggestion(pending.hash, "accepted")}
              >
                Apply suggestion
              </Button>
            )}
          />
        )}
        {loadFailed && !applies && (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={refresh}>
                Retry
              </Button>
            }
          >
            <InlineError as="span" role="alert">
              Couldn&apos;t read this project&apos;s features
            </InlineError>
          </SettingsEmptyRow>
        )}
        {failedSave !== null && (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={retry}>
                Retry
              </Button>
            }
          >
            <InlineError as="span" role="alert">
              Couldn&apos;t save the change
            </InlineError>
          </SettingsEmptyRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
