import { getAppThemeById } from "./themes.js";
import { withSelectedPluginTheme } from "./pluginThemes.js";
import type {
  AppColorScheme,
  PluginThemeSnapshot,
  ProjectThemeChoice,
  ProjectThemeSuggestionAnswer,
} from "./types.js";

/**
 * A project's own theme (#13833). The global theme stays the user's default;
 * a project shows another only when the user chose one for it, and colour
 * vision and the accent override still apply on top of whichever it shows.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSuggestionAnswer(value: unknown): ProjectThemeChoice["suggestionAnswer"] {
  if (!isRecord(value)) return undefined;
  const { schemeId, answer } = value;
  if (typeof schemeId !== "string" || !schemeId.trim()) return undefined;
  if (answer !== "accepted" && answer !== "declined") return undefined;
  return { schemeId: schemeId.trim(), answer: answer as ProjectThemeSuggestionAnswer };
}

/**
 * `projectId`'s choice in a theme config, or null when it has none. The store
 * is plain JSON on disk, so every field is checked; the plugin snapshot is
 * passed through for `readPluginThemeSnapshot` to validate where it is used.
 */
export function readProjectThemeChoice(
  themeConfig: unknown,
  projectId: string | null | undefined
): ProjectThemeChoice | null {
  if (!projectId || !isRecord(themeConfig)) return null;
  const all = themeConfig.projectThemes;
  if (!isRecord(all) || !Object.hasOwn(all, projectId)) return null;
  const raw = all[projectId];
  if (!isRecord(raw)) return null;

  const choice: ProjectThemeChoice = {};
  if (typeof raw.colorSchemeId === "string" && raw.colorSchemeId.trim()) {
    choice.colorSchemeId = raw.colorSchemeId.trim();
    if (isRecord(raw.pluginThemeSnapshot)) {
      choice.pluginThemeSnapshot = raw.pluginThemeSnapshot as unknown as PluginThemeSnapshot;
    }
  }
  const answer = parseSuggestionAnswer(raw.suggestionAnswer);
  if (answer) choice.suggestionAnswer = answer;
  return Object.keys(choice).length > 0 ? choice : null;
}

/**
 * The theme a project's choice names, or null when it names none or one that
 * no longer resolves (a deleted imported theme, a plugin theme whose plugin is
 * gone and whose snapshot was dropped). Null means the project shows the
 * global theme; the choice itself is kept, so the theme returns if it does.
 */
export function resolveProjectThemeOverride(
  choice: ProjectThemeChoice | null | undefined,
  schemes: readonly AppColorScheme[]
): AppColorScheme | null {
  const id = choice?.colorSchemeId;
  if (!id) return null;
  return getAppThemeById(id, withSelectedPluginTheme(schemes, choice)) ?? null;
}

/** The answer recorded for `suggestedSchemeId`, or null when that suggestion is unanswered. */
export function projectThemeSuggestionAnswer(
  choice: ProjectThemeChoice | null | undefined,
  suggestedSchemeId: string | null | undefined
): ProjectThemeSuggestionAnswer | null {
  const recorded = choice?.suggestionAnswer;
  if (!recorded || !suggestedSchemeId) return null;
  return recorded.schemeId === suggestedSchemeId ? recorded.answer : null;
}
