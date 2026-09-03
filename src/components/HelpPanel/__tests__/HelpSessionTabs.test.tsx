// @vitest-environment jsdom
import { useState } from "react";
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

  it("keeps the whole strip to one tab stop, starting on the selected lane", () => {
    // Two stops per chip is what put six stops between the header and the body at three
    // lanes, and it is what makes arrow-key movement impossible.
    const { container } = renderStrip();
    const [first, second] = tabs(container);

    expect(first!.tabIndex).toBe(-1);
    expect(second!.tabIndex).toBe(0);
  });

  it("moves the tab stop with the arrow keys, not just the focus ring", () => {
    // The half of roving tabindex that is easy to leave out, because arrow keys appear to
    // work without it. What it costs is the return trip: with the stop pinned to the
    // SELECTED lane, tabbing away and back lands on that lane rather than the one you
    // arrowed to, so the arrow keys' effect evaporates whenever focus leaves the panel.
    const { container } = renderStrip();
    const list = container.querySelector('[role="tablist"]')!;
    const [first, second] = tabs(container);

    second!.focus();
    fireEvent.keyDown(list, { key: "ArrowRight" });

    expect(document.activeElement).toBe(first!);
    expect(first!.tabIndex).toBe(0);
    expect(second!.tabIndex).toBe(-1);
    // …and the stop moving is not selection moving.
    expect(first!.getAttribute("aria-selected")).toBe("false");
    expect(second!.getAttribute("aria-selected")).toBe("true");
  });

  it("hands the tab stop to a lane reached by pointer as well", () => {
    // One route for every way focus arrives, rather than one for arrows and none for a
    // click.
    const { container } = renderStrip();
    const [first, second] = tabs(container);

    fireEvent.focus(first!);

    expect(first!.tabIndex).toBe(0);
    expect(second!.tabIndex).toBe(-1);
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

  it("leaves focus on a surviving lane after a keyboard close", () => {
    // Focusing inline in the key handler focused the tab that was about to be removed:
    // closing only ASKS, and the element is still there until the next commit, so the
    // ring landed on a node that then unmounted and focus fell to the document body. The
    // successor has to be named by slot before the close and resolved after it. This
    // needs a stateful host — the bug is invisible when `tabs` never actually changes.
    function Host() {
      const [open, setOpen] = useState([0, 1, 2]);
      return (
        <HelpSessionTabs
          tabs={open.map((slot) => ({
            slot,
            label: `Session ${slot + 1}`,
            agentState: undefined,
          }))}
          activeSlot={open[0]!}
          onSelect={vi.fn()}
          onClose={(slot) => setOpen((prev) => prev.filter((s) => s !== slot))}
          idBase="host"
          panelId="host-body"
        />
      );
    }

    const { container } = render(<Host />);
    const list = container.querySelector('[role="tablist"]')!;

    // Close the FIRST of three — the case the old code got wrong, because the successor
    // sits at the same index the closed tab occupied.
    tabs(container)[0]!.focus();
    fireEvent.keyDown(list, { key: "Delete" });

    const remaining = tabs(container);
    expect(remaining.map((t) => t.getAttribute("aria-label"))).toEqual(["Session 2", "Session 3"]);
    expect(document.activeElement).toBe(remaining[0]!);
    expect(remaining[0]!.tabIndex).toBe(0);
  });

  it("survives a lane changing state while a close is still being confirmed", () => {
    // Closing a lane with a live agent raises a confirm dialog, so the close is deferred.
    // Meanwhile `tabs` is rebuilt on every agentState transition, not only on a close —
    // so keyed on the array alone, a working lane ticking over during the dialog looks
    // exactly like the close landing, spends the focus handoff early, and leaves the real
    // close with nothing to place focus with.
    function Host() {
      const [open, setOpen] = useState([0, 1, 2]);
      const [busy, setBusy] = useState(false);
      const [pending, setPending] = useState<number | null>(null);
      return (
        <>
          <HelpSessionTabs
            tabs={open.map((slot) => ({
              slot,
              label: `Session ${slot + 1}`,
              agentState: busy && slot === 2 ? "working" : undefined,
            }))}
            activeSlot={open[0]!}
            onSelect={vi.fn()}
            // Defers, the way a confirm dialog does.
            onClose={(slot) => setPending(slot)}
            idBase="deferred"
            panelId="deferred-body"
          />
          <button type="button" onClick={() => setBusy(true)}>
            tick
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen((prev) => prev.filter((s) => s !== pending));
              setPending(null);
            }}
          >
            confirm
          </button>
        </>
      );
    }

    const { container, getByText } = render(<Host />);
    const list = container.querySelector('[role="tablist"]')!;

    tabs(container)[0]!.focus();
    fireEvent.keyDown(list, { key: "Delete" });

    const closingTab = tabs(container)[0]!;

    // An unrelated lane goes to work while the dialog is still open.
    fireEvent.click(getByText("tick"));

    // Nothing has closed, so nothing may move. This is the assertion that catches the
    // bug: a handoff spent here does not merely arrive early, it drags focus off
    // whatever holds it — in the real panel that is the open confirm dialog.
    expect(tabs(container)).toHaveLength(3);
    expect(document.activeElement).toBe(closingTab);

    fireEvent.click(getByText("confirm"));

    const remaining = tabs(container);
    expect(remaining.map((t) => t.getAttribute("aria-label"))).toEqual(["Session 2", "Session 3"]);
    expect(document.activeElement).toBe(remaining[0]!);
  });

  it("stands down the close handoff when the confirm is cancelled", () => {
    // A cancelled dialog returns focus to the tab it was opened from. Left armed, the
    // handoff would fire on some later close of that lane — possibly a pointer close,
    // where focus should not move at all.
    function Host() {
      const [open, setOpen] = useState([0, 1, 2]);
      return (
        <>
          <HelpSessionTabs
            tabs={open.map((slot) => ({
              slot,
              label: `Session ${slot + 1}`,
              agentState: undefined,
            }))}
            activeSlot={open[0]!}
            onSelect={vi.fn()}
            onClose={vi.fn()}
            idBase="cancel"
            panelId="cancel-body"
          />
          <button type="button" onClick={() => setOpen([0, 2])}>
            drop middle
          </button>
        </>
      );
    }

    const { container, getByText } = render(<Host />);
    const list = container.querySelector('[role="tablist"]')!;

    // Ask to close the first lane, then cancel — modelled as focus coming back to it.
    tabs(container)[0]!.focus();
    fireEvent.keyDown(list, { key: "Delete" });
    fireEvent.focus(tabs(container)[0]!);

    // Later, a different lane goes away for unrelated reasons. Focus must not jump.
    const before = document.activeElement;
    fireEvent.click(getByText("drop middle"));
    expect(document.activeElement).toBe(before);
  });

  it("falls back to the preceding lane when the last one is closed", () => {
    function Host() {
      const [open, setOpen] = useState([0, 1]);
      return (
        <HelpSessionTabs
          tabs={open.map((slot) => ({
            slot,
            label: `Session ${slot + 1}`,
            agentState: undefined,
          }))}
          activeSlot={open[0]!}
          onSelect={vi.fn()}
          onClose={(slot) => setOpen((prev) => prev.filter((s) => s !== slot))}
          idBase="host2"
          panelId="host2-body"
        />
      );
    }

    const { container } = render(<Host />);
    const list = container.querySelector('[role="tablist"]')!;

    tabs(container)[1]!.focus();
    fireEvent.keyDown(list, { key: "Delete" });

    const remaining = tabs(container);
    expect(remaining).toHaveLength(1);
    expect(document.activeElement).toBe(remaining[0]!);
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

  it("keeps the new-session control present, focusable and explained once every lane is taken", () => {
    // Parked rather than removed: a control that vanishes takes its own explanation with
    // it, and the strip's width budget stays constant either way. `aria-disabled` rather
    // than `disabled` is what keeps the explanation reachable — a disabled button leaves
    // the tab order and stops firing pointer events, so its `title` never surfaces.
    const onOpenSession = vi.fn();
    const { getByLabelText } = renderStrip({ canOpenSession: false, onOpenSession });
    const control = getByLabelText("New session") as HTMLButtonElement;

    expect(control.disabled).toBe(false);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.title).toContain("maximum");

    fireEvent.click(control);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("omits the new-session control entirely when no handler is supplied", () => {
    const { queryByLabelText } = renderStrip({ onOpenSession: undefined });
    expect(queryByLabelText("New session")).toBeNull();
  });
});
