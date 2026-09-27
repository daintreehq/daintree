import { Fragment } from "react";

/**
 * A path or branch with a line-break opportunity after every separator, so a
 * long one wraps at a directory boundary instead of mid-name. The wrapper's
 * `overflow-wrap: anywhere` still catches a single segment wider than the box.
 */
export function PathText({ value }: { value: string }) {
  const parts = value.split(/(?<=[/\\])/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}
