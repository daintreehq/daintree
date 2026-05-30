/**
 * Shared helpers for the dev-preview Chromium session partition.
 *
 * The `<webview>` in `DevPreviewPane` and any `WebContentsView` that wants to
 * share its session (cookies, localStorage, IndexedDB) must derive the exact
 * same `persist:dev-preview-*` partition string. Keeping the formula here is the
 * single source of truth so the renderer component and the promote-to-portal
 * action can never drift apart.
 */

/** Normalize a single partition token to the `[a-z0-9_-]` charset. */
export function sanitizePartitionToken(value: string | undefined): string {
  const token = (value ?? "default").trim().toLowerCase();
  const sanitized = token.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
  return sanitized || "default";
}

/**
 * Build the stable `persist:dev-preview-*` partition for a dev-preview panel.
 * `worktreeId` defaults to `"main"` to match the renderer's webview formula.
 */
export function buildDevPreviewPartition(
  projectId: string | undefined,
  worktreeId: string | undefined,
  panelId: string | undefined
): string {
  const projectToken = sanitizePartitionToken(projectId);
  const worktreeToken = sanitizePartitionToken(worktreeId ?? "main");
  const panelToken = sanitizePartitionToken(panelId);
  return `persist:dev-preview-${projectToken}-${worktreeToken}-${panelToken}`;
}

/**
 * Matches a well-formed dev-preview partition. Used by the main-process portal
 * handler to validate a renderer-supplied partition override before reusing it
 * for a `WebContentsView`; non-matching values fall back to `persist:portal`.
 */
export const DEV_PREVIEW_PARTITION_PATTERN =
  /^persist:dev-preview-[a-z0-9_-]+-[a-z0-9_-]+-[a-z0-9_-]+$/;

/** True when `value` is a syntactically valid dev-preview partition. */
export function isDevPreviewPartition(value: unknown): value is string {
  return typeof value === "string" && DEV_PREVIEW_PARTITION_PATTERN.test(value);
}
