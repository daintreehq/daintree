import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSelect, type SettingsSelectOption } from "@/components/Settings/SettingsSelect";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useProjectThemeStore } from "@/store/projectThemeStore";
import { selectSelectableSchemes } from "@/theme/selectableSchemes";
import { resolveAppTheme } from "@shared/theme";
import { useAllAppSchemes, useThemeSuggestion } from "./ProjectThemeNotice";

/** The select's value for "no theme of its own"; Radix refuses an empty one. */
const GLOBAL_THEME_VALUE = "__global__";

/**
 * "Theme" and, when the repository suggests one, "Suggested theme" rows for
 * Project settings → General (#13833). Instant apply, like the rest of the
 * page: a pick lands in Daintree's own store and repaints this project.
 */
export function ProjectThemeRows() {
  const refresh = useProjectThemeStore((s) => s.refresh);
  const failedSave = useProjectThemeStore((s) => s.failedSave);
  const retryFailedSave = useProjectThemeStore((s) => s.retryFailedSave);
  const setTheme = useProjectThemeStore((s) => s.setTheme);
  const answerSuggestion = useProjectThemeStore((s) => s.answerSuggestion);
  const resetSuggestion = useProjectThemeStore((s) => s.resetSuggestion);
  const answering = useProjectThemeStore((s) => s.answering);
  // What this view paints: seeded at boot and kept current by main's pushes, so
  // it is right before the settings read below has answered.
  const overrideId = useAppThemeStore((s) => s.projectSchemeId);
  const projectSnapshotScheme = useAppThemeStore((s) => s.projectSnapshotScheme);
  const globalScheme = useAppThemeStore((s) =>
    resolveAppTheme(s.selectedSchemeId, selectSelectableSchemes(s))
  );
  const schemes = useAllAppSchemes();
  const suggestion = useThemeSuggestion();

  // Every time the dialog opens: a checkout can change what the repository suggests.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const overrideScheme =
    overrideId === null
      ? null
      : (schemes.find((scheme) => scheme.id === overrideId) ??
        (projectSnapshotScheme?.id === overrideId ? projectSnapshotScheme : null));

  const options = useMemo((): SettingsSelectOption[] => {
    const list: SettingsSelectOption[] = [
      { value: GLOBAL_THEME_VALUE, label: "Use global theme" },
      ...schemes.map((scheme) => ({
        value: scheme.id,
        label: scheme.plugin ? `${scheme.name} · ${scheme.plugin.name}` : scheme.name,
      })),
    ];
    // Keep a theme that is gone selectable-as-shown, so the row says what is saved.
    if (overrideId !== null && !schemes.some((scheme) => scheme.id === overrideId)) {
      list.push({
        value: overrideId,
        label: overrideScheme?.name ?? "Unavailable theme",
        disabled: true,
      });
    }
    return list;
  }, [schemes, overrideId, overrideScheme]);

  const themeDescription =
    overrideId === null
      ? `Using global theme · ${globalScheme.name}`
      : overrideScheme === null
        ? `The chosen theme isn't available here, so the global theme shows · ${globalScheme.name}`
        : `Only this project. Global theme · ${globalScheme.name}`;

  // A suggestion failure sits on its own row, or on the Theme row once the
  // suggestion is gone, so its Retry is never left with nowhere to show.
  const failureOnSuggestionRow =
    failedSave !== null && failedSave.save.kind !== "theme" && suggestion !== null;
  const themeError =
    failedSave !== null && !failureOnSuggestionRow ? failedSave.message : undefined;
  const suggestionError = failureOnSuggestionRow && failedSave ? failedSave.message : undefined;

  let suggestionDescription: string | null = null;
  if (suggestion !== null) {
    const name = suggestion.scheme.name;
    suggestionDescription =
      suggestion.answer === "accepted"
        ? `This repository suggests ${name} · You chose to use it`
        : suggestion.answer === "declined"
          ? `This repository suggests ${name} · You kept your own choice`
          : `This repository suggests ${name}`;
  }
  const canUseSuggestion =
    suggestion !== null && suggestion.answer === null && overrideId !== suggestion.scheme.id;

  return (
    <>
      <SettingsSelect
        id="project-theme"
        label="Theme"
        description={themeDescription}
        value={overrideId ?? GLOBAL_THEME_VALUE}
        onValueChange={(value) => void setTheme(value === GLOBAL_THEME_VALUE ? null : value)}
        options={options}
        controlWidth="wide"
        isModified={overrideId !== null}
        onReset={() => void setTheme(null)}
        resetAriaLabel="Use the global theme in this project"
        error={themeError}
      />
      {suggestion !== null && suggestionDescription !== null && (
        <SettingsRow
          label="Suggested theme"
          description={suggestionDescription}
          isModified={suggestion.answer !== null}
          onReset={() => void resetSuggestion()}
          resetAriaLabel="Ask about the suggested theme again"
          error={suggestionError}
          control={
            suggestionError !== undefined ? (
              <Button variant="outline" size="sm" onClick={retryFailedSave}>
                Retry
              </Button>
            ) : canUseSuggestion ? (
              <Button
                variant="outline"
                size="sm"
                disabled={answering !== null}
                onClick={() => void answerSuggestion(suggestion.scheme.id, "accepted")}
              >
                Use theme
              </Button>
            ) : undefined
          }
        />
      )}
    </>
  );
}
