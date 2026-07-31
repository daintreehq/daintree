/**
 * Ceilings for agent-facing git/worktree reads (#11531).
 *
 * Action `resultSchema` is advertised documentation only — `ActionService.dispatch`
 * returns `run()` output unvalidated — so every limit here must be applied by real
 * code inside `run()`, never by declaring a narrower schema.
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
 * Read ceiling for synthesizing an untracked/added file's diff, where the whole
 * file becomes the diff body and so must be held in memory. Tracked files have no
 * such ceiling — their diff is bounded by the size of the change, not the file.
 */
export const GIT_FILE_DIFF_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
