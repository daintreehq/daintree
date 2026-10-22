import { isDeepStrictEqual } from "node:util";
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToProjectRenderers } from "../ipc/utils.js";
import { repaintAllWindowThemes } from "../window/projectThemeChrome.js";
import { getRegisteredProjectViews } from "../window/webContentsRegistry.js";
import { parseHostScopedKey } from "../../shared/types/remoteHosts.js";
import { getPluginTheme } from "./plugin/PluginThemeRegistry.js";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme/themes.js";
import {
  isPluginThemeId,
  parsePluginThemeId,
  toPluginThemeSnapshot,
} from "../../shared/theme/pluginThemes.js";
import { readProjectThemeChoice } from "../../shared/theme/projectThemes.js";
import type { ProjectThemeChoice, ProjectThemeSuggestionAnswer } from "../../shared/theme/types.js";

/**
 * Each project's own theme (#13833), under `appTheme.projectThemes` beside the
 * global selection: device-owned like it, and read synchronously by the boot
 * paths that paint a view before it has a renderer.
 *
 * No in-memory copy: reads happen when a view is created or a window repaints,
 * and writes on a click.
 */

function readThemeRecord(): Record<string, unknown> {
  const config = store.get("appTheme");
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function readAllChoices(config: Record<string, unknown>): Record<string, ProjectThemeChoice> {
  // Null prototype: the keys are project ids read from a user-editable file.
  const all = Object.create(null) as Record<string, ProjectThemeChoice>;
  const raw = config.projectThemes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return all;
  for (const projectId of Object.keys(raw)) {
    const choice = readProjectThemeChoice(config, projectId);
    if (choice) all[projectId] = choice;
  }
  return all;
}

function writeChoice(projectId: string, choice: ProjectThemeChoice | null): void {
  const all = readAllChoices(readThemeRecord());
  if (choice && Object.keys(choice).length > 0) all[projectId] = choice;
  else delete all[projectId];
  store.set("appTheme.projectThemes", { ...all });
}

export function getProjectThemeChoice(projectId: string): ProjectThemeChoice | null {
  return readProjectThemeChoice(readThemeRecord(), projectId);
}

/**
 * Tell every view of the project what it now shows — the settings row and the
 * suggestion notice can sit in different windows — and repaint the chrome of
 * any window showing it. The choice is stored under the bare project id, but a
 * remote view is routed by its host-scoped key, so each such key is sent to as
 * well.
 */
export function publishProjectThemeChoice(projectId: string): void {
  const change = { projectId, choice: getProjectThemeChoice(projectId) };
  const viewKeys = new Set([projectId]);
  for (const view of getRegisteredProjectViews()) {
    if (parseHostScopedKey(view.projectId).projectId === projectId) viewKeys.add(view.projectId);
  }
  for (const key of viewKeys) {
    broadcastToProjectRenderers(key, CHANNELS.PROJECT_THEME_CHANGED, change);
  }
  repaintAllWindowThemes();
}

function isCustomSchemeId(config: Record<string, unknown>, schemeId: string): boolean {
  const schemes = config.customSchemes;
  return (
    Array.isArray(schemes) &&
    schemes.some(
      (scheme) =>
        scheme !== null &&
        typeof scheme === "object" &&
        (scheme as Record<string, unknown>).id === schemeId
    )
  );
}

/**
 * Show `schemeId` in this project, or follow the global theme again with
 * `null`. A plugin theme must be offered right now, and its source is kept
 * beside the id so the boot paths paint it before the plugin loads, exactly
 * as the global selection does. Throws for an id that names no theme.
 */
export function setProjectThemeScheme(projectId: string, schemeId: string | null): void {
  const current = getProjectThemeChoice(projectId) ?? {};
  const next: ProjectThemeChoice = { ...current };
  delete next.colorSchemeId;
  delete next.pluginThemeSnapshot;

  if (schemeId !== null) {
    const id = schemeId.trim();
    if (!id) throw new Error("Not a valid theme id");
    if (isPluginThemeId(id)) {
      const theme = getPluginTheme(id);
      if (!theme) throw new Error(`No loaded plugin offers the theme "${id}"`);
      next.pluginThemeSnapshot = toPluginThemeSnapshot(theme.source);
    } else if (
      !BUILT_IN_APP_SCHEMES.some((scheme) => scheme.id === id) &&
      !isCustomSchemeId(readThemeRecord(), id)
    ) {
      throw new Error(`No theme has the id "${id}"`);
    }
    next.colorSchemeId = id;
  }
  writeChoice(projectId, next);
}

/**
 * Record the user's answer to the repository's suggested theme. Accepting
 * shows it in this project; declining changes nothing but the answer. Either
 * is remembered against `schemeId`, so a different suggestion asks again.
 */
export function answerProjectThemeSuggestion(
  projectId: string,
  schemeId: string,
  answer: ProjectThemeSuggestionAnswer
): void {
  if (answer === "accepted") setProjectThemeScheme(projectId, schemeId);
  const current = getProjectThemeChoice(projectId) ?? {};
  writeChoice(projectId, { ...current, suggestionAnswer: { schemeId, answer } });
}

/** Forget the answer, so the repository's suggestion is offered again. The theme stays. */
export function resetProjectThemeSuggestion(projectId: string): void {
  const current = getProjectThemeChoice(projectId);
  if (!current?.suggestionAnswer) return;
  const next = { ...current };
  delete next.suggestionAnswer;
  writeChoice(projectId, next);
}

/**
 * Settle projects showing a plugin theme against the plugin catalog, as
 * `reconcilePluginThemeSelection` does for the global one. One still offered
 * has its snapshot refreshed, picking up a palette update. One that is gone
 * loses its snapshot but keeps its id: the project shows the global theme
 * until the plugin offers it again, and the user's choice is never rewritten.
 * Returns the projects whose choice changed.
 */
export function reconcileProjectPluginThemes(canSettle: (pluginId: string) => boolean): string[] {
  const config = readThemeRecord();
  const all = readAllChoices(config);
  const changed: string[] = [];
  for (const [projectId, choice] of Object.entries(all)) {
    const id = choice.colorSchemeId;
    if (!id || !isPluginThemeId(id)) continue;
    if (!canSettle(parsePluginThemeId(id)?.pluginId ?? "")) continue;
    const offered = getPluginTheme(id);
    const snapshot = offered ? toPluginThemeSnapshot(offered.source) : undefined;
    if (isDeepStrictEqual(choice.pluginThemeSnapshot, snapshot)) continue;
    const next = { ...choice };
    if (snapshot) next.pluginThemeSnapshot = snapshot;
    else delete next.pluginThemeSnapshot;
    all[projectId] = next;
    changed.push(projectId);
  }
  if (changed.length > 0) store.set("appTheme.projectThemes", { ...all });
  return changed;
}
