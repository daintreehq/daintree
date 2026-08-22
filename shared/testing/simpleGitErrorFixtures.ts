/**
 * Error shapes captured from the installed simple-git, for tests that classify
 * git failures.
 *
 * These are reproductions, not approximations. #11764 shipped green twice
 * because its fixtures were hand-written idealizations — a single-line
 * `"Error: spawn git ENOENT"` and a synthetic errno-bearing cause chain — that
 * satisfied detection which could never fire against the real thing. A fixture
 * that is easier to match than production input tests nothing.
 */

/**
 * What simple-git 3.36.0 throws when the `git` binary isn't on PATH.
 *
 * Its child-process `error` handler pushes `String(err.stack)` into the stderr
 * buffer, so Node's `SystemError` is destroyed and the whole stack trace
 * becomes the message. The rethrown `GitError` carries no `code`, `syscall`,
 * `errno`, or `cause` — its own properties are only `stack`, `message`, and
 * `task`.
 */
export const SIMPLE_GIT_MISSING_BINARY_MESSAGE =
  "Error: spawn git ENOENT\n" +
  "    at ChildProcess._handle.onexit (node:internal/child_process:287:19)\n" +
  "    at onErrorNT (node:internal/child_process:525:16)\n" +
  "    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)";

/**
 * Build the thrown value itself. `task` is the only own property simple-git
 * adds; `commands` defaults to the call the project-open path makes.
 */
export function simpleGitMissingBinaryError(
  commands: string[] = ["rev-parse", "--show-toplevel"]
): Error {
  const error = new Error(SIMPLE_GIT_MISSING_BINARY_MESSAGE);
  Object.assign(error, { task: { commands } });
  return error;
}

/**
 * What simple-git throws when the working directory is gone *before* it spawns
 * anything. Distinct from a missing binary on purpose: this one never reaches
 * spawn, so it must keep classifying as a problem with the folder.
 */
export const SIMPLE_GIT_MISSING_CWD_MESSAGE =
  "Cannot use simple-git on a directory that does not exist";

/** What `checkIsRepo()` runs — `CheckRepoActions` defaults to the in-tree check. */
export const REPOSITORY_PROBE_COMMANDS = ["rev-parse", "--is-inside-work-tree"];

/**
 * Build the value simple-git throws when git itself *ran* and exited nonzero.
 *
 * Distinct from {@link simpleGitMissingBinaryError}: nothing is laundered here,
 * because the child process started. simple-git concats stdout+stderr into
 * `.message` verbatim, so git's own `fatal:` line is the message and the only
 * discriminant a classifier ever gets.
 */
export function simpleGitStderrError(
  stderr: string,
  commands: string[] = REPOSITORY_PROBE_COMMANDS
): Error {
  const error = new Error(stderr);
  Object.assign(error, { task: { commands } });
  return error;
}

/**
 * Git's refusal to touch a repository whose on-disk owner differs from the
 * current user. A *repository is present* here — misreading it as "no
 * repository" is the failure #11922 fixed.
 */
export const GIT_DUBIOUS_OWNERSHIP_STDERR =
  "fatal: detected dubious ownership in repository at 'C:/Users/greg/OneDrive/Documents/Daintree/daintree'";

/**
 * The genuine "this folder has no repository" answer. simple-git's own
 * `checkIsRepoTask.onError` resolves this to `false` before it can ever be
 * thrown; the fixture exists to prove the classifier backstop agrees.
 */
export const GIT_NOT_A_REPOSITORY_STDERR =
  "fatal: not a git repository (or any of the parent directories): .git";

/**
 * A filesystem/permission fault against the repository path — the shape a
 * OneDrive placeholder stall or an antivirus interposition surfaces as.
 */
export const GIT_SYSTEM_IO_STDERR =
  "fatal: cannot change to 'C:/Users/greg/OneDrive/Documents/Daintree/daintree': EACCES";

/** simple-git's `GitPluginError` message when its block timeout kills the child. */
export const GIT_BLOCK_TIMEOUT_MESSAGE = "block timeout reached";
