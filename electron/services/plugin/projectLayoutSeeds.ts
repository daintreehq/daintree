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
 * No in-memory copy, as in `projectSurfaceChoices.ts`: reads happen once per
 * view and writes once per project.
 */
const STORE_KEY = "projectLayoutSeeds";

const STATUSES: readonly ProjectLayoutSeedStatus[] = ["pending", "offered", "settled"];
const OUTCOMES: readonly ProjectLayoutSeedOutcome[] = [
  "applied",
  "opened",
  "dismissed",
  "ineligible",
];

/** The only moves a seed makes; each is one-way, so nothing ever runs twice. */
const NEXT: Record<ProjectLayoutSeedStatus, readonly ProjectLayoutSeedStatus[]> = {
  pending: ["offered", "settled"],
  offered: ["settled"],
  settled: [],
};

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
  return Object.hasOwn(all, projectId) ? parseRecord(all[projectId]) : null;
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
 * renderer consumes a seed this way BEFORE applying anything: an apply that is
 * interrupted is never replayed, which is what "never runs twice" costs.
 */
export function advanceProjectLayoutSeed(
  projectId: string,
  from: ProjectLayoutSeedStatus,
  to: ProjectLayoutSeedStatus,
  outcome?: ProjectLayoutSeedOutcome,
  now: number = Date.now()
): ProjectLayoutSeedAdvance {
  requireProjectId(projectId);
  if (!NEXT[from].includes(to)) {
    throw new Error(`layout seed: cannot move from ${from} to ${to}`);
  }
  const current = getProjectLayoutSeed(projectId);
  if (current?.status !== from) return { advanced: false, record: current };
  const record: ProjectLayoutSeedRecord = {
    status: to,
    ...(outcome !== undefined ? { outcome } : {}),
    at: now,
  };
  write(projectId, record);
  return { advanced: true, record };
}
