import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import type {
  ProjectLayoutSeedAdvance,
  ProjectLayoutSeedOutcome,
  ProjectLayoutSeedRecord,
  ProjectLayoutSeedStatus,
} from "../../../shared/types/plugin.js";

/**
 * Each project's first-open layout seed on this machine (#13782): whether a
 * project plugin's `surfaces.defaultLayout` may still be applied, only offered,
 * or neither.
 *
 * Decided once, on the project's first hydrate here, and never re-derived from
 * `state.json`: the file is written moments after that hydrate, and trust — the
 * moment a project plugin's layout can arrive — may come much later. A project
 * whose first hydrate was not a first open is recorded as settled, so a state
 * file cleared or quarantined later can never make it look new.
 *
 * No in-memory copy of the records, as in `projectSurfaceChoices.ts`: reads
 * happen once per view and writes once per project. The one thing held in
 * memory is who is applying a seed right now, which is exactly what must not
 * outlive this process.
 */
const STORE_KEY = "projectLayoutSeeds";

const STATUSES: readonly ProjectLayoutSeedStatus[] = [
  "pending",
  "offered",
  "applying",
  "failed",
  "settled",
];
const OUTCOMES: readonly ProjectLayoutSeedOutcome[] = [
  "applied",
  "opened",
  "dismissed",
  "ineligible",
];

/**
 * The only moves a seed makes. Only `failed → applying` goes back, and only on
 * the user's Retry: an apply reuses what is already open, so a retry opens
 * just what the failed attempt didn't.
 */
const NEXT: Record<ProjectLayoutSeedStatus, readonly ProjectLayoutSeedStatus[]> = {
  pending: ["offered", "applying", "settled"],
  offered: ["applying", "settled"],
  applying: ["failed", "settled"],
  failed: ["applying", "settled"],
  settled: [],
};

/**
 * project id → the webContents applying its seed. A stored `applying` with no
 * live claim here was cut short — this process quit, or the view crashed or
 * reloaded — so it reads as `failed`, never as still running.
 */
const claims = new Map<string, number>();

export function isProjectLayoutSeedStatus(value: unknown): value is ProjectLayoutSeedStatus {
  return STATUSES.some((status) => status === value);
}

export function isProjectLayoutSeedOutcome(value: unknown): value is ProjectLayoutSeedOutcome {
  return OUTCOMES.some((outcome) => outcome === value);
}

function requireProjectId(projectId: string): void {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("layout seed: projectId must be a project workspace id");
  }
}

/** Throws when the store cannot be read, so an unreadable record never reads as "first open". */
function readAll(): Record<string, unknown> {
  const stored = store.get(STORE_KEY) as unknown;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

/**
 * The file is user-editable. A malformed entry still says the project was seen,
 * so it reads as settled: it must never become a fresh first open.
 */
function parseRecord(value: unknown): ProjectLayoutSeedRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { status, outcome, at } = value as Record<string, unknown>;
    if (isProjectLayoutSeedStatus(status)) {
      return {
        status,
        ...(isProjectLayoutSeedOutcome(outcome) ? { outcome } : {}),
        at: typeof at === "number" ? at : 0,
      };
    }
  }
  return { status: "settled", outcome: "ineligible", at: 0 };
}

function write(projectId: string, record: ProjectLayoutSeedRecord): void {
  // Whole-key rewrite: electron-store dot-notation would nest on a key
  // containing dots, and a project id is opaque.
  store.set(STORE_KEY, { ...readAll(), [projectId]: record });
}

/** The project's seed, or `null` when its first hydrate has not been seen yet. */
export function getProjectLayoutSeed(projectId: string): ProjectLayoutSeedRecord | null {
  const all = readAll();
  if (!Object.hasOwn(all, projectId)) return null;
  const record = parseRecord(all[projectId]);
  return record.status === "applying" && !claims.has(projectId)
    ? { ...record, status: "failed" }
    : record;
}

/**
 * The view applying `projectId`'s seed went away: a crash, a reload, or its
 * window closing. Its claim lapses, so the seed reads as `failed` and another
 * view may retry it. A claim since taken by a different view is left alone.
 */
export function releaseProjectLayoutSeedClaim(projectId: string, claimant: number): void {
  if (claims.get(projectId) === claimant) claims.delete(projectId);
}

export function _resetProjectLayoutSeedClaimsForTest(): void {
  claims.clear();
}

/**
 * Record what the project's first hydrate on this machine found: `pending`
 * when it was a first open, `settled` otherwise. A project already recorded
 * keeps its record, so only the first hydrate ever decides.
 */
export function captureProjectLayoutSeed(
  projectId: string,
  firstOpen: boolean,
  now: number = Date.now()
): ProjectLayoutSeedRecord {
  requireProjectId(projectId);
  const existing = getProjectLayoutSeed(projectId);
  if (existing !== null) return existing;
  const record: ProjectLayoutSeedRecord = firstOpen
    ? { status: "pending", at: now }
    : { status: "settled", outcome: "ineligible", at: now };
  write(projectId, record);
  return record;
}

/**
 * Move the seed from `from` to `to`, only if it is still at `from`.
 *
 * The compare and the write run in one synchronous turn of main's event loop,
 * so of two views racing for the same project exactly one advances it. The
 * renderer claims a seed this way (`→ applying`) BEFORE opening anything, and
 * `claimant` — the claiming webContents — is the only caller that may then
 * settle or fail it. Settling without an outcome keeps the one the claim
 * recorded.
 */
export function advanceProjectLayoutSeed(
  projectId: string,
  from: ProjectLayoutSeedStatus,
  to: ProjectLayoutSeedStatus,
  outcome?: ProjectLayoutSeedOutcome,
  claimant?: number,
  now: number = Date.now()
): ProjectLayoutSeedAdvance {
  requireProjectId(projectId);
  if (!NEXT[from].includes(to)) {
    throw new Error(`layout seed: cannot move from ${from} to ${to}`);
  }
  if ((to === "applying" || from === "applying") && claimant === undefined) {
    throw new Error("layout seed: applying needs a claimant");
  }
  const current = getProjectLayoutSeed(projectId);
  if (current?.status !== from) return { advanced: false, record: current };
  if (from === "applying" && claims.get(projectId) !== claimant) {
    return { advanced: false, record: current };
  }
  const kept = outcome ?? current.outcome;
  const record: ProjectLayoutSeedRecord = {
    status: to,
    ...(kept !== undefined ? { outcome: kept } : {}),
    at: now,
  };
  write(projectId, record);
  if (from === "applying") claims.delete(projectId);
  if (to === "applying" && claimant !== undefined) claims.set(projectId, claimant);
  return { advanced: true, record };
}
