import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import {
  isLevelAllowed,
  isPresentationFeatureId,
  parsePresentationLevels,
  type PresentationFeatureId,
  type PresentationLevel,
  type PresentationLevels,
} from "../../../shared/config/presentationProfile.js";
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

/** The file is user-editable, so every level is checked and anything malformed is skipped. */
function parseEntry(value: unknown): StoredProjectPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { levels: {}, suggestionAnswers: parseAnswers(undefined), revision: 0 };
  }
  const entry = value as Record<string, unknown>;
  return {
    levels: parsePresentationLevels(entry.levels),
    suggestionAnswers: parseAnswers(entry.suggestionAnswers),
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
  return parseEntry(entry);
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
  return parseEntry(rawEntry(readAll(), projectId));
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
 * the suggested levels into the user's own profile — from then on they are the
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
  }
  // The answer just given always survives the cap, whatever timestamps an
  // edited file carries; the rest keep their most recent.
  const others = Object.entries(parseEntry(entry).suggestionAnswers)
    .filter(([key]) => key !== hash)
    .sort(([, a], [, b]) => a.decidedAt - b.decidedAt)
    .slice(-(MAX_REMEMBERED_ANSWERS - 1));
  entry.suggestionAnswers = Object.fromEntries([
    ...others,
    [hash, { answer, decidedAt: isTimestamp(now) ? now : 0 }],
  ]);
  return writeEntry(all, projectId, entry);
}
