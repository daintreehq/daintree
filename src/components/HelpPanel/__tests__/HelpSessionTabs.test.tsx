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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
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

  it("draws a close only on the selected lane once three lanes crowd the strip", () => {
    // A background lane's close is invisible until hover but still holds its width, and
    // at three lanes that room clipped every label. Delete still closes any lane.
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

  it("keeps a hover close on every lane below three", () => {
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

describe("HelpSessionTabs past three lanes (#16218)", () => {
  const SIX: HelpSessionTab[] = Array.from({ length: MAX_ASSISTANT_SLOTS }, (_, slot) => ({
    slot,
    label: `Session ${slot + 1}`,
    agentState: slot === 4 ? ("working" as const) : undefined,
  }));

  // jsdom has no ResizeObserver and lays nothing out: the strip's overflow is measured
  // when a test says the layout changed.
  // Each observer remembers what it watches, so a row resize reaches only the observers
  // watching the row: one that forgot to observe it would miss the resize, as it would in
  // a real layout.
  const observers = new Set<ManualResizeObserver>();
  class ManualResizeObserver {
    private readonly callback: (entries: ResizeObserverEntry[]) => void;
    readonly targets = new Set<Element>();
    constructor(callback: (entries: ResizeObserverEntry[]) => void) {
      this.callback = callback;
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
    // No entries: every observer here re-reads its element, and a tooltip's floating-ui
    // observer destructures the list.
    notify() {
      this.callback([]);
    }
  }
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ManualResizeObserver);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  const relayout = () => act(() => observers.forEach((observer) => observer.notify()));
  const resized = (el: Element) =>
    act(() =>
      observers.forEach((observer) => {
        if (observer.targets.has(el)) observer.notify();
      })
    );

  const strip = (props: Partial<Parameters<typeof HelpSessionTabs>[0]> = {}) => (
    <HelpSessionTabs
      tabs={SIX}
      activeSlot={0}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      idBase="six"
      panelId="six-body"
      {...props}
    />
  );

  /**
   * Lay the strip out as a 200px window over a row of 90px tabs at `scrollLeft`, in the
   * order they render. `scrollTo` is recorded, not applied.
   */
  function layOut(container: HTMLElement, scrollLeft = 0) {
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
    const row = tabs(container);
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(list, "scrollWidth", { configurable: true, value: row.length * 90 });
    list.scrollLeft = scrollLeft;
    list.getBoundingClientRect = () => ({ left: 0 }) as DOMRect;
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo as unknown as typeof list.scrollTo;
    row.forEach((tab, index) => {
      Object.defineProperty(tab, "offsetWidth", { configurable: true, value: 90 });
      tab.getBoundingClientRect = () => ({ left: index * 90 - list.scrollLeft }) as DOMRect;
    });
    return scrollTo;
  }

  it("holds a lane in every slot the project allows", () => {
    const { container } = render(strip());
    expect(tabs(container).map((t) => t.getAttribute("data-slot"))).toEqual(
      SIX.map((t) => String(t.slot))
    );
    // Crowded, as at three: the selected lane alone draws a close.
    expect(closers(container)).toHaveLength(1);
  });

  it("scrolls a lane selected past the edge into view", () => {
    const { container, rerender } = render(strip());
    const scrollTo = layOut(container);

    rerender(strip({ activeSlot: 4 }));

    // Its right edge at the strip's: 5 × 90 − 200.
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 250 }));
  });

  it("leaves the strip where it is when a lane only changes state", () => {
    const { container, rerender } = render(strip({ activeSlot: 5 }));
    const scrollTo = layOut(container);

    rerender(
      strip({
        activeSlot: 5,
        tabs: SIX.map((t) => (t.slot === 1 ? { ...t, agentState: "working" as const } : t)),
      })
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls the lane an arrow key reaches into view without selecting it", () => {
    const onSelect = vi.fn();
    const { container } = render(strip({ onSelect }));
    const scrollTo = layOut(container);
    const list = container.querySelector('[role="tablist"]')!;

    tabs(container)[0]!.focus();
    // Wraps from the first lane to the last.
    fireEvent.keyDown(list, { key: "ArrowLeft" });

    expect(document.activeElement?.getAttribute("data-slot")).toBe("5");
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 340 }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("lets the close handoff, not the selection, own the scroll after a background close", () => {
    // Scrolled to the far end by the keyboard while the first lane stays selected. A
    // selection reveal here would start a scroll back to the start that carries the
    // lane the handoff focuses off screen.
    const { container, rerender } = render(strip());
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
    const scrollTo = layOut(container);
    relayout();
    tabs(container)[0]!.focus();
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 340 }));
    list.scrollLeft = 340;
    scrollTo.mockClear();

    fireEvent.keyDown(list, { key: "Delete" });
    rerender(strip({ tabs: SIX.slice(0, 5) }));

    // Its neighbour has focus and is already in view, so nothing scrolls.
    expect(document.activeElement?.getAttribute("data-slot")).toBe("4");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  /** Give the row a laid-out width (jsdom has none) and tell the observers it changed. */
  function setRowWidth(container: HTMLElement, width: number) {
    const row = container.querySelector<HTMLElement>("[data-session-strip]")!;
    Object.defineProperty(row, "clientWidth", { configurable: true, value: width });
    resized(row);
  }
  /** The width the rendered tabs will not shrink below, read off the tabs themselves. */
  const floorsOf = (container: HTMLElement) =>
    tabs(container).reduce((sum, tab) => sum + parseFloat(tab.style.minWidth), 0);

  /** A host that closes and selects as the panel does: a closed selected lane hands on to its neighbour. */
  function Host({
    initial = SIX,
    initialActive,
    onClose,
  }: {
    initial?: HelpSessionTab[];
    initialActive: number;
    onClose?: (slot: number) => void;
  }) {
    const [lanes, setLanes] = useState(initial);
    const [active, setActive] = useState(initialActive);
    return strip({
      tabs: lanes,
      activeSlot: active,
      onSelect: setActive,
      onClose: (slot) => {
        onClose?.(slot);
        const index = lanes.findIndex((t) => t.slot === slot);
        const next = lanes.filter((t) => t.slot !== slot);
        setLanes(next);
        if (slot === active) setActive((next[index] ?? next[index - 1])!.slot);
      },
    });
  }
  // Past the zero-delay timers a menu's focus restore and the strip's blur settle run on.
  const DEFERRED_FOCUS_SETTLE_MS = 20;
  const flushTimers = () =>
    act(() => new Promise((resolve) => setTimeout(resolve, DEFERRED_FOCUS_SETTLE_MS)));
  const picker = () => screen.queryByTestId("assistant-session-picker");
  const openPicker = async () => {
    fireEvent.keyDown(picker()!, { key: "Enter" });
    return screen.findByRole("menu");
  };

  it("collapses lanes that no longer fit into one picker that lists every lane (#16325)", async () => {
    const onSelect = vi.fn();
    const { container } = render(strip({ onSelect }));
    expect(picker()).toBeNull();

    // Six lanes need 104 + 5 × 88 = 544px as tabs.
    setRowWidth(container, 320);

    // No row of clipped chips and nothing to scroll: one control in place of the tablist.
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(tabs(container)).toHaveLength(0);
    expect(picker()!.getAttribute("aria-label")).toBe("Session 1");
    expect(picker()!.getAttribute("aria-haspopup")).toBe("menu");

    const items = within(await openPicker()).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Session 1",
      "Session 2",
      "Session 3",
      "Session 4",
      "Session 5, working",
      "Session 6",
    ]);
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(items[5]!);
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it("keeps tabs while the lanes fit at their floors, and collapses one pixel short", () => {
    const { container } = render(strip({ tabs: SIX.slice(0, 4) }));
    // The boundary is whatever the rendered tabs refuse to shrink below.
    const floors = floorsOf(container);
    expect(floors).toBeGreaterThan(0);

    setRowWidth(container, floors);
    expect(tabs(container)).toHaveLength(4);
    expect(picker()).toBeNull();

    setRowWidth(container, floors - 1);
    expect(tabs(container)).toHaveLength(0);
    expect(picker()).toBeTruthy();
  });

  it("counts the row's padding, the gap and the new-session control against the tabs", () => {
    const { container } = render(strip({ tabs: SIX.slice(0, 3), onOpenSession: vi.fn() }));
    const floors = floorsOf(container);
    const row = container.querySelector<HTMLElement>("[data-session-strip]")!;
    const plus = screen.getByRole("button", { name: "New session" });
    Object.defineProperty(plus, "offsetWidth", { configurable: true, value: 24 });
    // jsdom applies no stylesheet, but computes inline styles.
    row.style.paddingLeft = "4px";
    row.style.paddingRight = "4px";
    row.style.setProperty("column-gap", "2px");
    expect(window.getComputedStyle(row).columnGap).toBe("2px");
    // 4 + 4 of padding, a 24px "+" and the 2px gap before it: 34px the tabs can't use.
    setRowWidth(container, floors + 34);
    expect(tabs(container)).toHaveLength(3);
    setRowWidth(container, floors + 33);
    expect(picker()).toBeTruthy();
    // The "+" stays beside the picker, still the way to another lane.
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  });

  it("goes back to tabs when lanes close or the strip widens, keeping the selection", () => {
    const { container, rerender } = render(strip({ activeSlot: 2 }));
    setRowWidth(container, 320);
    expect(picker()!.getAttribute("aria-label")).toBe("Session 3");

    // Three lanes fit in 320px.
    rerender(strip({ activeSlot: 2, tabs: SIX.slice(0, 3) }));
    expect(picker()).toBeNull();
    expect(marked(container).map((t) => t.getAttribute("data-slot"))).toEqual(["2"]);

    rerender(strip({ activeSlot: 2 }));
    expect(picker()).toBeTruthy();
    setRowWidth(container, 600);
    expect(picker()).toBeNull();
    expect(marked(container).map((t) => t.getAttribute("data-slot"))).toEqual(["2"]);
  });

  it("never collapses a single lane, and keeps its form while the row has no width", () => {
    const { container, rerender } = render(strip({ tabs: SIX.slice(0, 1) }));
    setRowWidth(container, 40);
    expect(tabs(container)).toHaveLength(1);

    // A hidden panel measures zero, which says nothing about whether lanes fit: tabs
    // that fit stay tabs, and a collapsed strip stays collapsed.
    rerender(strip({ tabs: SIX.slice(0, 3) }));
    setRowWidth(container, 600);
    setRowWidth(container, 0);
    expect(tabs(container)).toHaveLength(3);

    rerender(strip());
    setRowWidth(container, 320);
    setRowWidth(container, 0);
    expect(picker()).toBeTruthy();
    setRowWidth(container, 600);
    expect(tabs(container)).toHaveLength(6);
  });

  it("shows background lanes at work on the closed picker, without opening it", () => {
    const busy = SIX.map((t) =>
      t.slot === 2 || t.slot === 4
        ? { ...t, agentState: "working" as const }
        : t.slot === 3
          ? { ...t, agentState: "directing" as const }
          : t
    );
    const { container, rerender } = render(strip({ tabs: busy }));
    setRowWidth(container, 320);

    const badges = screen.getAllByTestId("assistant-session-picker-background");
    expect(badges.map((b) => [b.getAttribute("data-marker"), b.textContent])).toEqual([
      ["working", "2"],
      ["directing", ""],
    ]);
    const description = () =>
      document.getElementById(picker()!.getAttribute("aria-describedby")!)?.textContent;
    expect(description()).toBe("2 other sessions working, 1 other session directing");

    // The selected lane's own state leads its title and is not counted as background.
    rerender(strip({ tabs: busy, activeSlot: 4 }));
    expect(description()).toBe("working, 1 other session working, 1 other session directing");

    // Quiet lanes draw and say nothing.
    rerender(strip({ tabs: SIX.map((t) => ({ ...t, agentState: "waiting" as const })) }));
    expect(screen.queryAllByTestId("assistant-session-picker-background")).toHaveLength(0);
    expect(picker()!.hasAttribute("aria-describedby")).toBe(false);
  });

  it("names the agent of each lane in the picker once the lanes mix agents", async () => {
    const mixed = SIX.map((t) => ({ ...t, agentId: t.slot === 1 ? "codex" : "claude" }));
    const { container } = render(strip({ tabs: mixed }));
    setRowWidth(container, 320);

    expect(picker()!.getAttribute("aria-label")).toBe("Session 1 — Claude");
    expect(picker()!.querySelector("[data-testid='assistant-tab-agent-mark']")).toBeTruthy();
    const items = within(await openPicker()).getAllByRole("menuitemradio");
    expect(items[1]!.textContent).toBe("Session 2, Codex");
  });

  it("carries the selected lane's own menu under the list", async () => {
    const onClose = vi.fn();
    const onRestart = vi.fn();
    const onOpenSession = vi.fn();
    const onOpenSessionWithAgent = vi.fn();
    const restartable = SIX.map((t) => ({ ...t, canRestart: t.slot === 1 }));
    const { container } = render(
      strip({
        tabs: restartable,
        activeSlot: 1,
        onClose,
        onRestart,
        onOpenSession,
        canOpenSession: false,
        newSessionAgentIds: ["claude", "codex"],
        canOpenSessionWithAgent: true,
        onOpenSessionWithAgent,
      })
    );
    setRowWidth(container, 320);

    const menu = await openPicker();
    const actions = within(menu).getAllByRole("menuitem");
    expect(actions.map((a) => a.textContent)).toEqual([
      "New session",
      "New session with Claude",
      "New session with Codex",
      "Restart conversation",
      "Close session",
    ]);
    // Parked at the ceiling, as on the tab's menu; an agent choice can still start.
    expect(actions[0]!.hasAttribute("data-disabled")).toBe(true);
    expect(actions[2]!.hasAttribute("data-disabled")).toBe(false);

    // A parked item does nothing, and leaves the menu open.
    fireEvent.click(actions[0]!);
    expect(onOpenSession).not.toHaveBeenCalled();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "New session with Codex" }));
    expect(onOpenSessionWithAgent).toHaveBeenCalledWith("codex");

    fireEvent.click(
      within(await openPicker()).getByRole("menuitem", { name: "Restart conversation" })
    );
    expect(onRestart).toHaveBeenCalledWith(1);

    fireEvent.click(within(await openPicker()).getByRole("menuitem", { name: "Close session" }));
    expect(onClose).toHaveBeenCalledWith(1);
  });

  it("gates the picker's actions on the selected lane and on what is free", async () => {
    const onOpenSession = vi.fn();
    const restartable = SIX.map((t) => ({ ...t, canRestart: t.slot === 1 }));
    const { container } = render(
      strip({
        tabs: restartable,
        activeSlot: 2,
        onRestart: vi.fn(),
        onOpenSession,
        canOpenSession: true,
      })
    );
    setRowWidth(container, 320);

    const menu = await openPicker();
    // Nothing to restart in the lane on screen, and one agent offers no choice of agent.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((a) => a.textContent)
    ).toEqual(["New session", "Close session"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New session" }));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
  });

  it("follows the selection made from the picker", async () => {
    const { container } = render(<Host initialActive={3} />);
    setRowWidth(container, 320);
    expect(picker()!.getAttribute("aria-label")).toBe("Session 4");

    fireEvent.click(within(await openPicker()).getAllByRole("menuitemradio")[1]!);
    expect(picker()!.getAttribute("aria-label")).toBe("Session 2");
    const checked = within(await openPicker())
      .getAllByRole("menuitemradio")
      .map((item) => item.getAttribute("aria-checked"));
    expect(checked).toEqual(["false", "true", "false", "false", "false", "false"]);

    fireEvent.click(within(screen.getByRole("menu")).getAllByRole("menuitemradio")[5]!);
    expect(picker()!.getAttribute("aria-label")).toBe("Session 6");
    expect(document.getElementById(helpSessionTabId("six", 5))?.textContent).toBe("Session 6");
  });

  it("closes the selected lane with Delete from the closed picker, which keeps focus", () => {
    const onClose = vi.fn();
    const { container } = render(<Host initialActive={3} onClose={onClose} />);
    setRowWidth(container, 320);
    expect(picker()!.getAttribute("aria-keyshortcuts")).toBe("Delete");
    act(() => picker()!.focus());

    // Handled, so nothing above the strip reads the key as well.
    expect(fireEvent.keyDown(picker()!, { key: "Delete" })).toBe(false);
    expect(onClose).toHaveBeenCalledWith(3);
    // The neighbour that follows takes the selection, and the picker keeps the keyboard.
    expect(picker()!.getAttribute("aria-label")).toBe("Session 5");
    expect(document.activeElement).toBe(picker());

    fireEvent.keyDown(picker()!, { key: "Backspace" });
    expect(onClose).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(picker()!, { key: "x" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("hands focus to the new selected tab when a close brings the tabs back", () => {
    // Four lanes don't fit in 300px; three do.
    const { container } = render(<Host initial={SIX.slice(0, 4)} initialActive={1} />);
    setRowWidth(container, 300);
    act(() => picker()!.focus());

    fireEvent.keyDown(picker()!, { key: "Delete" });

    expect(picker()).toBeNull();
    expect(document.activeElement?.getAttribute("data-slot")).toBe("2");
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  });

  it("hands focus to the new selected tab when the picker's own Close brings the tabs back", async () => {
    const { container } = render(<Host initial={SIX.slice(0, 4)} initialActive={1} />);
    setRowWidth(container, 300);
    act(() => picker()!.focus());

    const menu = await openPicker();
    await act(async () => {
      fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Close session" }), {
        key: "Enter",
      });
    });
    await flushTimers();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement?.getAttribute("data-slot")).toBe("2");
  });

  it("hands focus to the other form when the strip switches under it", () => {
    const { container } = render(strip({ activeSlot: 2 }));
    const tab = tabs(container).find((t) => t.getAttribute("data-slot") === "2")!;
    act(() => tab.focus());

    setRowWidth(container, 320);
    expect(document.activeElement).toBe(picker());

    setRowWidth(container, 600);
    expect(document.activeElement?.getAttribute("data-slot")).toBe("2");
  });

  it("hands focus to the selected tab when the strip widens with the picker's menu open", async () => {
    const { container } = render(strip({ activeSlot: 2 }));
    setRowWidth(container, 320);
    act(() => picker()!.focus());
    const menu = await openPicker();
    expect(menu.contains(document.activeElement)).toBe(true);

    setRowWidth(container, 600);
    // Still there once the menu's own deferred focus restore has had its turn.
    await flushTimers();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement?.getAttribute("data-slot")).toBe("2");
  });

  it("takes no focus when the strip switches after the keyboard has left it", async () => {
    const { container } = render(strip({ activeSlot: 2 }));
    const tab = tabs(container).find((t) => t.getAttribute("data-slot") === "2")!;
    act(() => tab.focus());
    act(() => tab.blur());
    await flushTimers();
    expect(document.activeElement).toBe(document.body);

    setRowWidth(container, 320);
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus alone when it is not on the form that goes", () => {
    const { container } = render(
      <>
        <button type="button">Elsewhere</button>
        {strip({ onOpenSession: vi.fn(), canOpenSession: true })}
      </>
    );
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());
    setRowWidth(container, 320);
    expect(document.activeElement).toBe(elsewhere);

    // The "+" survives the switch, so it keeps focus too.
    const plus = screen.getByRole("button", { name: "New session" });
    act(() => plus.focus());
    setRowWidth(container, 600);
    expect(document.activeElement).toBe(plus);
  });

  it("names the body from the picker and says the strip has stopped being a tablist", () => {
    const onCollapsedChange = vi.fn();
    const { container } = render(strip({ activeSlot: 4, onCollapsedChange }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);

    setRowWidth(container, 320);
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
    // The id the body's `aria-labelledby` derives still resolves, to the lane's name.
    expect(document.getElementById(helpSessionTabId("six", 4))?.textContent).toBe("Session 5");

    setRowWidth(container, 600);
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
    expect(document.getElementById(helpSessionTabId("six", 4))?.getAttribute("role")).toBe("tab");
  });
});
