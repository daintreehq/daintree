/**
 * The preload's `files.getDroppedFilePaths`: one native path per dropped or
 * pasted File, in order, `""` for a File with nothing on disk behind it. Takes
 * `webUtils.getPathForFile` as an argument so the binding can be exercised
 * without the Electron sandbox.
 */
export function buildDroppedFilePathsBinding<F>(
  getPathForFile: (file: F) => string
): (files: readonly F[]) => string[] {
  return (files) => Array.from(files, (file) => getPathForFile(file));
}
