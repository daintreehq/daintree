/**
 * Structural identity of a workspace id, usable from any process.
 *
 * Projects and scratches are disjoint id spaces — 64 hex characters versus a
 * dashed UUIDv4 — which is what lets one snapshot, one state directory and one
 * view manager carry both kinds without collision (#11518, #11484).
 *
 * The shape is the authority on which kind an id is. Asking a renderer store
 * instead ("is this id in `scratches`?") answers a different question: whether
 * that list has finished loading. Both stores hydrate asynchronously, so a
 * membership test says "not a scratch" during the boot window and routes a
 * scratch through the project path, where it fails.
 */
const SCRATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PROJECT_ID_PATTERN = /^[0-9a-f]{64}$/;

export function isScratchWorkspaceId(id: string): boolean {
  return SCRATCH_ID_PATTERN.test(id);
}

export function isProjectWorkspaceId(id: string): boolean {
  return PROJECT_ID_PATTERN.test(id);
}
