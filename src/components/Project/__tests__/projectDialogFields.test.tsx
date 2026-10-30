/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render as rtlRender,
  screen,
  cleanup,
  fireEvent,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PathCaption, SlottedInputField } from "../projectDialogFields";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The app root supplies the TooltipProvider.
function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

/** The caption's text spans, in reading order. */
function captionSpans(container: HTMLElement): HTMLSpanElement[] {
  return Array.from(container.querySelectorAll<HTMLSpanElement>("p span"));
}

/**
 * `PathCaption` exists so a filesystem path elides its ancestors rather than
 * its leaf — the leaf is what identifies the project, and a plain `truncate`
 * eats exactly that. These assert the rule, not any particular rendered width:
 * the split point is a layout decision that can change, the invariants can't.
 */
describe("PathCaption", () => {
  it("puts the whole leaf in the span that never truncates away", () => {
    const { container } = render(<PathCaption path="/Users/dev/code/helios-dashboard" />);

    const spans = captionSpans(container);
    expect(spans).toHaveLength(2);

    // The leaf sits in the shrink-0 span, so the ellipsis can never reach it.
    expect(spans[1]?.textContent).toContain("helios-dashboard");
    expect(spans[0]?.textContent).not.toContain("helios-dashboard");
  });

  it("keeps the separator attached to the leaf, not to the elided ancestors", () => {
    const { container } = render(<PathCaption path="/Users/dev/code/helios-dashboard" />);

    const spans = captionSpans(container);

    // The separator is the first character the ellipsis would consume if it
    // lived with the ancestors, and losing it makes the caption read as two
    // unrelated strings instead of one elided path.
    expect(spans[1]?.textContent).toBe("/helios-dashboard");
    expect(spans[0]?.textContent?.endsWith("/")).toBe(false);
  });

  it("reassembles to the normalized path across the split", () => {
    const path = "/Users/dev/code/helios-dashboard";
    const { container } = render(<PathCaption path={path} />);

    const spans = captionSpans(container);
    const rejoined = spans.map((span) => span.textContent ?? "").join("");

    // No character is dropped or duplicated at the seam.
    expect(rejoined).toBe(path);
  });

  it("renders a bare leaf with no separator and no empty ancestor text", () => {
    const { container } = render(<PathCaption path="helios-dashboard" />);

    const spans = captionSpans(container);
    expect(spans.map((span) => span.textContent)).toEqual(["helios-dashboard"]);
  });

  it("reveals the untruncated path in a tooltip when clipped", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    const path = "/Users/dev/a/very/deeply/nested/place/helios-dashboard";
    const { container } = render(<PathCaption path={path} />);

    // Whatever the ellipsis hides visually stays reachable, through the app's
    // tooltip rather than a native title. The ancestors are what clip first.
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    fireEvent.focus(captionSpans(container)[0]!);
    expect((await screen.findByRole("tooltip")).textContent).toBe(path);
  });
});

describe("SlottedInputField", () => {
  it("renders the input bare unless asked to elide its start", () => {
    render(<SlottedInputField data-testid="field" value="/a/b" onChange={() => {}} />);
    const input = screen.getByTestId("field");
    expect(input.parentElement!.querySelector(".path-tail")).toBeNull();
    expect(input.className).toContain("text-text-primary");
    expect(input.className).not.toContain("text-transparent");
  });

  it("hides the painted tail on focus and dims it with a disabled input", () => {
    render(
      <SlottedInputField data-testid="field" value="/a/b" onChange={() => {}} elideStart disabled />
    );
    const input = screen.getByTestId("field");
    const overlay = input.nextElementSibling!;
    expect(input.className).toContain("peer");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.className).toContain("peer-focus:hidden");
    expect(overlay.className).toContain("peer-disabled:opacity-50");
    expect(overlay.className).toContain("pointer-events-none");
  });
});
