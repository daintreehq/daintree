/**
 * When a changed-file list stops rendering every row.
 *
 * Below this, the Review Hub's sections, its base-branch list and the diff
 * shelf render exactly as they always have: one DOM node per file, no
 * virtualizer, no measurement, no windowed-range bookkeeping. Ordinary reviews
 * are small, and windowing them would buy nothing while putting a scroll
 * container's worth of new failure modes between the user and their files.
 *
 * 80 is chosen against the row, not the viewport. A comfortable-density
 * `FileStageRow` is ~32px, so ~80 rows is roughly three screens of the tallest
 * list — far enough past the fold that mounting the rest is waste, close enough
 * that a reviewer who scrolls the whole list never notices the seam.
 */
export const FILE_LIST_VIRTUALIZATION_THRESHOLD = 80;

/**
 * Whether a list of `count` rows should window.
 *
 * Takes the count the surface actually renders as one scrollable body — for the
 * Review Hub's working tree that is staged plus unstaged, because the two
 * sections share a scroll container and a keyboard cursor, and two 79-row
 * sections are a 158-row list wearing a hat.
 */
export function shouldVirtualizeFileList(count: number): boolean {
  return count >= FILE_LIST_VIRTUALIZATION_THRESHOLD;
}
