/**
 * The dimmed dot between two facts in a run of reference metadata. Hidden
 * from assistive tech, which reads the facts themselves; `text-muted` is
 * allowed here only because the dot carries no information.
 */
export function FactSeparator() {
  return (
    <span aria-hidden="true" className="text-text-muted">
      ·
    </span>
  );
}
