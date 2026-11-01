// @vitest-environment jsdom
import { useState, type ReactElement, type ReactNode } from "react";
import {
  act,
  cleanup,
  render as rtlRender,
  fireEvent,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HelpSessionTabs,
  TabStateIndicator,
  helpSessionTabId,
  type HelpSessionTab,
} from "../HelpSessionTabs";

function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
  return rtlRender(ui, { wrapper: InstantTooltips, ...options });
}

// No hover delay, so a tooltip opened by a pointer in a test is up by the next assertion.
function InstantTooltips({ children }: { children: ReactNode }) {
  return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>;
}

/**
 * The session strip.
 *
 * What is pinned here is deliberately the RULES the strip's design rests on, not the
 * values that express them — the fill tokens, the pixel sizes and the glyph choices are
 * all expected to move again. Each of these instead names something that, if it broke,
 * would take a whole signal with it and do so silently.
 *
 * The strip is a member of the document tab family (`ui/document-tab`), so the
 * selection mark is the family's indicator, pinned by its hook rather than its paint.
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

/** The tabs drawing the family's selection mark. */
const marked = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-document-tab-indicator]")).map((mark) =>
    mark.closest<HTMLElement>('[role="tab"]')!
  );

const closers = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-document-tab-close]"));

const tabs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));

/** The close control inside the tab named `name`. */
const closerFor = (container: HTMLElement, name: string) => {
  const tab = tabs(container).find((t) => t.getAttribute("aria-label") === name);
  return tab?.querySelector<HTMLButtonElement>("[data-document-tab-close]") ?? null;
};

const tooltipTexts = () => screen.queryAllByRole("tooltip").map((t) => t.textContent ?? "");

describe("HelpSessionTabs", () => {
  it("marks exactly one tab, and it is the active slot's", () => {
    const { container } = renderStrip();

    expect(marked(container)).toHaveLength(1);
    expect(marked(container)[0]!.getAttribute("aria-label")).toBe("Session 2");
    expect(marked(container)[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("makes the tab the element that spans the whole chip, close control included", () => {
    // The mark and the focus ring are drawn on the tab's own box, so the tab has to be
    // the element holding everything the chip shows — a ring that stopped short of the
    // close control read as two shapes.
    const { container } = renderStrip();
    for (const closer of closers(container)) {
      expect(closer.closest('[role="tab"]')).not.toBeNull();
    }
  });

  it("keeps exactly one mark as lanes open and close around the selection", () => {
    const { container, rerender } = render(
      <HelpSessionTabs
        tabs={[TABS[0]!]}
        activeSlot={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        idBase="grow"
        panelId="grow-body"
      />
    );
    const marks = () => marked(container);
    expect(marks()).toHaveLength(1);

    rerender(
      <HelpSessionTabs
        tabs={TABS}
        activeSlot={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        idBase="grow"
        panelId="grow-body"
      />
    );
    expect(marks()).toHaveLength(1);
    expect(marks()[0]!.textContent).toContain("Session 1");

    rerender(
      <HelpSessionTabs
        tabs={[TABS[1]!]}
        activeSlot={1}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        idBase="grow"
        panelId="grow-body"
      />
    );
    expect(marks()).toHaveLength(1);
    expect(marks()[0]!.textContent).toContain("Session 2");
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
    // two ever stop agreeing the relationship silently resolves to nothing. Sparse
    // slots on purpose, and uniqueness asserted outright: comparing against the
    // helper alone would pass a helper that ignored the slot.
    const { container } = renderStrip({
      tabs: [TABS[0]!, { slot: 2, label: "Session 3", agentState: undefined }],
      activeSlot: 0,
    });
    const ids = tabs(container).map((t) => t.id);

    expect(ids).toEqual([helpSessionTabId("strip", 0), helpSessionTabId("strip", 2)]);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toContain("2");
  });

  it("keeps the tab stop on the selected lane while the arrow keys roam", () => {
    // APG tabs: focus entering the tablist lands on the selected tab. Under manual
    // activation the arrows move focus without moving the selection, and the stop stays
    // with the selection, so tabbing back in lands on the session the body is showing.
    const { container } = renderStrip();
    const list = container.querySelector('[role="tablist"]')!;
    const [first, second] = tabs(container);

    second!.focus();
    fireEvent.keyDown(list, { key: "ArrowRight" });

    expect(document.activeElement).toBe(first!);
    expect(first!.tabIndex).toBe(-1);
    expect(second!.tabIndex).toBe(0);
    expect(first!.getAttribute("aria-selected")).toBe("false");
    expect(second!.getAttribute("aria-selected")).toBe("true");
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
    // Closing a lane whose conversation can't come back raises a confirm dialog, so the
    // close is deferred.
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

          <button type="button" onClick={() => setOpen([1, 2])}>
            drop first
          </button>
          <button type="button">sentinel</button>
        </>
      );
    }

    const { container, getByText } = render(<Host />);
    const list = container.querySelector('[role="tablist"]')!;

    // Ask to close the first lane. The dialog takes focus…
    tabs(container)[0]!.focus();
    fireEvent.keyDown(list, { key: "Delete" });
    getByText("sentinel").focus();
    // …and cancelling hands it back to the tab the ask came from.
    tabs(container)[0]!.focus();

    // The user moves on, and later that same lane is closed some other way — a pointer
    // close, or the agent exiting. A handoff still armed from the cancelled ask would
    // now fire and drag focus onto its old successor.
    getByText("sentinel").focus();
    fireEvent.click(getByText("drop first"));

    expect(tabs(container).map((t) => t.getAttribute("aria-label"))).toEqual([
      "Session 2",
      "Session 3",
    ]);
    expect(document.activeElement).toBe(getByText("sentinel"));
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
    expect(closers(container)).toHaveLength(2);
    for (const c of closers(container)) {
      expect(c.tabIndex).toBe(-1);
      expect(c.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("closes by slot rather than by position from the pointer, without selecting", () => {
    // Sparse slots, so slot and index disagree: closing index 1 must ask for slot 2.
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = renderStrip({
      tabs: [TABS[0]!, { slot: 2, label: "Session 3", agentState: undefined }],
      activeSlot: 0,
      onSelect,
      onClose,
    });
    const closer = closers(container).find(
      (b) => b.getAttribute("aria-label") === "Close Session 3"
    )!;

    fireEvent.click(closer);

    expect(onClose).toHaveBeenCalledWith(2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("refuses focus at mousedown on the close control, so a click never strands it", () => {
    // A native button takes focus on mousedown. This one is about to unmount, and focus
    // on a node that unmounts falls to the document body.
    const { container } = renderStrip();
    const closer = closers(container).find(
      (b) => b.getAttribute("aria-label") === "Close Session 2"
    )!;

    const prevented = !fireEvent.mouseDown(closer);
    expect(prevented).toBe(true);
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

  it("draws a close only on the selected lane once the strip is full", () => {
    // A background lane's close is invisible until hover but still holds its width, and
    // at the ceiling that room clipped every label. Delete still closes any lane.
    const onClose = vi.fn();
    const { container } = renderStrip({
      tabs: [
        { slot: 0, label: "Session 1", agentState: undefined },
        { slot: 1, label: "Session 2", agentState: "working" },
        { slot: 2, label: "Session 3", agentState: undefined },
      ],
      activeSlot: 1,
      onClose,
    });
    expect(
      closers(container).map((c) => c.closest('[role="tab"]')!.getAttribute("data-slot"))
    ).toEqual(["1"]);

    const list = container.querySelector('[role="tablist"]')!;
    tabs(container)[2]!.focus();
    fireEvent.keyDown(list, { key: "Delete" });
    expect(onClose).toHaveBeenCalledWith(2);
  });

  it("keeps a hover close on every lane below the ceiling", () => {
    const { container } = renderStrip();
    expect(closers(container)).toHaveLength(TABS.length);
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

  it("truncates a task title from its end, without pinning its last word", () => {
    // A task's last word identifies nothing, so the split that protects `Session N`
    // would truncate the start of the sentence instead of the end.
    const { container } = renderStrip({
      tabs: [
        { slot: 0, label: "fix auth tests", fullTitle: "fix auth tests", agentState: undefined },
      ],
      activeSlot: 0,
    });
    const tab = tabs(container)[0]!;
    const spans = Array.from(tab.querySelectorAll("span")).filter(
      (span) => !span.closest("[data-document-tab-close]")
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]!.className).toContain("truncate");
    expect(spans[0]!.textContent).toBe("fix auth tests");
  });

  it("names a task-titled tab by its whole title everywhere but the visible label", async () => {
    const { container } = renderStrip({
      tabs: [
        { slot: 0, label: "Session 1", agentState: undefined },
        {
          slot: 1,
          label: "refactor the assistant…",
          fullTitle: "refactor the assistant session strip",
          agentState: undefined,
        },
      ],
    });
    const [plain, titled] = tabs(container);

    // Capped titles that share an opening would otherwise announce identically.
    expect(titled!.textContent).toBe("refactor the assistant…");
    expect(titled!.getAttribute("aria-label")).toBe("refactor the assistant session strip");
    expect(
      container.querySelector('[aria-label="Close refactor the assistant session strip"]')
    ).not.toBeNull();
    // The whole title reaches the pointer through the app's tooltip, never a native
    // `title`, which cannot be hovered, dismissed or styled.
    expect(container.querySelector("[title]")).toBeNull();
    expect(plain!.hasAttribute("title")).toBe(false);

    // A `Session N` tooltip would only repeat the tab.
    await act(async () => {
      fireEvent.focus(plain!);
    });
    expect(tooltipTexts()).toEqual([]);
    fireEvent.blur(plain!);

    // The capped title reveals the whole of itself.
    fireEvent.focus(titled!);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "refactor the assistant session strip"
    );
    fireEvent.blur(titled!);

    // Its close control explains itself through the family's shared tooltip too.
    const closer = closerFor(container, "refactor the assistant session strip")!;
    fireEvent.pointerMove(closer, { pointerType: "mouse" });
    expect(await screen.findByText("Close tab")).toBeTruthy();
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

  // No Canopy reading ever covers an assistant, so a lane at its prompt asks
  // nothing: no waiting ring and no "waiting" description, whether it is the
  // lane on screen or one in the background (#16059).
  it("marks only work in flight: working and directing, never a stop", () => {
    for (const state of ["waiting", "idle", "completed", "exited", undefined] as const) {
      const { container, unmount } = render(<TabStateIndicator agentState={state} />);
      expect(container.innerHTML).toBe("");
      unmount();
    }
    const working = render(<TabStateIndicator agentState="working" />);
    expect(working.container.querySelector(".text-state-working")).not.toBeNull();
    working.unmount();
    const directing = render(<TabStateIndicator agentState="directing" />);
    expect(directing.container.querySelector('[class*="text-category-blue"]')).not.toBeNull();
    directing.unmount();
  });

  it("draws and says nothing for a lane at its prompt, on screen or not", () => {
    const { container } = renderStrip({
      tabs: [
        { slot: 0, label: "Session 1", agentState: "waiting" },
        { slot: 1, label: "Session 2", agentState: "waiting" },
      ],
    });
    for (const tab of tabs(container)) {
      expect(tab.querySelector('[class*="state-waiting"]')).toBeNull();
      expect(tab.getAttribute("aria-describedby")).toBeNull();
      expect(tab.textContent).not.toMatch(/waiting/i);
    }
  });

  it("keeps the new-session control present, focusable and explained once every lane is taken", async () => {
    // Parked rather than removed: a control that vanishes takes its own explanation with
    // it, and the strip's width budget stays constant either way. `aria-disabled` rather
    // than `disabled` is what keeps the explanation reachable — a disabled button leaves
    // the tab order and stops firing pointer events, so its tooltip never surfaces.
    const onOpenSession = vi.fn();
    const { getByLabelText } = renderStrip({ canOpenSession: false, onOpenSession });
    const control = getByLabelText("New session") as HTMLButtonElement;

    expect(control.disabled).toBe(false);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.hasAttribute("title")).toBe(false);

    fireEvent.focus(control);
    expect((await screen.findByRole("tooltip")).textContent).toContain("maximum");

    fireEvent.click(control);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("omits the new-session control entirely when no handler is supplied", () => {
    const { queryByLabelText } = renderStrip({ onOpenSession: undefined });
    expect(queryByLabelText("New session")).toBeNull();
  });

  it("opens a session once per click while a lane is free", () => {
    const onOpenSession = vi.fn();
    const { getByLabelText } = renderStrip({ canOpenSession: true, onOpenSession });
    const control = getByLabelText("New session") as HTMLButtonElement;

    expect(control.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(control);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the new-session control outside the tablist, which may own only tabs", () => {
    const { container, getByLabelText } = renderStrip({
      canOpenSession: true,
      onOpenSession: vi.fn(),
    });
    const list = container.querySelector('[role="tablist"]')!;

    expect(list.contains(getByLabelText("New session"))).toBe(false);
    // And nothing in the tablist's a11y-visible subtree is anything but a tab.
    const visible = Array.from(list.querySelectorAll("button")).filter(
      (b) => b.getAttribute("aria-hidden") !== "true"
    );
    expect(visible.every((b) => b.getAttribute("role") === "tab")).toBe(true);
  });

  it("keeps keyboard focus on a lane whose agent reports a task title", () => {
    // Gaining (or losing) a title must not remount the tab, or focus drops to the body.
    const { container, rerender } = renderStrip();
    tabs(container)[0]!.focus();
    const props = {
      activeSlot: 1,
      onSelect: vi.fn(),
      onClose: vi.fn(),
      idBase: "strip",
      panelId: "strip-body",
    };
    rerender(
      <HelpSessionTabs
        {...props}
        tabs={[
          { slot: 0, label: "fix auth tests", fullTitle: "fix auth tests", agentState: undefined },
          TABS[1]!,
        ]}
      />
    );
    expect(document.activeElement).toBe(tabs(container)[0]!);
    rerender(<HelpSessionTabs {...props} tabs={TABS} />);
    expect(document.activeElement).toBe(tabs(container)[0]!);
  });

  it("treats Backspace as Delete", () => {
    const onClose = vi.fn();
    const { container } = renderStrip({ onClose });

    tabs(container)[0]!.focus();
    fireEvent.keyDown(container.querySelector('[role="tablist"]')!, { key: "Backspace" });

    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("leaves focus where it is for Home and End on a single tab", () => {
    const { container } = renderStrip({ tabs: [TABS[0]!], activeSlot: 0 });
    const list = container.querySelector('[role="tablist"]')!;
    const only = tabs(container)[0]!;

    only.focus();
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(only);
    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(only);
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(only);
  });

  it("follows the selection, not the neighbour, when the ACTIVE lane is closed", () => {
    // The store picks the lowest remaining slot as the new active lane, not the one
    // beside the closed tab. Focus has to land on the same lane the body now shows, or
    // the ring is on one session while the terminal is another.
    function Host() {
      const [open, setOpen] = useState([0, 1, 2]);
      const [active, setActive] = useState(1);
      return (
        <HelpSessionTabs
          tabs={open.map((slot) => ({
            slot,
            label: `Session ${slot + 1}`,
            agentState: undefined,
          }))}
          activeSlot={active}
          onSelect={setActive}
          onClose={(slot) => {
            const next = open.filter((s) => s !== slot);
            setOpen(next);
            if (slot === active) setActive(next[0]!);
          }}
          idBase="mid"
          panelId="mid-body"
        />
      );
    }

    const { container } = render(<Host />);
    const list = container.querySelector('[role="tablist"]')!;

    // Slot 1 is active and in the middle. Its positional neighbour is slot 2; the store
    // will select slot 0.
    tabs(container)[1]!.focus();
    fireEvent.keyDown(list, { key: "Delete" });

    const remaining = tabs(container);
    expect(remaining.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(document.activeElement).toBe(remaining[0]!);
  });

  it("steals no focus when the successor has also gone by the time the close lands", () => {
    function Host() {
      const [open, setOpen] = useState([0, 1, 2]);
      const [pending, setPending] = useState<number | null>(null);
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
            onClose={(slot) => setPending(slot)}
            idBase="gone"
            panelId="gone-body"
          />
          <button type="button" onClick={() => setOpen((prev) => prev.filter((s) => s !== 2))}>
            drop successor
          </button>
          <button
            type="button"
            onClick={() => setOpen((prev) => prev.filter((s) => s !== pending))}
          >
            confirm
          </button>
          <button type="button">elsewhere</button>
        </>
      );
    }

    const { container, getByText } = render(<Host />);
    const list = container.querySelector('[role="tablist"]')!;

    // Close the middle lane: its successor is slot 2.
    tabs(container)[1]!.focus();
    fireEvent.keyDown(list, { key: "Delete" });
    // While the dialog is up, slot 2 goes away on its own, and focus is elsewhere.
    fireEvent.click(getByText("drop successor"));
    getByText("elsewhere").focus();

    fireEvent.click(getByText("confirm"));

    expect(tabs(container)).toHaveLength(1);
    expect(document.activeElement).toBe(getByText("elsewhere"));
  });
});

/**
 * Every tab in the app owns its right-click menu; the assistant's session
 * lanes had none. The lane under the pointer is the one the menu acts on.
 */
describe("HelpSessionTabs — each lane owns its menu", () => {
  const tabs: HelpSessionTab[] = [
    { slot: 1, label: "Session 1", agentState: "idle", canRestart: true },
    { slot: 2, label: "Session 2", agentState: "waiting", canRestart: true },
  ];

  function renderStrip(props: {
    tabs?: HelpSessionTab[];
    canOpenSession?: boolean;
    onAncestorContextMenu?: () => void;
  }) {
    const onClose = vi.fn();
    const onOpenSession = vi.fn();
    const onRestart = vi.fn();
    const onSelect = vi.fn();
    rtlRender(
      <TooltipProvider>
        <div onContextMenu={props.onAncestorContextMenu}>
          <HelpSessionTabs
            tabs={props.tabs ?? tabs}
            activeSlot={1}
            onSelect={onSelect}
            onClose={onClose}
            onRestart={onRestart}
            canOpenSession={props.canOpenSession ?? true}
            onOpenSession={onOpenSession}
            idBase="help"
            panelId="help-body"
          />
        </div>
      </TooltipProvider>
    );
    return { onClose, onOpenSession, onRestart, onSelect };
  }

  function lane(slot: number): HTMLElement {
    return document.querySelector<HTMLElement>(`[role="tab"][data-slot="${slot}"]`)!;
  }

  beforeAll(async () => {
    await primeRadix();
  });

  afterEach(() => cleanup());

  it("closes the lane under the pointer, not the active one", async () => {
    const { onClose } = renderStrip({});

    fireEvent.contextMenu(lane(2));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Close session" }));

    expect(onClose).toHaveBeenCalledWith(2);
    expect(onClose).not.toHaveBeenCalledWith(1);
  });

  it("restarts the lane under the pointer, not the active one, without selecting or closing it", async () => {
    const { onRestart, onClose, onSelect } = renderStrip({});

    fireEvent.contextMenu(lane(2));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Restart conversation" }));

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("offers a restart only in a lane that has something to restart", async () => {
    renderStrip({
      tabs: [
        { slot: 1, label: "Session 1", agentState: "idle", canRestart: true },
        { slot: 2, label: "Session 2", agentState: null, canRestart: false },
      ],
    });

    fireEvent.contextMenu(lane(2));
    const menu = await screen.findByRole("menu");

    expect(within(menu).queryByRole("menuitem", { name: "Restart conversation" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Close session" })).toBeTruthy();
  });

  it("leaves focus on the restarted lane, whose tab survives the restart", async () => {
    renderStrip({});
    lane(2).focus();

    fireEvent.contextMenu(lane(2));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Restart conversation" }), {
        key: "Enter",
      });
    });

    expect(screen.queryByRole("menu")).toBeNull();
    // Radix's focus scope hands focus back on a timer after it unmounts. A close
    // from the menu suppresses that handoff; a restart must not.
    await waitFor(() => expect(document.activeElement).toBe(lane(2)));
  });

  it("offers a new session only while a lane is free", async () => {
    renderStrip({ canOpenSession: false });

    fireEvent.contextMenu(lane(1));
    const menu = await screen.findByRole("menu");

    const item = within(menu).getByRole("menuitem", { name: "New session" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the lane's right-click from reaching anything enclosing the strip", () => {
    const reached = vi.fn();
    renderStrip({ onAncestorContextMenu: reached });

    fireEvent.contextMenu(lane(2));

    expect(reached).not.toHaveBeenCalled();
  });

  it("hands focus to a surviving lane once a menu-closed lane is gone", async () => {
    function Strip() {
      const [open, setOpen] = useState(tabs);
      return (
        <TooltipProvider>
          <HelpSessionTabs
            tabs={open}
            activeSlot={1}
            onSelect={vi.fn()}
            onClose={(slot) => setOpen((all) => all.filter((t) => t.slot !== slot))}
            idBase="help"
            panelId="help-body"
          />
        </TooltipProvider>
      );
    }
    rtlRender(<Strip />);
    lane(2).focus();

    fireEvent.contextMenu(lane(2));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Close session" }), {
        key: "Enter",
      });
    });

    expect(lane(2)).toBeNull();
    expect(document.activeElement).toBe(lane(1));
  });
});

/**
 * Sessions on more than one agent (#13442). A strip on one agent must look and
 * read exactly as before; a mix has to say which lane is which, to the eye and
 * to the screen reader alike.
 */
describe("HelpSessionTabs — lanes on different agents", () => {
  const agentMarks = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid='assistant-tab-agent-mark']"));

  function lane(slot: number): HTMLElement {
    return document.querySelector<HTMLElement>(`[role="tab"][data-slot="${slot}"]`)!;
  }

  function renderLanes(
    tabs: HelpSessionTab[],
    props: Partial<Parameters<typeof HelpSessionTabs>[0]> = {}
  ) {
    return rtlRender(
      <TooltipProvider delayDuration={0}>
        <HelpSessionTabs
          tabs={tabs}
          activeSlot={0}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          idBase="mixed"
          panelId="mixed-body"
          {...props}
        />
      </TooltipProvider>
    );
  }

  beforeAll(async () => {
    await primeRadix();
  });

  afterEach(() => cleanup());

  it("leaves a strip on one agent unmarked", () => {
    renderLanes([
      { slot: 0, label: "Session 1", agentState: undefined, agentId: "claude" },
      { slot: 1, label: "Session 2", agentState: undefined, agentId: "claude" },
      { slot: 2, label: "Session 3", agentState: undefined, agentId: null },
    ]);

    expect(agentMarks()).toHaveLength(0);
    expect(lane(1).getAttribute("aria-label")).toBe("Session 2");
  });

  it("marks each lane with its agent, in the mark and in the name, once the strip mixes them", () => {
    renderLanes([
      { slot: 0, label: "Session 1", agentState: undefined, agentId: "claude" },
      { slot: 1, label: "Session 2", agentState: "working", agentId: "codex" },
      { slot: 2, label: "Session 3", agentState: undefined, agentId: null },
    ]);

    expect(
      agentMarks().map((mark) => mark.closest('[role="tab"]')?.getAttribute("data-slot"))
    ).toEqual(["0", "1"]);
    expect(agentMarks().map((mark) => mark.getAttribute("data-agent-id"))).toEqual([
      "claude",
      "codex",
    ]);
    expect(lane(0).getAttribute("aria-label")).toBe("Session 1 — Claude");
    expect(lane(1).getAttribute("aria-label")).toBe("Session 2 — Codex");
    // A lane whose agent nothing names yet keeps its plain name.
    expect(lane(2).getAttribute("aria-label")).toBe("Session 3");
    // The state still reaches assistive tech as the description, beside the agent.
    expect(lane(1).getAttribute("aria-describedby")).toBeTruthy();
  });

  it("starts a session on a named agent from a lane's menu", async () => {
    const onOpenSessionWithAgent = vi.fn();
    renderLanes([{ slot: 0, label: "Session 1", agentState: undefined, agentId: "claude" }], {
      canOpenSession: true,
      onOpenSession: vi.fn(),
      newSessionAgentIds: ["claude", "codex"],
      onOpenSessionWithAgent,
    });

    fireEvent.contextMenu(lane(0));
    const menu = await screen.findByRole("menu");
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(names).toEqual([
      "New session",
      "New session with Claude",
      "New session with Codex",
      "Close session",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New session with Codex" }));

    expect(onOpenSessionWithAgent).toHaveBeenCalledWith("codex");
  });

  it("parks the agent items with New session at the ceiling, and offers none without a choice", async () => {
    renderLanes([{ slot: 0, label: "Session 1", agentState: undefined, agentId: "claude" }], {
      canOpenSession: false,
      onOpenSession: vi.fn(),
      newSessionAgentIds: ["claude", "codex"],
      onOpenSessionWithAgent: vi.fn(),
    });
    fireEvent.contextMenu(lane(0));
    let menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "New session with Codex" })
        .getAttribute("aria-disabled")
    ).toBe("true");
    cleanup();

    renderLanes([{ slot: 0, label: "Session 1", agentState: undefined, agentId: "claude" }], {
      canOpenSession: true,
      onOpenSession: vi.fn(),
      newSessionAgentIds: ["claude"],
      onOpenSessionWithAgent: vi.fn(),
    });
    fireEvent.contextMenu(lane(0));
    menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /New session with/ })).toBeNull();
  });
});
