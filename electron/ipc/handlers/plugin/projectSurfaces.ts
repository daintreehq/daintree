import { AppError } from "../../../utils/errorTypes.js";
import {
  getProjectLayoutSeed,
  releaseProjectLayoutSeedClaim,
  isProjectLayoutSeedStatus,
  isProjectLayoutSeedOutcome,
  advanceProjectLayoutSeed,
} from "../../../services/plugin/projectLayoutSeeds.js";
import {
  getProjectWelcome,
  isWelcomeVersion,
  isProjectWelcomeStatus,
  setProjectWelcome,
} from "../../../services/plugin/projectApplicationWelcomes.js";
import { onWebContentsDestroyed } from "../../../window/webContentsDestroyed.js";
import {
  type ProjectLayoutSeedRecord,
  type ProjectLayoutSeedStatus,
  type ProjectLayoutSeedOutcome,
  type ProjectLayoutSeedAdvance,
  type ProjectWelcomeRecord,
  type ProjectWelcomeStatus,
  type ProjectSurfacesSnapshot,
  type ProjectSurfaceSlotKey,
  type ProjectSurfaceChoice,
  isProjectSurfaceSlotKey,
  isProjectSurfaceChoice,
  type ProjectSurfaceChoiceUpdate,
  MAX_PROJECT_SURFACE_UPDATES,
} from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import { getPluginService } from "./service.js";

/**
 * The SENDER's project's first-open layout seed (#13782); `null` for a view
 * with no project, or one whose project has not finished its first hydrate.
 */
export async function handleProjectLayoutSeedGet(
  ctx: IpcContext
): Promise<ProjectLayoutSeedRecord | null> {
  if (!ctx.projectId) return null;
  return getProjectLayoutSeed(ctx.projectId);
}

/** project id → stops watching the view whose claim on that project's seed is live. */
const seedClaimWatches = new Map<string, () => void>();

/**
 * The claim lapses with the view that holds it: a crash, a reload, its window
 * closing or a remote client dropping leaves nothing to finish the apply, so
 * the seed reads as failed and waits for a Retry.
 */
function watchSeedClaim(ctx: IpcContext, projectId: string): void {
  seedClaimWatches.get(projectId)?.();
  const claimant = ctx.webContentsId;
  const sender = ctx.event?.sender;
  const release = (): void => {
    unwatch();
    releaseProjectLayoutSeedClaim(projectId, claimant);
  };
  // A remote view has no WebContents here; its endpoint closing is the only
  // sign it went away.
  const closed = ctx.endpoint.onClose(release);
  sender?.once("did-navigate", release);
  sender?.once("render-process-gone", release);
  const offDestroyed = sender ? onWebContentsDestroyed(sender, release) : undefined;
  function unwatch(): void {
    closed.dispose();
    sender?.removeListener("did-navigate", release);
    sender?.removeListener("render-process-gone", release);
    offDestroyed?.();
    if (seedClaimWatches.get(projectId) === unwatch) seedClaimWatches.delete(projectId);
  }
  seedClaimWatches.set(projectId, unwatch);
  if (ctx.endpoint.isClosed()) release();
}

/**
 * Move the SENDER's project's seed from `from` to `to`, only if it is still at
 * `from`. The renderer claims the seed this way (`→ applying`) before it opens
 * anything, so two views of one project can never both apply it, and only the
 * claiming view can then settle or fail it.
 */
export async function handleProjectLayoutSeedAdvance(
  ctx: IpcContext,
  from: ProjectLayoutSeedStatus,
  to: ProjectLayoutSeedStatus,
  outcome?: ProjectLayoutSeedOutcome
): Promise<ProjectLayoutSeedAdvance> {
  if (!ctx.projectId) {
    throw new AppError({ code: "VALIDATION", message: "layout seed: sender has no project" });
  }
  if (!isProjectLayoutSeedStatus(from) || !isProjectLayoutSeedStatus(to)) {
    throw new AppError({ code: "VALIDATION", message: "layout seed: unknown status" });
  }
  if (outcome !== undefined && !isProjectLayoutSeedOutcome(outcome)) {
    throw new AppError({ code: "VALIDATION", message: "layout seed: unknown outcome" });
  }
  let result: ProjectLayoutSeedAdvance;
  try {
    result = advanceProjectLayoutSeed(ctx.projectId, from, to, outcome, ctx.webContentsId);
  } catch (error) {
    // A finish storage refused has already let the claim go.
    if (from === "applying") seedClaimWatches.get(ctx.projectId)?.();
    throw error;
  }
  if (result.advanced) {
    if (from === "applying") seedClaimWatches.get(ctx.projectId)?.();
    if (to === "applying") watchSeedClaim(ctx, ctx.projectId);
  }
  return result;
}

function requireWelcomeKeys(ownerId: unknown, tourId: unknown): void {
  if (typeof ownerId !== "string" || typeof tourId !== "string") {
    throw new AppError({ code: "VALIDATION", message: "welcome: ids must be strings" });
  }
}

/** The SENDER project's answer to `ownerId`'s welcome tour `tourId` (#14106); `null` for none. */
export async function handleProjectWelcomeGet(
  ctx: IpcContext,
  ownerId: string,
  tourId: string
): Promise<ProjectWelcomeRecord | null> {
  requireWelcomeKeys(ownerId, tourId);
  if (!ctx.projectId) return null;
  return getProjectWelcome(ctx.projectId, ownerId, tourId);
}

/** Record that the user skipped or finished the SENDER project's application welcome. */
export async function handleProjectWelcomeSet(
  ctx: IpcContext,
  ownerId: string,
  tourId: string,
  version: number,
  status: ProjectWelcomeStatus
): Promise<ProjectWelcomeRecord> {
  requireWelcomeKeys(ownerId, tourId);
  if (!ctx.projectId) {
    throw new AppError({ code: "VALIDATION", message: "welcome: sender has no project" });
  }
  if (!isWelcomeVersion(version)) {
    throw new AppError({
      code: "VALIDATION",
      message: "welcome: version must be a positive integer",
    });
  }
  if (!isProjectWelcomeStatus(status)) {
    throw new AppError({ code: "VALIDATION", message: "welcome: unknown status" });
  }
  return setProjectWelcome(ctx.projectId, ownerId, tourId, version, status);
}

export async function handleProjectSurfacesGet(
  ctx: IpcContext
): Promise<ProjectSurfacesSnapshot | null> {
  // Same init-race guard as handlePanelKindsGet: a mount-time pull before the
  // deferred initialize() would cache "no surfaces" and leave the project on
  // its stock canvas until the next push.
  const svc = await getPluginService();
  await svc.waitForCatalog();
  if (!ctx.projectId) return null;
  return svc.getProjectSurfacesSnapshot(ctx.projectId);
}

/**
 * Remember the user's answer about a slot in the SENDER's project (`null`
 * forgets it). Takes no plugin id: main records an exclusive answer against
 * the slot's current owner, and checks a selectable one's `optionId` against
 * what is on offer, so a renderer cannot pre-answer for a plugin that has not
 * claimed the slot.
 */
export async function handleProjectSurfaceChoiceSet(
  ctx: IpcContext,
  slot: ProjectSurfaceSlotKey,
  choice: ProjectSurfaceChoice | null,
  optionId?: string
): Promise<ProjectSurfacesSnapshot> {
  if (!ctx.projectId) throw new Error("project surfaces: sender has no project");
  if (!isProjectSurfaceSlotKey(slot)) throw new Error("project surfaces: unknown surface slot");
  if (choice !== null && !isProjectSurfaceChoice(choice)) {
    throw new Error('project surfaces: choice must be "surface", "stock" or null');
  }
  if (optionId !== undefined && (typeof optionId !== "string" || optionId.length === 0)) {
    throw new Error("project surfaces: optionId must be a non-empty string");
  }
  const svc = await getPluginService();
  // The owner comes from the claim registry, which the startup scan fills.
  await svc.waitForCatalog();
  return svc.setProjectSurfaceChoice(ctx.projectId, slot, choice, optionId);
}

/**
 * Remember one answer about several slots in the SENDER's project, in one write
 * — a consent notice answers for every slot one plugin set up. Each update is
 * checked as {@link handleProjectSurfaceChoiceSet} checks its arguments, and
 * main resolves each against the slot's current owner the same way — refusing
 * the lot if an update names an owner the slot has since passed from.
 */
export async function handleProjectSurfaceChoicesSet(
  ctx: IpcContext,
  updates: ProjectSurfaceChoiceUpdate[]
): Promise<ProjectSurfacesSnapshot> {
  if (!ctx.projectId) throw new Error("project surfaces: sender has no project");
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("project surfaces: an answer needs at least one slot");
  }
  if (updates.length > MAX_PROJECT_SURFACE_UPDATES) {
    throw new Error("project surfaces: more updates than one answer can name");
  }
  for (const update of updates as unknown[]) {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw new Error("project surfaces: an update must be an object");
    }
    const { slot, choice, optionId, ownerId } = update as Record<string, unknown>;
    if (!isProjectSurfaceSlotKey(slot)) throw new Error("project surfaces: unknown surface slot");
    if (choice !== null && !isProjectSurfaceChoice(choice)) {
      throw new Error('project surfaces: choice must be "surface", "stock" or null');
    }
    if (optionId !== undefined && (typeof optionId !== "string" || optionId.length === 0)) {
      throw new Error("project surfaces: optionId must be a non-empty string");
    }
    if (ownerId !== undefined && (typeof ownerId !== "string" || ownerId.length === 0)) {
      throw new Error("project surfaces: ownerId must be a non-empty string");
    }
  }
  const svc = await getPluginService();
  // The owner comes from the claim registry, which the startup scan fills.
  await svc.waitForCatalog();
  return svc.setProjectSurfaceChoices(ctx.projectId, updates);
}
