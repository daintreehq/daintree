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
import { useDevPreviewOfferStore, type DevPreviewOfferReason } from "@/store/devPreviewOfferStore";
import { isGitBackedProject } from "@shared/types/project";
import {
  PRESENTATION_FEATURE_IDS,
  PRESENTATION_FEATURES,
  defaultPresentationLevel,
  isLauncherPresentationFeature,
  isPresentationFeatureAvailable,
  isProjectWidePresentationFeature,
  type PresentationFeatureDefinition,
  type PresentationFeatureId,
  type PresentationLevel,
} from "@shared/config/presentationProfile";

const LEVEL_LABELS: Record<PresentationLevel, string> = {
  shown: "Shown",
  demoted: "Demoted",
  hidden: "Hidden",
};

function levelLabel(feature: PresentationFeatureId, level: PresentationLevel): string {
  const definition: PresentationFeatureDefinition = PRESENTATION_FEATURES[feature];
  return definition.levelWords?.[level]?.label ?? LEVEL_LABELS[level];
}

/** A project-wide feature's own choice for "follow what the project looks like". */
const AUTO = "auto";
type FeatureChoice = PresentationLevel | typeof AUTO;

/** Why Auto lands where it does, mid-sentence after "Auto: Shown, ". */
const OFFER_REASONS: Record<Exclude<DevPreviewOfferReason, "unknown" | null>, string> = {
  always: "Always show dev preview is on",
  pinned: "its button is pinned to the toolbar",
  "in-use": "a dev preview is open",
  command: "a dev server command is set",
  "web-project": "this looks like a web project",
};

function autoDescription(level: PresentationLevel, reason: DevPreviewOfferReason): string {
  const label = LEVEL_LABELS[level];
  if (reason === "unknown") return `Auto: ${label}`;
  return `Auto: ${label}, ${reason === null ? "this doesn't look like a web project" : OFFER_REASONS[reason]}`;
}

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
  const retryFailedSave = useProjectPresentationStore((s) => s.retryFailedSave);
  const offerReason = useDevPreviewOfferStore((s) => s.reason);
  const devPreviewOffered = offerReason !== null;

  useEffect(() => {
    init();
    // The repository's file can change while the project is open (a pull, a
    // template update), so opening settings reads it again.
    if (isOpen) refresh();
  }, [init, refresh, isOpen]);

  const pending = usePendingSuggestion();

  const resolved = resolvePresentationFor(
    project,
    { levels, loaded, projectId: profileProjectId },
    devPreviewOffered
  );
  const gitBacked = project != null && isGitBackedProject(project);
  // Until main has answered for this project the rows show defaults and take
  // no input: a write made against an unknown profile could undo a choice the
  // user made in another window.
  const applies = project != null && loaded && profileProjectId === project.id;

  return (
    <SettingsSection
      id="project-features"
      title="Features"
      description="How much room each built-in surface takes in this project. Demoted items move out of the way but stay one click away, and hidden ones keep their commands in the palette."
    >
      <SettingsGroup>
        {/* The launcher's own features sit in its section below. */}
        {PRESENTATION_FEATURE_IDS.filter((id) => !isLauncherPresentationFeature(id)).map((id) => {
          const feature = PRESENTATION_FEATURES[id];
          const fallback = defaultPresentationLevel(id, { gitBacked, devPreviewOffered });
          const available = isPresentationFeatureAvailable(id, { gitBacked });
          if (isProjectWidePresentationFeature(id)) {
            // Auto is a choice of its own here, so picking the level Auto
            // happens to land on still holds when the project changes (#14069).
            return (
              <SettingsPresetGroup<FeatureChoice>
                key={id}
                id={`project-feature-${id}`}
                label={feature.label}
                description={`${feature.description} · ${autoDescription(fallback, offerReason)}`}
                options={[
                  { value: AUTO, label: "Auto" },
                  ...feature.levels.map((level) => ({
                    value: level,
                    label: levelLabel(id, level),
                  })),
                ]}
                value={applies ? (levels[id] ?? AUTO) : AUTO}
                onChange={(choice) => {
                  const level = choice === AUTO ? null : choice;
                  if (level === (levels[id] ?? null)) return;
                  void setLevel(id, level);
                }}
                isModified={applies && levels[id] !== undefined}
                onReset={() => void setLevel(id, null)}
                disabled={!applies}
              />
            );
          }
          return (
            <SettingsPresetGroup<PresentationLevel>
              key={id}
              id={`project-feature-${id}`}
              label={feature.label}
              description={`${feature.description} · Default: ${levelLabel(id, fallback)}`}
              options={feature.levels.map((level) => ({
                value: level,
                label: levelLabel(id, level),
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
        {((failedSave?.kind === "level" && !isLauncherPresentationFeature(failedSave.feature)) ||
          failedSave?.kind === "answer") && (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={retryFailedSave}>
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
