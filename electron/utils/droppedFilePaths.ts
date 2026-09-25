/**
 * The preload's `files.getDroppedFilePaths`: one native path per dropped or
 * pasted File, in order, `""` for a File with nothing on disk behind it. Takes
 * `webUtils.getPathForFile` as an argument so the binding can be exercised
 * without the Electron sandbox.
 *
 * `grant`, when given, is told the non-empty paths as they are resolved. A
 * remote-bound view passes one that records them in main as files the person
 * chose there: a real File from a drop, paste or file input is the only thing
 * `getPathForFile` resolves, so page code can't mint one for a path it names.
 */
export function buildDroppedFilePathsBinding<F>(
  getPathForFile: (file: F) => string,
  grant?: (paths: string[]) => void
): (files: readonly F[]) => string[] {
  return (files) => {
    const paths = Array.from(files, (file) => getPathForFile(file));
    if (grant) {
      const resolved = paths.filter((path) => path !== "");
      if (resolved.length > 0) grant(resolved);
    }
    return paths;
  };
}
