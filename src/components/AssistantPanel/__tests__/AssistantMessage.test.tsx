// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssistantMessage } from "../AssistantMessage";

/**
 * The cockpit preserved the model's own line structure — it wrapped each source line
 * independently so "existing newlines (paragraphs, list items) are preserved"
 * (internal/ui/markdown/markdown.go:207). CommonMark does the opposite with a lone
 * newline, which turned a run of one-line status statements into a single paragraph.
 *
 * These assert the rendered STRUCTURE rather than any spacing value, so restyling the
 * prose can't quietly break the distinction between a line break and a paragraph.
 */

function renderProse(content: string): HTMLElement {
  const { container } = render(<AssistantMessage content={content} />);
  return container.querySelector(".assistant-prose") as HTMLElement;
}

describe("AssistantMessage", () => {
  it("renders a single newline as a line break, not as a space", () => {
    const el = renderProse("First statement.\nSecond statement.");
    expect(el.querySelectorAll("p")).toHaveLength(1);
    expect(el.querySelectorAll("br")).toHaveLength(1);
  });

  it("still renders a blank line as a paragraph boundary", () => {
    const el = renderProse("First para.\n\nSecond para.");
    expect(el.querySelectorAll("p")).toHaveLength(2);
    expect(el.querySelectorAll("br")).toHaveLength(0);
  });

  it("keeps newlines inside a fenced code block literal", () => {
    // A <br> here would be a rendered element inside <pre>, changing what a user
    // copies out of a code block.
    const el = renderProse("```\nline one\nline two\n```");
    expect(el.querySelectorAll("pre")).toHaveLength(1);
    expect(el.querySelectorAll("pre br")).toHaveLength(0);
    expect(el.querySelector("pre")?.textContent).toContain("line one\nline two");
  });

  it("does not break inline code spans apart", () => {
    const el = renderProse("Run `a\nb` now.");
    expect(el.querySelectorAll("code")).toHaveLength(1);
    expect(el.querySelectorAll("code br")).toHaveLength(0);
  });

  it("preserves list structure rather than folding items into breaks", () => {
    const el = renderProse("- first\n- second\n- third");
    expect(el.querySelectorAll("li")).toHaveLength(3);
    expect(el.querySelectorAll("li br")).toHaveLength(0);
  });

  it("carries every character across the split, losing no spaces at the seam", () => {
    // The transform rebuilds a text node as text/break/text. Dropping the wrong part
    // would fuse words across the break ("There are2 open terminals").
    const el = renderProse("There are 2 open terminals.\nBoth exited.");
    // react-markdown emits a newline text node beside the <br>, so the source text
    // round-trips exactly — which is the property worth pinning.
    expect(el.textContent).toBe("There are 2 open terminals.\nBoth exited.");
  });

  it("leaves prose with no newline completely untouched", () => {
    const el = renderProse("One single line of prose.");
    expect(el.querySelectorAll("br")).toHaveLength(0);
    expect(el.textContent).toBe("One single line of prose.");
  });
});
