// eager-import-allow: reads presentation profiles via store.get for settings snapshots and updates that preserve other projects' answers
import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../../../shared/types/plugin.js";
import {
  MAX_PROMOTED_PLUGIN_BUTTONS,
  PRESENTATION_FEATURE_IDS,
  isLevelAllowed,
  isToolbarPresentationFeature,
  isPresentationFeatureId,
  parsePresentationLevels,
  type PresentationFeatureId,
  type PresentationLevel,
  type PresentationLevels,
} from "../../../shared/config/presentationProfile.js";
import {
  isFeaturedLaunchEntryRef,
  parseLauncherGroupOrder,
} from "../../../shared/config/launcherArrangement.js";
import type {
  PresentationSuggestion,
  PresentationSuggestionAnswer,
  PresentationSuggestionAnswerRecord,
} from "../../../shared/types/ipc/projectPresentation.js";

/**
 * Each project's presentation profile (#13771), in Daintree's own store and
 * never in the repository: the levels the user set or accepted, and their
 * answers to the repository's suggestions.
 *
 * No in-memory copy, as in `projectSurfaceChoices.ts`: reads happen on a view's
 * first mount and writes on a click.
 */
const STORE_KEY = "projectPresentation";

/**
 * Answers are remembered per suggestion, not just the latest one, so switching
 * between two branches whose files suggest different things asks about each
 * once rather than on every switch. Bounded, oldest first out.
 */
export const MAX_REMEMBERED_ANSWERS = 16;

type AnswerEntry = Omit<PresentationSuggestionAnswerRecord, "hash">;

export interface StoredProjectPresentation {
  levels: PresentationLevels;
  /** Suggestion hash → the user's answer to it. */
  suggestionAnswers: Record<string, AnswerEntry>;
  /** "Use this project's toolbar" as last set, or `null` for never set. */
  useProjectToolbar: boolean | null;
  /** This project's own plugin buttons promoted onto its toolbar, in the order promoted. */
  promotedPluginButtons: string[];
  /** The user's order for the launcher's groups (#13791); empty for never set. */
  launcherGroupOrder: string[];
  /** The project plugin entry the launcher preselects, or `null`. */
  featuredLaunchEntry: string | null;
  /**
   * Bumped on every write and kept on disk, so it only ever grows — across
   * restarts too. A view drops any snapshot older than one it already holds:
   * pushes and invoke replies reach a remote view on separate lanes, and an
   * older push can land after a newer reply.
   */
  revision: number;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseAnswer(value: unknown): AnswerEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { answer, decidedAt } = value as Record<string, unknown>;
  if (answer !== "accepted" && answer !== "declined") return null;
  return { answer, decidedAt: isTimestamp(decidedAt) ? decidedAt : 0 };
}

function parseRevision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function parseAnswers(value: unknown): Record<string, AnswerEntry> {
  // Null prototype: the keys are hashes read from a user-editable file.
  const answers = Object.create(null) as Record<string, AnswerEntry>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return answers;
  for (const [hash, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = parseAnswer(raw);
    if (hash.length > 0 && parsed !== null) answers[hash] = parsed;
  }
  return answers;
}

/**
 * Whether `buttonId` is a toolbar button of a plugin loaded for `projectId`
 * itself. Plugin button ids are `{instanceKey}.{id}`, and a project plugin's
 * instance key names its project, so an installed plugin's button — or
 * another project's — never passes.
 */
export function isOwnProjectPluginButtonId(projectId: string, buttonId: unknown): boolean {
  if (typeof buttonId !== "string" || buttonId.length > 512) return false;
  if (projectIdFromPluginInstanceKey(buttonId) !== projectId) return false;
  // `{publisher}.{name}.{button}`: manifest names are always `publisher.name`
  // with no dot in either half, so a bare instance key — a plugin, not one of
  // its buttons — has one dot fewer.
  const [publisher = "", name = "", ...button] =
    pluginManifestIdFromInstanceKey(buttonId).split(".");
  return publisher.length > 0 && name.length > 0 && button.join(".").length > 0;
}

/** Deduped, own-project only and capped: the list is read from a user-editable file (#10938). */
function parsePromoted(projectId: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const id of value) {
    if (out.length >= MAX_PROMOTED_PLUGIN_BUTTONS) break;
    if (isOwnProjectPluginButtonId(projectId, id) && !out.includes(id as string)) {
      out.push(id as string);
    }
  }
  return out;
}

/** The file is user-editable, so every level is checked and anything malformed is skipped. */
function parseEntry(projectId: string, value: unknown): StoredProjectPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      levels: {},
      suggestionAnswers: parseAnswers(undefined),
      useProjectToolbar: null,
      promotedPluginButtons: [],
      launcherGroupOrder: [],
      featuredLaunchEntry: null,
      revision: 0,
    };
  }
  const entry = value as Record<string, unknown>;
  return {
    levels: parsePresentationLevels(entry.levels),
    suggestionAnswers: parseAnswers(entry.suggestionAnswers),
    useProjectToolbar:
      typeof entry.useProjectToolbar === "boolean" ? entry.useProjectToolbar : null,
    promotedPluginButtons: parsePromoted(projectId, entry.promotedPluginButtons),
    launcherGroupOrder: parseLauncherGroupOrder(entry.launcherGroupOrder),
    featuredLaunchEntry: isFeaturedLaunchEntryRef(entry.featuredLaunchEntry)
      ? entry.featuredLaunchEntry
      : null,
    revision: parseRevision(entry.revision),
  };
}

/** The user's answer to `suggestion`, if they gave one. */
export function answerFor(
  stored: StoredProjectPresentation,
  suggestion: PresentationSuggestion | null
): PresentationSuggestionAnswerRecord | null {
  if (suggestion === null || !Object.hasOwn(stored.suggestionAnswers, suggestion.hash)) {
    return null;
  }
  return { hash: suggestion.hash, ...stored.suggestionAnswers[suggestion.hash]! };
}

function readAll(): Record<string, unknown> {
  const stored = store.get(STORE_KEY) as unknown;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

function rawEntry(all: Record<string, unknown>, projectId: string): Record<string, unknown> {
  const stored = Object.hasOwn(all, projectId) ? all[projectId] : undefined;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? { ...(stored as Record<string, unknown>) }
    : {};
}

function rawLevels(entry: Record<string, unknown>): Record<string, unknown> {
  const levels = entry.levels;
  return levels && typeof levels === "object" && !Array.isArray(levels)
    ? { ...(levels as Record<string, unknown>) }
    : {};
}

/**
 * Write one project's entry back, one revision on. Whole-key rewrite:
 * electron-store dot-notation would nest on a key containing dots, and a
 * project id is opaque. A read failure has already propagated by now — writing
 * from a map we could not read would delete every other project's profile.
 *
 * The entry is kept even with nothing set, for its revision: dropping it would
 * start the count again, below what an open view already holds.
 */
function writeEntry(
  all: Record<string, unknown>,
  projectId: string,
  entry: Record<string, unknown>
): StoredProjectPresentation {
  entry.revision = parseRevision(entry.revision) + 1;
  store.set(STORE_KEY, { ...all, [projectId]: entry });
  return parseEntry(projectId, entry);
}

function assertProjectId(projectId: string): void {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("project presentation: projectId must be a project workspace id");
  }
}

/**
 * One project's stored profile.
 *
 * Throws when the store cannot be read. Unreadable is not the same as "never
 * set": read as empty, it would put back everything the user quietened and ask
 * the suggestion question again.
 */
export function getProjectPresentation(projectId: string): StoredProjectPresentation {
  return parseEntry(projectId, rawEntry(readAll(), projectId));
}

/**
 * Set one feature's level, or with `null` return it to its default. Merged into
 * the raw entry, not a parsed copy, so a level for a feature this build does
 * not know — written by a newer one — survives a downgrade.
 */
export function setProjectPresentationLevel(
  projectId: string,
  feature: PresentationFeatureId,
  level: PresentationLevel | null
): StoredProjectPresentation {
  assertProjectId(projectId);
  if (!isPresentationFeatureId(feature)) {
    throw new Error("project presentation: unknown feature");
  }
  if (level !== null && !isLevelAllowed(feature, level)) {
    throw new Error(`project presentation: ${feature} has no level ${String(level)}`);
  }
  const all = readAll();
  const entry = rawEntry(all, projectId);
  const levels = rawLevels(entry);
  if (level === null) {
    delete levels[feature];
  } else {
    levels[feature] = level;
    // Choosing a toolbar level is choosing this project's toolbar.
    if (isToolbarPresentationFeature(feature)) delete entry.useProjectToolbar;
  }
  if (Object.keys(levels).length === 0) {
    delete entry.levels;
  } else {
    entry.levels = levels;
  }
  return writeEntry(all, projectId, entry);
}

/**
 * Record the user's answer to the repository's suggestion. Accepting copies
 * the suggested levels, and any featured launcher entry, into the user's own
 * profile — from then on they are the
 * user's, edited and reset like any other — and declining changes no level.
 * Either way the answer is remembered against the suggestion's hash, so the
 * question comes back only when the repository suggests something new, and a
 * suggestion answered before never reapplies itself when it comes back.
 *
 * `suggestion` is what main read from the file just now, never what the
 * renderer says it showed: an answer about anything else is refused, so a
 * stale notice cannot accept levels the user never saw.
 */
export function answerProjectPresentationSuggestion(
  projectId: string,
  suggestion: PresentationSuggestion | null,
  hash: string,
  answer: PresentationSuggestionAnswer,
  now: number = Date.now()
): StoredProjectPresentation {
  assertProjectId(projectId);
  if (answer !== "accepted" && answer !== "declined") {
    throw new Error('project presentation: answer must be "accepted" or "declined"');
  }
  if (suggestion === null || suggestion.hash !== hash) {
    throw new Error("project presentation: the repository's suggestion has changed");
  }
  const all = readAll();
  const entry = rawEntry(all, projectId);
  if (answer === "accepted") {
    entry.levels = { ...rawLevels(entry), ...suggestion.levels };
    if (Object.keys(suggestion.levels).some((id) => isToolbarPresentationFeature(id as never))) {
      delete entry.useProjectToolbar;
    }
    if (suggestion.featuredLaunchEntry !== undefined) {
      entry.featuredLaunchEntry = suggestion.featuredLaunchEntry;
    }
  }
  // The answer just given always survives the cap, whatever timestamps an
  // edited file carries; the rest keep their most recent.
  const others = Object.entries(parseEntry(projectId, entry).suggestionAnswers)
    .filter(([key]) => key !== hash)
    .sort(([, a], [, b]) => a.decidedAt - b.decidedAt)
    .slice(-(MAX_REMEMBERED_ANSWERS - 1));
  entry.suggestionAnswers = Object.fromEntries([
    ...others,
    [hash, { answer, decidedAt: isTimestamp(now) ? now : 0 }],
  ]);
  return writeEntry(all, projectId, entry);
}

/**
 * Turn "Use this project's toolbar" on or off (#13783). Off keeps every
 * toolbar level and promotion stored, so turning it back on restores them.
 */
export function setProjectToolbarEnabled(
  projectId: string,
  enabled: boolean
): StoredProjectPresentation {
  assertProjectId(projectId);
  if (typeof enabled !== "boolean") {
    throw new Error("project presentation: enabled must be a boolean");
  }
  const all = readAll();
  const entry = rawEntry(all, projectId);
  entry.useProjectToolbar = enabled;
  return writeEntry(all, projectId, entry);
}

/**
 * Promote one of this project's own plugin buttons onto its toolbar, or take
 * it back to the tray. Added or removed one id at a time against what is on
 * disk, so two windows promoting different buttons both land.
 *
 * Removal takes any id, so a button whose plugin has gone can still be let go.
 */
export function setProjectPluginButtonPromoted(
  projectId: string,
  buttonId: string,
  promoted: boolean
): StoredProjectPresentation {
  assertProjectId(projectId);
  if (typeof buttonId !== "string" || buttonId.length === 0) {
    throw new Error("project presentation: buttonId is required");
  }
  if (promoted && !isOwnProjectPluginButtonId(projectId, buttonId)) {
    throw new Error("project presentation: only this project's own plugin buttons can be promoted");
  }
  const all = readAll();
  const entry = rawEntry(all, projectId);
  const current = parsePromoted(projectId, entry.promotedPluginButtons).filter(
    (id) => id !== buttonId
  );
  if (promoted) {
    if (current.length >= MAX_PROMOTED_PLUGIN_BUTTONS) {
      throw new Error(
        `project presentation: at most ${MAX_PROMOTED_PLUGIN_BUTTONS} plugin buttons can be promoted`
      );
    }
    current.push(buttonId);
  }
  if (current.length === 0) {
    delete entry.promotedPluginButtons;
  } else {
    entry.promotedPluginButtons = current;
  }
  return writeEntry(all, projectId, entry);
}

/**
 * Put the app-wide toolbar back for this project: every toolbar feature's
 * level, every promotion and the toggle are cleared. Levels for features off
 * the toolbar, suggestion answers and the revision stay.
 */
export function resetProjectToolbar(projectId: string): StoredProjectPresentation {
  assertProjectId(projectId);
  const all = readAll();
  const entry = rawEntry(all, projectId);
  const levels = rawLevels(entry);
  for (const id of PRESENTATION_FEATURE_IDS) {
    if (isToolbarPresentationFeature(id)) delete levels[id];
  }
  if (Object.keys(levels).length === 0) {
    delete entry.levels;
  } else {
    entry.levels = levels;
  }
  delete entry.promotedPluginButtons;
  delete entry.useProjectToolbar;
  return writeEntry(all, projectId, entry);
}

/**
 * Set the user's order for the launcher's groups (#13791), or with `[]` hand
 * the order back to the profile. Replaced whole: the order is one choice made
 * in one list, and ids it names that are not drawn right now are the
 * renderer's to keep.
 */
export function setProjectLauncherGroupOrder(
  projectId: string,
  order: readonly string[]
): StoredProjectPresentation {
  assertProjectId(projectId);
  if (!Array.isArray(order)) {
    throw new Error("project presentation: order must be an array");
  }
  const parsed = parseLauncherGroupOrder(order);
  if (parsed.length !== order.length) {
    throw new Error("project presentation: order holds an invalid or repeated group");
  }
  const all = readAll();
  const entry = rawEntry(all, projectId);
  if (parsed.length === 0) {
    delete entry.launcherGroupOrder;
  } else {
    entry.launcherGroupOrder = parsed;
  }
  return writeEntry(all, projectId, entry);
}

/**
 * Feature one launcher entry (#13791), or with `null` feature none. Shape only
 * here; the handler checks the entry is the project's own. Clearing takes no
 * check, so an entry whose plugin has gone can still be let go.
 */
export function setProjectFeaturedLaunchEntry(
  projectId: string,
  ref: string | null
): StoredProjectPresentation {
  assertProjectId(projectId);
  if (ref !== null && !isFeaturedLaunchEntryRef(ref)) {
    throw new Error("project presentation: featured entry must be {publisher.name}.{entry id}");
  }
  const all = readAll();
  const entry = rawEntry(all, projectId);
  if (ref === null) {
    delete entry.featuredLaunchEntry;
  } else {
    entry.featuredLaunchEntry = ref;
  }
  return writeEntry(all, projectId, entry);
}
