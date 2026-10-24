// eager-import-allow: reads project welcome answers via store.get so recording one tour preserves other projects and earlier answers
import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import type { ProjectWelcomeRecord, ProjectWelcomeStatus } from "../../../shared/types/plugin.js";

/**
 * Each project's application welcome on this machine (#14106): whether the
 * user skipped or finished the welcome tour a project's application declares.
 * Keyed by project, then the declaring plugin's manifest id, then the tour, so
 * a project whose application changes hands keeps every earlier answer.
 *
 * Only the user's decision is kept. Whether the welcome is on offer is worked
 * out afresh from the descriptor: no record, or one made under a lower
 * `welcomeTour.version`, means it is.
 *
 * No in-memory copy, as in `projectPluginSetupSkips.ts`: reads happen when a
 * project view's application settles, and writes on a click.
 */
const STORE_KEY = "projectApplicationWelcomes";

/** Longest plugin manifest id a key may be; matches the setup skips bound. */
const MAX_OWNER_ID_LENGTH = 300;

/** Longest tour id, as the manifest schema allows. */
const MAX_TOUR_ID_LENGTH = 64;

const STATUSES: readonly ProjectWelcomeStatus[] = ["skipped", "completed"];

export function isProjectWelcomeStatus(value: unknown): value is ProjectWelcomeStatus {
  return STATUSES.some((status) => status === value);
}

export function isWelcomeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireKeys(projectId: string, ownerId: string, tourId: string): void {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("welcome: projectId must be a project workspace id");
  }
  if (ownerId.length === 0 || ownerId.length > MAX_OWNER_ID_LENGTH) {
    throw new Error("welcome: malformed plugin id");
  }
  if (tourId.length === 0 || tourId.length > MAX_TOUR_ID_LENGTH) {
    throw new Error("welcome: malformed tour id");
  }
}

/** The file is user-editable, so a malformed entry reads as no decision at all. */
function parseRecord(value: unknown): ProjectWelcomeRecord | null {
  const { version, status, at } = asRecord(value);
  if (!isWelcomeVersion(version) || !isProjectWelcomeStatus(status)) return null;
  return { version, status, at: typeof at === "number" ? at : 0 };
}

function readAll(): Record<string, unknown> {
  return asRecord(store.get(STORE_KEY) as unknown);
}

/** What the user last did with `ownerId`'s welcome tour `tourId` in `projectId`, or `null`. */
export function getProjectWelcome(
  projectId: string,
  ownerId: string,
  tourId: string
): ProjectWelcomeRecord | null {
  requireKeys(projectId, ownerId, tourId);
  return parseRecord(asRecord(asRecord(readAll()[projectId])[ownerId])[tourId]);
}

/**
 * Record that the user skipped or finished the welcome at `version`. A record
 * already made under a higher revision is kept — a plugin rolled back must not
 * bring a newer welcome the user already answered back on offer later — and
 * returned instead.
 */
export function setProjectWelcome(
  projectId: string,
  ownerId: string,
  tourId: string,
  version: number,
  status: ProjectWelcomeStatus,
  now: number = Date.now()
): ProjectWelcomeRecord {
  requireKeys(projectId, ownerId, tourId);
  if (!isWelcomeVersion(version)) throw new Error("welcome: version must be a positive integer");
  if (!isProjectWelcomeStatus(status)) throw new Error("welcome: unknown status");
  const all = readAll();
  const byOwner = asRecord(all[projectId]);
  const byTour = asRecord(byOwner[ownerId]);
  const existing = parseRecord(byTour[tourId]);
  if (existing !== null && existing.version > version) return existing;
  const record: ProjectWelcomeRecord = { version, status, at: now };
  // Whole-key rewrite: ids carry dots, which electron-store would nest on.
  store.set(STORE_KEY, {
    ...all,
    [projectId]: { ...byOwner, [ownerId]: { ...byTour, [tourId]: record } },
  });
  return record;
}
