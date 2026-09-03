// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelpSessionTabs, type HelpSessionTab } from "../HelpSessionTabs";

/**
 * The parallel-session strip.
 *
 * What is pinned here is deliberately the RULES the strip's design rests on, not
 * the values that express them — the fill tokens, the pixel sizes and the glyph
 * choices are all expected to move again. Each of these instead names something
 * that, if it broke, would take a whole signal with it and do so silently.
 *
 * Most of it is unreachable from a rendering test on purpose: the selected tab's
 * rail is an `::after` in `index.css` keyed on `data-active`, and jsdom has no
 * layout. So the rail is pinned by its hook rather than its paint.
 */

const TABS: HelpSessionTab[] = [
  { slot: 0, label: "Session 1", agentState: undefined },
  { slot: 1, label: "Session 2", agentState: "working" },
];

function renderStrip(overrides: Partial<Parameters<typeof HelpSessionTabs>[0]> = {}) {
  return render(
    <HelpSessionTabs
      tabs={TABS}
      activeSlot={1}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

const chips = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".session-tab"));

describe("HelpSessionTabs", () => {
  it("marks exactly one chip, and it is the active slot's", () => {
    const { container } = renderStrip();
    const marked = chips(container).filter((c) => c.dataset.active === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Session 2");
  });

  it("moves the mark with the active slot", () => {
    const { container, rerender } = renderStrip();
    rerender(<HelpSessionTabs tabs={TABS} activeSlot={0} onSelect={vi.fn()} onClose={vi.fn()} />);
    const marked = chips(container).filter((c) => c.dataset.active === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Session 1");
  });

  it("puts the mark on the chip that holds the whole tab, not on a control inside it", () => {
    // The rail is drawn against `.session-tab`, so a mark that migrated onto the
    // inner selector would still set an attribute and paint nothing at all.
    const { container } = renderStrip();
    const marked = chips(container).find((c) => c.dataset.active === "true")!;
    expect(marked.querySelector("button[aria-pressed='true']")).not.toBeNull();
    expect(marked.querySelector("[data-active]")).toBeNull();
  });

  it("says which selector is on, for anyone not reading the mark", () => {
    const { getByRole } = renderStrip();
    expect(getByRole("button", { name: "Session 2" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "Session 1" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps an unmarked lane's close control mounted and wired", () => {
    const onClose = vi.fn();
    const { getByLabelText } = renderStrip({ onClose });
    // Only its PAINT is hover-gated. Rendering it conditionally instead would
    // take it out of the tab order, which is what puts it out of reach of a
    // keyboard user on the lane they are not looking at.
    fireEvent.click(getByLabelText("Close Session 1"));
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("selects by slot rather than by position", () => {
    const onSelect = vi.fn();
    const { getByRole } = renderStrip({ onSelect });
    fireEvent.click(getByRole("button", { name: "Session 1" }));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it("stays out of the way of a single session", () => {
    const { container } = render(
      <HelpSessionTabs tabs={[TABS[0]!]} activeSlot={0} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("keeps the identifying end of a label out of the truncating element", () => {
    // Every label here is `Session N`: the word carries none of the information
    // and the last token carries all of it, so a single truncating span removes
    // them in exactly the wrong order. Three lanes at the panel's 320px minimum
    // really do run out of room, and the strip rendered "Sessio..." three times.
    //
    // The RULE, not the split: whatever element holds the last token must not be
    // the one that truncates. A future label shape can change freely underneath.
    const { getByRole } = renderStrip();
    const selector = getByRole("button", { name: "Session 1" });
    const parts = Array.from(selector.querySelectorAll("span"));
    const tail = parts.find((el) => el.textContent?.trim() === "1");
    expect(tail).toBeDefined();
    expect(tail!.className).not.toContain("truncate");
    expect(parts.some((el) => el.className.includes("truncate"))).toBe(true);
  });

  it("states each selector's accessible name instead of deriving it from the split", () => {
    // The accessible-name algorithm trims each element's own contribution before
    // joining them, so splitting "Session 1" across two spans computed as
    // "Session1" — a real regression for anyone listening rather than looking.
    const { getByRole } = renderStrip();
    for (const label of ["Session 1", "Session 2"]) {
      expect(getByRole("button", { name: label }).getAttribute("aria-label")).toBe(label);
    }
  });

  it("announces a lane's state without letting it into the selector's name", () => {
    // Two failures in one rule. Stating the name is what keeps it exactly
    // `Session N`; an explicit label on a button ALSO overrides everything inside
    // it, which is how the marker's meaning stopped reaching anyone who cannot
    // see the glyph. The state has to arrive as a description instead — and a
    // lane with no state must not gain an empty one.
    const { getByRole } = renderStrip();
    const busy = getByRole("button", { name: "Session 2" });
    const describedBy = busy.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // `getElementById`, not a selector: React's `useId` mints ids containing
    // colons, which a CSS selector would have to escape.
    expect(document.getElementById(describedBy!)?.textContent).toBe("working");

    expect(getByRole("button", { name: "Session 1" }).getAttribute("aria-describedby")).toBeNull();
  });

  it("offers the new-session control only with both a free lane and a handler", () => {
    // They travel together: the capability without a handler is a button that
    // does nothing, and the handler without the capability is a button that opens
    // a lane there is no room for.
    const onOpenSession = vi.fn();
    const { queryByLabelText, rerender } = renderStrip();
    expect(queryByLabelText("Open parallel session")).toBeNull();

    rerender(
      <HelpSessionTabs
        tabs={TABS}
        activeSlot={1}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        canOpenSession
        onOpenSession={onOpenSession}
      />
    );
    fireEvent.click(queryByLabelText("Open parallel session")!);
    expect(onOpenSession).toHaveBeenCalledTimes(1);

    rerender(
      <HelpSessionTabs
        tabs={TABS}
        activeSlot={1}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        canOpenSession={false}
        onOpenSession={onOpenSession}
      />
    );
    expect(queryByLabelText("Open parallel session")).toBeNull();
  });
});
