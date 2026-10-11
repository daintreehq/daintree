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
 * `value` in the partition charset, one way only: lowercase letters and
 * digits stay, every other UTF-16 unit becomes `_` and four hex digits. No
 * two inputs share an output, and the output never holds `-` or `__`.
 */
function escapePartitionPart(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    out += /[a-z0-9]/.test(char) ? char : `_${value.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return out;
}

/** A 53-bit string hash (cyrb53), as hex. Not a secret: it only shortens names. */
function shortHash(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Partition names are directory names, so a part is its escape while that is
 * short, and otherwise `-` and a hash of it: an escape never holds `-`, so
 * the two forms can't meet. Only a long part's hash can collide, and that
 * needs two long ids from the same source: host ids are this machine's own
 * and a host's project ids only meet that host's other projects.
 */
const MAX_ESCAPED_PART = 64;

function partitionPart(value: string): string {
  const escaped = escapePartitionPart(value);
  return escaped.length <= MAX_ESCAPED_PART ? escaped : `-${shortHash(value)}`;
}

/** The start every partition key for `hostId`'s projects shares. */
export function remotePartitionKeyPrefix(hostId: string): string {
  return `remote__${partitionPart(hostId)}__`;
}

/**
 * The project part of a browser or dev-preview partition: the project id, and
 * in a window attached to another machine that machine's id with it. A
 * host's project ids are its own, so without the host a host project could
 * share a local project's cookies and storage by claiming its id. The host
 * part holds no `__`, so the key reads back one way only and no two hosts
 * share one (a local id is hex and never starts `remote__`).
 */
export function partitionProjectKey(
  projectId: string | undefined,
  hostId: string | null | undefined
): string | undefined {
  if (!hostId || projectId === undefined) return projectId;
  return `${remotePartitionKeyPrefix(hostId)}${partitionPart(projectId)}`;
}

/**
 * The portal's session in a window attached to `hostId`: that host's own,
 * apart from this machine's `persist:portal`. Its `-portal` tail is no form
 * a project id can take, so no project's browser panel can share it.
 */
export function remotePortalPartition(hostId: string): string {
  return buildBrowserPartition(`${remotePartitionKeyPrefix(hostId)}-portal`);
}

/** Whether `partition` is some host's portal session ({@link remotePortalPartition}). */
export function isRemotePortalPartition(partition: string): boolean {
  return /^persist:browser-remote__[a-z0-9_-]+__-portal$/.test(partition);
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

/**
 * Build the per-project `persist:browser-*` partition for a Browser panel.
 *
 * Browser sessions are scoped by project (cookies/localStorage/IndexedDB for a
 * site like `localhost:3000` or `github.com` belong to the project context, not
 * a single worktree or panel instance), so this needs only `projectId`. A
 * missing id sanitizes to `persist:browser-default`.
 */
export function buildBrowserPartition(projectId: string | undefined): string {
  return `persist:browser-${sanitizePartitionToken(projectId)}`;
}

/**
 * Matches a Browser panel partition. Accepts both the scoped
 * `persist:browser-{token}` form produced by `buildBrowserPartition` and the
 * legacy bare `persist:browser` string so sessions created by older builds (or
 * still cached by Electron) keep being classified and locked down correctly.
 */
export const BROWSER_PARTITION_PATTERN = /^persist:browser(-[a-z0-9_-]+)?$/;

/**
 * True when `value` is a syntactically valid Browser panel partition.
 *
 * Returns a plain `boolean` rather than a `value is string` predicate: callers
 * pass an already-typed `string` and chain this in `||` with other partition
 * checks, where a negative type-guard branch would wrongly narrow `string` to
 * `never` (a non-browser partition is still a string).
 */
export function isBrowserPartition(value: unknown): boolean {
  return typeof value === "string" && BROWSER_PARTITION_PATTERN.test(value);
}
