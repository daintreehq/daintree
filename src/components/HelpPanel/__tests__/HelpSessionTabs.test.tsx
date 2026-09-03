// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelpSessionTabs, helpSessionTabId, type HelpSessionTab } from "../HelpSessionTabs";

/**
 * The session strip.
 *
 * What is pinned here is deliberately the RULES the strip's design rests on, not the
 * values that express them — the fill tokens, the pixel sizes and the glyph choices are
 * all expected to move again. Each of these instead names something that, if it broke,
 * would take a whole signal with it and do so silently.
 *
 * Most of it is unreachable from a rendering test on purpose: the selected tab's rail is
 * an `::after` in `index.css` keyed on `data-active`, and jsdom has no layout. So the
 * rail is pinned by its hook rather than its paint.
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
      idBase="strip"
      panelId="strip-body"
      {...overrides}
    />
  );
}

const chips = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".session-tab"));

const tabs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));

describe("HelpSessionTabs", () => {
  it("marks exactly one chip, and it is the active slot's", () => {
    const { container } = renderStrip();
    const marked = chips(container).filter((c) => c.dataset.active === "true");

    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Session 2");
  });

  it("moves the mark with the active slot", () => {
    const { container } = renderStrip({ activeSlot: 0 });
    const marked = chips(container).filter((c) => c.dataset.active === "true");

    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Session 1");
  });

  it("puts the mark on the chip that holds the whole tab, not on a control inside it", () => {
    // The rail is an `::after` on `.session-tab`, so the attribute driving it has to
    // live on the element that spans the chip. Moving it onto the tab button would
    // silently shorten the rail to the button's box.
    const { container } = renderStrip();
    const marked = container.querySelector<HTMLElement>('[data-active="true"]')!;

    expect(marked.classList.contains("session-tab")).toBe(true);
    expect(marked.getAttribute("role")).toBe("presentation");
  });

  it("draws no selection mark when there is only one lane to choose between", () => {
    // A selection mark on the only option states nothing, and at one lane the chip
    // spans nearly the whole strip, where the rail stops reading as a mark on a tab
    // and starts reading as a second bottom border.
    const { container } = renderStrip({
      tabs: [TABS[0]!],
      activeSlot: 0,
    });

    expect(container.querySelectorAll('[data-active="true"]')).toHaveLength(0);
    // The tab is still the selected one as far as the pattern is concerned.
    expect(tabs(container)[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("is a tablist whose tabs point at the body they drive", () => {
    const { container } = renderStrip();
    const list = container.querySelector('[role="tablist"]')!;

    expect(list.getAttribute("aria-label")).toBe("Assistant sessions");
    for (const tab of tabs(container)) {
      expect(tab.getAttribute("aria-controls")).toBe("strip-body");
    }
  });

  it("exposes each tab's id under the same derivation the body uses to name it", () => {
    // The body's `aria-labelledby` is built by the panel from the same base. If these
    // two ever stop agreeing the relationship silently resolves to nothing.
    const { container } = renderStrip();
    const ids = tabs(container).map((t) => t.id);

    expect(ids).toEqual([helpSessionTabId("strip", 0), helpSessionTabId("strip", 1)]);
  });

  it("keeps the whole strip to one tab stop, with the selected lane holding it", () => {
    // Roving tabindex. Two stops per chip is what made arrow-key movement impossible
    // and put six stops between the header and the body at three lanes.
    const { container } = renderStrip();
    const [first, second] = tabs(container);

    expect(first!.tabIndex).toBe(-1);
    expect(second!.tabIndex).toBe(0);
  });

  it("moves focus along the strip with arrow keys without selecting", () => {
    // Manual activation: selecting a lane swaps a live terminal into the body, so
    // arrowing across the strip must not tear down the sessions it passes.
    const onSelect = vi.fn();
    const { container } = renderStrip({ onSelect });
    const [first, second] = tabs(container);

    second!.focus();
    fireEvent.keyDown(container.querySelector('[role="tablist"]')!, { key: "ArrowRight" });

    expect(document.activeElement).toBe(first!); // wrapped
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("wraps at both ends and honours Home and End", () => {
    const { container } = renderStrip();
    const list = container.querySelector('[role="tablist"]')!;
    const [first, second] = tabs(container);

    first!.focus();
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(second!);

    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(first!);

    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(second!);
  });

  it("closes the focused lane from the keyboard, since the close control is not a tab stop", () => {
    // ARIA forbids a focusable control inside a `tab`, so the glyph is pointer-only and
    // Delete is the keyboard route. If this breaks, keyboard users lose closing
    // entirely rather than losing a shortcut.
    const onClose = vi.fn();
    const { container } = renderStrip({ onClose });

    tabs(container)[1]!.focus();
    fireEvent.keyDown(container.querySelector('[role="tablist"]')!, { key: "Delete" });

    expect(onClose).toHaveBeenCalledWith(1);
  });

  it("advertises that shortcut on the tab rather than leaving it to be discovered", () => {
    const { container } = renderStrip();
    for (const tab of tabs(container)) {
      expect(tab.getAttribute("aria-keyshortcuts")).toBe("Delete");
    }
  });

  it("keeps the close control out of the tab order and out of the a11y tree", () => {
    const { container } = renderStrip();
    const closers = Array.from(container.querySelectorAll("button")).filter((b) =>
      b.getAttribute("title")?.startsWith("Close ")
    );

    expect(closers).toHaveLength(2);
    for (const c of closers) {
      expect(c.tabIndex).toBe(-1);
      expect(c.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("closes by slot rather than by position, and does not select on the way", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = renderStrip({ onSelect, onClose });
    const closer = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("title") === "Close Session 1"
    )!;

    fireEvent.click(closer);

    expect(onClose).toHaveBeenCalledWith(0);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects by slot rather than by position", () => {
    // The strip is handed open slots, which are not contiguous — lane 2 of {0,2} is at
    // index 1. Selecting by index would switch to the wrong conversation.
    const onSelect = vi.fn();
    const { container } = renderStrip({
      tabs: [TABS[0]!, { slot: 2, label: "Session 3", agentState: undefined }],
      onSelect,
    });

    fireEvent.click(tabs(container)[1]!);
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("stays visible for a single session", () => {
    // The strip is the panel's one home for "which session am I in" and "give me
    // another". Hiding it below two lanes left the only route to a second session
    // inside an overflow menu.
    const { container } = renderStrip({ tabs: [TABS[0]!], activeSlot: 0 });

    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs(container)).toHaveLength(1);
  });

  it("renders nothing at all when there are no lanes", () => {
    const { container } = renderStrip({ tabs: [], activeSlot: 0 });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("keeps the identifying end of a label out of the truncating element", () => {
    // "Session 1" truncates to "Sessio…" without this, which identifies nothing —
    // the last token carries all the information and a plain truncate removes it first.
    const { container } = renderStrip();
    const tab = tabs(container)[0]!;
    const parts = Array.from(tab.querySelectorAll("span span"));
    const truncating = parts.filter((p) => p.className.includes("truncate"));
    const fixed = parts.filter((p) => !p.className.includes("truncate"));

    expect(truncating).toHaveLength(1);
    expect(truncating[0]!.textContent).toBe("Session");
    expect(fixed.some((p) => p.textContent === " 1")).toBe(true);
  });

  it("states each selector's accessible name instead of deriving it from the split", () => {
    // The accessible-name algorithm trims each element's contribution before joining,
    // so the split label computes as "Session1" unless the name is stated outright.
    const { container } = renderStrip();
    expect(tabs(container).map((t) => t.getAttribute("aria-label"))).toEqual([
      "Session 1",
      "Session 2",
    ]);
  });

  it("announces a lane's state without letting it into the tab's name", () => {
    const { container } = renderStrip();
    const [idle, working] = tabs(container);

    expect(idle!.getAttribute("aria-describedby")).toBeNull();
    const describedBy = working!.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    // Attribute selector rather than an id selector: `CSS.escape` is not implemented in
    // this jsdom environment, and a `useId`-derived base contains characters an id
    // selector would have to escape.
    expect(container.querySelector(`[id="${describedBy}"]`)!.textContent).toBe("working");
  });

  it("keeps the new-session control present but inert once every lane is taken", () => {
    // Parked rather than removed: a control that vanishes takes its own explanation
    // with it, and the strip's width budget stays constant either way.
    const { getByLabelText } = renderStrip({
      canOpenSession: false,
      onOpenSession: vi.fn(),
    });
    const control = getByLabelText("New session") as HTMLButtonElement;

    expect(control.disabled).toBe(true);
    expect(control.title).toContain("maximum");
  });

  it("omits the new-session control entirely when no handler is supplied", () => {
    const { queryByLabelText } = renderStrip({ onOpenSession: undefined });
    expect(queryByLabelText("New session")).toBeNull();
  });
});
