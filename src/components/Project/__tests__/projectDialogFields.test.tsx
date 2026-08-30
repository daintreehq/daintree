/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PathCaption, FIELD_INPUT_CLASS } from "../projectDialogFields";

afterEach(cleanup);

/**
 * `PathCaption` exists so a filesystem path elides its ancestors rather than
 * its leaf — the leaf is what identifies the project, and a plain `truncate`
 * eats exactly that. These assert the rule, not any particular rendered width:
 * the split point is a layout decision that can change, the invariants can't.
 */
describe("PathCaption", () => {
  it("puts the whole leaf in the span that never truncates away", () => {
    render(<PathCaption path="/Users/dev/code/helios-dashboard" />);

    const caption = screen.getByTitle("/Users/dev/code/helios-dashboard");
    const spans = caption.querySelectorAll("span");
    expect(spans).toHaveLength(2);

    // The leaf sits in the shrink-0 span, so the ellipsis can never reach it.
    expect(spans[1]?.textContent).toContain("helios-dashboard");
    expect(spans[0]?.textContent).not.toContain("helios-dashboard");
  });

  it("keeps the separator attached to the leaf, not to the elided ancestors", () => {
    render(<PathCaption path="/Users/dev/code/helios-dashboard" />);

    const spans = screen.getByTitle("/Users/dev/code/helios-dashboard").querySelectorAll("span");

    // The separator is the first character the ellipsis would consume if it
    // lived with the ancestors, and losing it makes the caption read as two
    // unrelated strings instead of one elided path.
    expect(spans[1]?.textContent).toBe("/helios-dashboard");
    expect(spans[0]?.textContent?.endsWith("/")).toBe(false);
  });

  it("reassembles to the normalized path across the split", () => {
    const path = "/Users/dev/code/helios-dashboard";
    render(<PathCaption path={path} />);

    const spans = screen.getByTitle(path).querySelectorAll("span");
    const rejoined = Array.from(spans)
      .map((span) => span.textContent ?? "")
      .join("");

    // No character is dropped or duplicated at the seam.
    expect(rejoined).toBe(path);
  });

  it("renders a bare leaf with no separator and no empty ancestor text", () => {
    render(<PathCaption path="helios-dashboard" />);

    const spans = screen.getByTitle("helios-dashboard").querySelectorAll("span");
    expect(spans[0]?.textContent).toBe("");
    expect(spans[1]?.textContent).toBe("helios-dashboard");
  });

  it("carries the untruncated path as the accessible title", () => {
    const path = "/Users/dev/a/very/deeply/nested/place/helios-dashboard";
    render(<PathCaption path={path} />);

    // Whatever the ellipsis hides visually stays reachable.
    expect(screen.getByTitle(path)).toBeTruthy();
  });
});

describe("FIELD_INPUT_CLASS", () => {
  it("pairs the accent focus ring with an error focus ring for the invalid case", () => {
    // Not an assertion about which colours are used — those can change. The rule
    // is that a field cannot advertise an accent focus ring without also saying
    // what the ring becomes when the field is invalid, or an invalid focused
    // field draws the accent ring concentric with its red error border and the
    // louder of the two signals says nothing is wrong.
    const declaresAccentFocusRing = /(?:^|\s)focus:ring-\S*accent/.test(FIELD_INPUT_CLASS);
    const declaresInvalidFocusRing = /aria-invalid:focus:ring-\S*status-error/.test(
      FIELD_INPUT_CLASS
    );

    expect(declaresAccentFocusRing && !declaresInvalidFocusRing).toBe(false);
  });

  it("marks the invalid border so the error state is not carried by the ring alone", () => {
    // Colour is never the only carrier: the border changes too, which survives
    // forced-colors and does not depend on the field being focused.
    expect(/aria-invalid:border-\S*status-error/.test(FIELD_INPUT_CLASS)).toBe(true);
  });
});
