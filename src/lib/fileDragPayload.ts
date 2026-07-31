import { isAbsolute } from "@shared/utils/path";

/**
 * The `dataTransfer` type an in-app file drag carries (#11576).
 *
 * A drag started inside the renderer has no OS file handle, so it cannot
 * populate `dataTransfer.files` — the only thing it has is a path string. Every
 * drop handler that accepts OS files therefore learns a second type, and this
 * constant is the whole contract between them: the file browser writes it, the
 * hybrid input and the terminal read it.
 *
 * Lowercase because Chromium lowercases custom types on the way in, so a
 * mixed-case constant would never match what `types` reports back.
 *
 * Deliberately the ONLY type the drag carries. A `text/plain` fallback would
 * look harmless and double-insert: CodeMirror's own `drop` handler reads
 * `getData("Text")` and dispatches its own insertion, and it sits on the
 * content DOM *inside* the element carrying the hybrid input's drop handler —
 * so the raw path would land in the document alongside the `@file` chip. It
 * would also put the drag beyond `useFileDropGuard`'s reach, since a text drag
 * is one every editable surface in the app legitimately accepts.
 */
export const FILE_DRAG_MIME = "application/x-daintree-file-paths";

/**
 * Serializes the dragged paths for `dataTransfer.setData`.
 *
 * A list from the start even though the tree is single-select today (#11576):
 * multi-select is the obvious follow-up, and widening the payload later would
 * mean a second format both drop sites have to understand.
 */
export function encodeFileDragPaths(paths: readonly string[]): string {
  return JSON.stringify(paths);
}

/**
 * Does this path carry a C0 or C1 control character?
 *
 * A terminal's line discipline acts on these before any shell parses the
 * command, so shell-escaping the argument does not defuse them: ETX reads as
 * SIGINT whether or not it sits inside quotes. The terminal's own
 * `isDeliverablePath` already refuses CR, LF and ESC, but the drop handlers are
 * not the right place to hold this line — this type is settable by anything
 * that can start a drag, including a page loaded in a Browser panel, so the
 * payload is untrusted input and must not reach a formatter carrying one.
 *
 * A codepoint scan rather than a regex: a control-character class needs literal
 * control bytes in the source, which `no-control-regex` rejects outright.
 */
function hasControlCharacter(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Reads the payload back at drop time, or `null` if it is not one we wrote.
 *
 * Nothing about a `DataTransfer` is trustworthy enough to skip this: the string
 * only becomes readable at `drop` (Chromium's protected mode blanks `getData`
 * during `dragover`), so the affordance has already been shown by the time the
 * contents can be checked. A payload that fails here is a no-op drop rather
 * than a fallback to some other type.
 *
 * Paths must be absolute — a relative one names nothing the receiving agent
 * could open, since its cwd is not the file browser's base path. Order and
 * duplicates are preserved: dropping the same file twice is a thing a user can
 * mean, exactly as it is for the chip extensions.
 *
 * One bad entry rejects the whole list rather than filtering it. A partial drop
 * is the one outcome a user cannot tell apart from a complete one, and every
 * payload comes from a single gesture that either means all of its paths or is
 * not ours at all.
 */
export function decodeFileDragPaths(serialized: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const paths: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry === "" || !isAbsolute(entry)) return null;
    if (hasControlCharacter(entry)) return null;
    paths.push(entry);
  }
  return paths;
}

/** Is this an in-app file drag? Safe during `dragover` — reads types only. */
export function hasInternalFileDrag(types: readonly string[]): boolean {
  return types.includes(FILE_DRAG_MIME);
}

/**
 * Is this a drag a file-drop surface should accept — OS files or our own?
 *
 * The gate every `dragenter`/`dragover` handler uses, so the two never drift on
 * which drags light up the drop affordance.
 */
export function hasFileDrag(types: readonly string[]): boolean {
  return types.includes("Files") || hasInternalFileDrag(types);
}
