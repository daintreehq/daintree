/**
 * Ceilings for agent-facing git/worktree reads (#11531).
 *
 * Every limit here must be applied by real code inside `run()`, never by declaring
 * a narrower schema. `ActionService.dispatch` does parse results against
 * `resultSchema` (#11539), but a parse strips undeclared keys — it cannot cap a
 * count, a byte length, or a page size, and a schema that tried would reject the
 * oversized result instead of trimming it.
 */

export const GIT_LIST_COMMITS_LIMIT_DEFAULT = 30;
export const GIT_LIST_COMMITS_LIMIT_MAX = 100;
/** Per-commit body ceiling; bodies beyond this are cut and flagged `bodyTruncated`. */
export const GIT_COMMIT_BODY_MAX_BYTES = 1024;

export const GIT_PAGE_LIMIT_DEFAULT = 100;
export const GIT_PAGE_LIMIT_MAX = 200;

/** Recent-commit ceiling for `git.getProjectPulse` (the service already asks for 8). */
export const PULSE_RECENT_COMMITS_MAX = 10;
/** Ceiling for any single free-text field echoed back to an agent (commit subjects, rebase steps). */
export const GIT_SUBJECT_MAX_BYTES = 512;

/** Default window for `git.getFileDiff`, sized for an MCP tool response. */
export const GIT_FILE_DIFF_DEFAULT_MAX_BYTES = 24 * 1024;
/**
 * Hard ceiling for one `git.getFileDiff` window. Also the transport ceiling: the
 * renderer diff panes request exactly this, preserving the 1MB capacity they had
 * before windowing replaced the all-or-nothing FILE_TOO_LARGE cliff.
 */
export const GIT_FILE_DIFF_MAX_BYTES = 1024 * 1024;
/**
 * Source-size ceiling applied before a diff is produced at all. Both paths hold a
 * full result in memory before it can be windowed — the untracked path inlines the
 * file, and git buffers a tracked file's whole diff — so the gate gives peak memory
 * an upper bound. Sixteen times the 1MB cliff it replaced, which refused any file
 * over 1MB regardless of how small its diff was.
 */
export const GIT_FILE_DIFF_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
