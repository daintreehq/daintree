/**
 * Path accessors for the per-agent compile cache.
 *
 * Imports `node:path` and nothing else. `buildTerminalEnv` — the sole writer —
 * runs in the pty-host UtilityProcess where `electron` is unavailable, so this
 * module must never reach for `app.getPath`. Callers supply the userData root:
 * Main from `app.getPath("userData")`, the pty-host from `DAINTREE_USER_DATA`
 * (forwarded from that same value in `PtyHostLifecycle`, so the two agree).
 */
import path from "node:path";
import { AGENT_COMPILE_CACHE_DIRNAME } from "../../shared/config/agentCompileCache.js";

export function getAgentCompileCacheRoot(userDataPath: string): string {
  return path.join(userDataPath, AGENT_COMPILE_CACHE_DIRNAME);
}

/**
 * Resolve one agent's cache directory, or `null` when `agentId` is not a plain
 * directory name. Agent ids reach the spawn path from plugin manifests and
 * persisted launch config, so they are treated as untrusted.
 *
 * The check is that the result is an *immediate* child of the root, which is
 * stricter than `getScratchDir`'s containment test and necessarily so:
 * containment alone accepts `claude/nested` and `/etc/passwd`, both of which
 * land inside the root while putting the cleanup sweep's per-agent assumptions
 * (one level of agent dirs, one level of version dirs) out of step with the
 * write path.
 */
export function getAgentCompileCacheDir(userDataPath: string, agentId: string): string | null {
  if (typeof agentId !== "string" || agentId.length === 0) return null;
  // Reject on the RAW id, before normalization: `./claude`, `/claude` and
  // `claude/` all normalize to the same immediate child as `claude`, so a
  // containment check alone would silently accept several spellings of one
  // agent — different ids mapping to one cache directory. The colon covers
  // Windows drive-relative ids like `C:claude`, which is not a portable
  // directory component at all.
  if (/[/\\:\0]/.test(agentId) || agentId === "." || agentId === "..") return null;
  const root = path.normalize(getAgentCompileCacheRoot(userDataPath));
  const candidate = path.normalize(path.join(root, agentId));
  if (!candidate.startsWith(root + path.sep)) return null;
  if (path.dirname(candidate) !== root) return null;
  return candidate;
}
