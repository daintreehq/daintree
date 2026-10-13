type SudoRunner = (commandWithArgs: string[]) => string;
type DoInstall = (options: unknown) => boolean;

// pkexec exits 126 when the password dialog was dismissed and 127 when
// authorisation failed or no authentication agent answered.
const REFUSED_PROMPT = /^Command pkexec exited with code 12[67]$/;

export type LinuxPackageInstallOutcome = "installed" | "failed";

/**
 * The deb, rpm and pacman updaters: the ones that install through
 * `runCommandWithSudoIfNeeded`, i.e. behind an administrator password prompt.
 */
export function isLinuxPackageUpdater(updater: object): boolean {
  const target = updater as { runCommandWithSudoIfNeeded?: unknown; doInstall?: unknown };
  return (
    process.platform === "linux" &&
    typeof target.runCommandWithSudoIfNeeded === "function" &&
    typeof target.doInstall === "function"
  );
}

/**
 * Runs `install` (electron-updater's `quitAndInstall`) for a Linux package and
 * reports whether the package went in, or null for any other updater, which
 * runs untouched.
 *
 * Once the password prompt is refused, every later privileged command of the
 * same install is refused without being run. DebUpdater reads any failure of
 * `dpkg -i` as broken dependencies and retries `apt-get install -f -y` under a
 * second pkexec, and PacmanUpdater retries after `pacman -Sy`, so a Cancel
 * opened a second password prompt for a command the user never asked for.
 *
 * The outcome comes from the updater's own `doInstall`: `quitAndInstall()`
 * returns nothing, and on failure it only skips scheduling its quit.
 */
export function runLinuxPackageInstall(
  updater: object,
  install: () => void
): LinuxPackageInstallOutcome | null {
  if (!isLinuxPackageUpdater(updater)) {
    install();
    return null;
  }
  const target = updater as { runCommandWithSudoIfNeeded: SudoRunner; doInstall: DoInstall };
  const runner = target.runCommandWithSudoIfNeeded;
  const doInstall = target.doInstall;
  const hadOwnRunner = Object.hasOwn(target, "runCommandWithSudoIfNeeded");
  const hadOwnDoInstall = Object.hasOwn(target, "doInstall");
  let refused = false;
  let installed = false;

  target.runCommandWithSudoIfNeeded = (commandWithArgs) => {
    if (refused) {
      throw new Error(
        `Not running ${commandWithArgs[0]}: the administrator password prompt was refused`
      );
    }
    try {
      return runner.call(target, commandWithArgs);
    } catch (err) {
      if (err instanceof Error && REFUSED_PROMPT.test(err.message)) refused = true;
      throw err;
    }
  };
  target.doInstall = (options) => {
    installed = doInstall.call(target, options) === true;
    return installed;
  };
  try {
    install();
  } finally {
    if (hadOwnRunner) target.runCommandWithSudoIfNeeded = runner;
    else delete (target as Partial<typeof target>).runCommandWithSudoIfNeeded;
    if (hadOwnDoInstall) target.doInstall = doInstall;
    else delete (target as Partial<typeof target>).doInstall;
  }
  return installed ? "installed" : "failed";
}
