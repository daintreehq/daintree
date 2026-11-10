import { Fragment, type ReactNode } from "react";

/**
 * The dimmed dot between two facts in a run of reference metadata. Hidden
 * from assistive tech, which reads the facts themselves; `text-muted` is
 * allowed here only because the dot carries no information. It has no spacing
 * of its own: the row's gap, or the spaces around it in running text, set that.
 */
export function FactSeparator() {
  return (
    <span aria-hidden="true" className="text-text-muted">
      ·
    </span>
  );
}

/**
 * Facts in running text with a separator between each pair. The spaces around
 * each dot are real text, so the facts stay apart once the hidden dots drop out
 * of an accessible name.
 */
export function FactRun({ facts }: { facts: readonly ReactNode[] }) {
  return (
    <>
      {facts.map((fact, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <>
              {" "}
              <FactSeparator />{" "}
            </>
          )}
          {fact}
        </Fragment>
      ))}
    </>
  );
}
