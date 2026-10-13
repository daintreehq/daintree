import path from "node:path";

/**
 * Whether `next` has the shape of electron-updater's rename of `previous`.
 * AppImageUpdater keeps the directory and swaps the file name for the
 * update's, and it renames only an image whose name carries a version (one
 * without keeps its name). An image missing from anywhere else — another
 * install, or a drive that isn't mounted — is not this one moved.
 */
export function isAppImageUpdateRename(previous: string, next: string): boolean {
  return (
    previous !== next &&
    path.dirname(previous) === path.dirname(next) &&
    /\d+\.\d+\.\d+/.test(path.basename(previous))
  );
}
