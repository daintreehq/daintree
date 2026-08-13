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
