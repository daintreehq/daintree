/**
 * A filesystem path whose lines can only end between folders. `break-all`
 * splits a folder name mid-token ("helios-dashboa / rd"), and a plain `<wbr>`
 * after each separator still leaves the browser's own breaks at the hyphens
 * and spaces inside a name — and the name is the part people read the path
 * for. So each segment is an atomic inline box that moves to the next line
 * whole; only a segment wider than the entire line breaks inside itself.
 *
 * Renders the segments only, so the caller keeps its own element, type and
 * colour. Don't put `break-all` on that element — it would override this.
 *
 * Chromium inserts a space between atomic inline boxes when it computes an
 * accessible name or description, so a path used as one — tooltip content,
 * an aria-describedby target — needs a plain-text `aria-label` beside it.
 */
export function PathSegments({ path }: { path: string }) {
  return path.split(/(?<=[/\\])/).map((segment, i) => (
    <span key={i} className="inline-block max-w-full break-all whitespace-pre-wrap">
      {segment}
    </span>
  ));
}
