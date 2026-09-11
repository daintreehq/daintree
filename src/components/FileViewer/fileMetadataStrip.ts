/**
 * The one geometry and type treatment for the file panel's metadata strip.
 *
 * Source mode renders the reader's strip (`FilePane`) and Edit mode renders the
 * editor's (`MarkdownEditorStatusBar`); toggling the mode swaps one for the
 * other in place. They were two copies of the same class string, which is how
 * they came to differ by 8px once the editor's strip grew a button — enough to
 * shift the document's first line under the cursor on every toggle. Sharing the
 * constant makes the alignment structural rather than a convention two files
 * have to keep.
 *
 * `h-7` rather than vertical padding: the editor's strip contains an `xs`
 * button (`h-6`) and the reader's contains one line of `text-xs`, so only an
 * explicit height makes the two agree. UI sans rather than mono — mono belongs
 * on the numerics, which carry `tabular-nums` individually, not on the labels.
 */
export const FILE_METADATA_STRIP_CLASS =
  "flex h-7 shrink-0 items-center gap-3 border-b border-border-default px-3 text-xs text-text-secondary";

/**
 * The run of facts inside the strip. Shared for the same reason the row is:
 * matching the row height stops the document jumping vertically on a mode
 * toggle, but only matching the item spacing stops the byte count sliding
 * sideways under the cursor at the same moment.
 *
 * `min-w-0 flex-1 truncate` is the priority rule — under width pressure the
 * reference metadata is what yields, because a clipped byte count costs less
 * than a clipped answer to "are my edits safe?".
 */
export const FILE_METADATA_RUN_CLASS = "flex min-w-0 flex-1 items-center gap-1.5 truncate";
