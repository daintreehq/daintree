import { Fragment } from "react";

/**
 * One block per stack line with a hanging indent, and a break opportunity after
 * every slash: a wrapped frame then breaks between path segments and continues
 * under its own "at", instead of splitting a word and starting flush left
 * where it reads as the next frame. `<wbr>` adds nothing to copied text.
 */
export function StackLines({ text }: { text: string }) {
  return text.split("\n").map((line, i) => (
    <span key={i} className="block pl-[6ch] -indent-[6ch]">
      {line === ""
        ? "\u00a0"
        : line.split("/").map((part, j) => (
            <Fragment key={j}>
              {j > 0 && (
                <>
                  /<wbr />
                </>
              )}
              {part}
            </Fragment>
          ))}
    </span>
  ));
}
