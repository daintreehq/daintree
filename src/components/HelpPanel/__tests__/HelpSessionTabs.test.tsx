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
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dispatchEscape, registerEscape } from "@/lib/escapeStack";
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
 * The session strip: one menu button naming the session on screen, at every lane count
 * (#16329).
 *
 * What is pinned here is the RULES the strip rests on, not the tokens that paint it:
 * every lane reachable from one control, the lanes not on screen still visible when they
 * are busy, a new session one menu away, and the keyboard and focus contract.
 */

const lanes = (count: number, patch: (slot: number) => Partial<HelpSessionTab> = () => ({})) =>
  Array.from({ length: count }, (_, slot): HelpSessionTab => ({
    slot,
    label: `Session ${slot + 1}`,
    agentState: undefined,
    ...patch(slot),
  }));

type StripProps = Parameters<typeof HelpSessionTabs>[0];

const strip = (props: Partial<StripProps> = {}) => (
  <HelpSessionTabs
    tabs={lanes(2)}
    activeSlot={0}
    onSelect={vi.fn()}
    onClose={vi.fn()}
    idBase="strip"
    {...props}
  />
);

/** A host that closes and selects as the panel does: a closed selected lane hands on to its neighbour. */
function Host({
  initial = lanes(MAX_ASSISTANT_SLOTS),
  initialActive,
  onClose,
  onSelect,
}: {
  initial?: HelpSessionTab[];
  initialActive: number;
  onClose?: (slot: number) => void;
  onSelect?: (slot: number) => void;
}) {
  const [tabs, setTabs] = useState(initial);
  const [active, setActive] = useState(initialActive);
  return strip({
    tabs,
    activeSlot: active,
    onSelect: (slot) => {
      setActive(slot);
      onSelect?.(slot);
    },
    onClose: (slot) => {
      onClose?.(slot);
      const index = tabs.findIndex((t) => t.slot === slot);
      const next = tabs.filter((t) => t.slot !== slot);
      setTabs(next);
      if (slot === active) setActive((next[index] ?? next[index - 1])!.slot);
    },
  });
}

const picker = () => screen.getByTestId("assistant-session-picker");
const openPicker = async () => {
  fireEvent.keyDown(picker(), { key: "Enter" });
  return screen.findByRole("menu");
};
const description = () =>
  document.getElementById(picker().getAttribute("aria-describedby") ?? "")?.textContent ?? null;
// Past the exit animation and the zero-delay timer a menu's focus restore runs on.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 250)));

afterEach(cleanup);

describe("HelpSessionTabs", () => {
  it("is one menu button at every lane count, with no tabs and no separate new-session control", () => {
    for (const count of [1, 2, 3, MAX_ASSISTANT_SLOTS]) {
      const { container, unmount } = render(
        strip({ tabs: lanes(count), onOpenSession: vi.fn(), canOpenSession: true })
      );
      expect(container.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
      const buttons = container.querySelectorAll("button");
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.getAttribute("aria-haspopup")).toBe("menu");
      unmount();
    }
  });

  it("renders nothing while the selected lane has no entry", () => {
    const { container } = render(strip({ tabs: [], activeSlot: 0 }));
    expect(container.firstChild).toBeNull();
  });

  it("names the trigger and the body by the whole task title, not the capped label", () => {
    const tabs = lanes(2, (slot) =>
      slot === 1
        ? { label: "Write release notes for…", fullTitle: "Write release notes for the build" }
        : {}
    );
    render(strip({ tabs, activeSlot: 1 }));
    expect(picker().getAttribute("aria-label")).toBe("Write release notes for the build");
    // The id the body's `aria-labelledby` derives resolves to the same name.
    expect(document.getElementById(helpSessionTabId("strip", 1))?.textContent).toBe(
      "Write release notes for the build"
    );
  });

  it("keeps the identifying end of a Session N label out of the truncating element", () => {
    render(strip({ tabs: lanes(12), activeSlot: 11 }));
    const truncating = picker().querySelector(".truncate");
    expect(truncating?.textContent).toBe("Session");
    expect(truncating?.parentElement?.textContent).toBe("Session 12");
  });

  it("names each lane's agent only once the lanes mix agents", async () => {
    const { unmount } = render(strip({ tabs: lanes(2, () => ({ agentId: "claude" })) }));
    expect(picker().getAttribute("aria-label")).toBe("Session 1");
    expect(picker().querySelector("[data-testid='assistant-tab-agent-mark']")).toBeNull();
    unmount();

    render(
      strip({
        tabs: lanes(2, (slot) => ({ agentId: slot === 1 ? "codex" : "claude" })),
      })
    );
    expect(picker().getAttribute("aria-label")).toBe("Session 1 — Claude");
    expect(picker().querySelector("[data-testid='assistant-tab-agent-mark']")).toBeTruthy();
    const items = within(await openPicker()).getAllByRole("menuitemradio");
    // Written on the row as well as spoken, so the mark never has to be recognised.
    // Written on the row for the eye (aria-hidden) as well as in its name.
    const visibleAgent = Array.from(items[1]!.querySelectorAll('[aria-hidden="true"]')).map(
      (el) => el.textContent
    );
    expect(visibleAgent).toContain("Codex");
    expect(items[1]!.querySelector(".sr-only")?.textContent).toContain("Codex");
  });

  it("counts the other lanes at work on the closed trigger, apart from its own state", () => {
    const busy = lanes(MAX_ASSISTANT_SLOTS, (slot) =>
      slot === 2 || slot === 4
        ? { agentState: "working" }
        : slot === 3
          ? { agentState: "directing" }
          : {}
    );
    const { rerender } = render(strip({ tabs: busy }));
    const pill = () => screen.queryByTestId("assistant-session-picker-background");
    const counts = () =>
      Array.from(pill()?.querySelectorAll("[data-marker]") ?? []).map((m) => [
        m.getAttribute("data-marker"),
        m.textContent,
      ]);
    // A single lane is counted too: a bare glyph read as this session working.
    expect(counts()).toEqual([
      ["working", "2"],
      ["directing", "1"],
    ]);
    expect(description()).toBe("2 other sessions working, 1 other session directing");

    // The selected lane's own state is described, and not counted as background.
    rerender(strip({ tabs: busy, activeSlot: 4 }));
    expect(counts()).toEqual([
      ["working", "1"],
      ["directing", "1"],
    ]);
    expect(description()).toBe("working, 1 other session working, 1 other session directing");

    // Quiet lanes draw and say nothing.
    rerender(strip({ tabs: lanes(MAX_ASSISTANT_SLOTS, () => ({ agentState: "waiting" })) }));
    expect(pill()).toBeNull();
    expect(picker().hasAttribute("aria-describedby")).toBe(false);
  });

  it("explains in words what only a glyph says, and stays quiet for a bare Session N", async () => {
    const { rerender } = render(strip({ tabs: lanes(2) }));
    fireEvent.pointerMove(picker());
    fireEvent.focus(picker());
    expect(screen.queryByRole("tooltip")).toBeNull();

    rerender(strip({ tabs: lanes(2, (slot) => (slot === 1 ? { agentState: "working" } : {})) }));
    fireEvent.blur(picker());
    fireEvent.focus(picker());
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("1 other session working");
  });

  it("lists every lane as a radio item in one named group, and selects by slot", async () => {
    const onSelect = vi.fn();
    const tabs = lanes(3).map((t, i) => ({ ...t, slot: [0, 2, 5][i]! }));
    render(strip({ tabs, activeSlot: 2, onSelect }));
    const menu = await openPicker();
    const group = within(menu).getByRole("group", { name: "Open sessions" });
    const items = within(group).getAllByRole("menuitemradio");
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    fireEvent.click(items[2]!);
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it("carries a new session and the selected lane's own actions under the list", async () => {
    const onClose = vi.fn();
    const onRestart = vi.fn();
    const onOpenSession = vi.fn();
    const onOpenSessionWithAgent = vi.fn();
    render(
      strip({
        tabs: lanes(3, (slot) => ({ canRestart: slot === 1 })),
        activeSlot: 1,
        onClose,
        onRestart,
        onOpenSession,
        canOpenSession: true,
        newSessionAgentIds: ["claude", "codex"],
        onOpenSessionWithAgent,
      })
    );
    const menu = await openPicker();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((a) => a.textContent)
    ).toEqual([
      "New session",
      "New session with Claude",
      "New session with Codex",
      "Restart conversation",
      "Close session",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New session" }));
    expect(onOpenSession).toHaveBeenCalledTimes(1);

    fireEvent.click(
      within(await openPicker()).getByRole("menuitem", { name: "New session with Codex" })
    );
    expect(onOpenSessionWithAgent).toHaveBeenCalledWith("codex");

    fireEvent.click(
      within(await openPicker()).getByRole("menuitem", { name: "Restart conversation" })
    );
    expect(onRestart).toHaveBeenCalledWith(1);

    fireEvent.click(within(await openPicker()).getByRole("menuitem", { name: "Close session" }));
    expect(onClose).toHaveBeenCalledWith(1);
  });

  it("offers a restart only where the selected lane has something to restart, and agents only when there is a choice", async () => {
    render(
      strip({
        tabs: lanes(2, (slot) => ({ canRestart: slot === 1 })),
        activeSlot: 0,
        onRestart: vi.fn(),
        onOpenSession: vi.fn(),
        canOpenSession: true,
        newSessionAgentIds: ["claude"],
        onOpenSessionWithAgent: vi.fn(),
      })
    );
    expect(
      within(await openPicker())
        .getAllByRole("menuitem")
        .map((a) => a.textContent)
    ).toEqual(["New session", "Close session"]);
  });

  it("parks New session at the ceiling with the reason on the row, and does nothing", async () => {
    const onOpenSession = vi.fn();
    render(
      strip({
        tabs: lanes(MAX_ASSISTANT_SLOTS),
        onOpenSession,
        canOpenSession: false,
        newSessionAgentIds: ["claude", "codex"],
        canOpenSessionWithAgent: false,
        onOpenSessionWithAgent: vi.fn(),
      })
    );
    const menu = await openPicker();
    const item = within(menu).getAllByRole("menuitem")[0]!;
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.textContent).toContain(`${MAX_ASSISTANT_SLOTS} of ${MAX_ASSISTANT_SLOTS} open`);
    expect(item.textContent).toContain(
      `${MAX_ASSISTANT_SLOTS} sessions is the maximum for one project`
    );
    // The agent items are parked with it, and say why to a screen reader as well.
    const withAgent = within(menu).getAllByRole("menuitem")[1]!;
    expect(withAgent.hasAttribute("data-disabled")).toBe(true);
    expect(withAgent.textContent).toContain("is the maximum for one project");

    fireEvent.click(item);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("gives no cap reason while New session is only waiting on something else", async () => {
    render(strip({ tabs: lanes(2), onOpenSession: vi.fn(), canOpenSession: false }));
    const item = within(await openPicker()).getAllByRole("menuitem")[0]!;
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.textContent).toBe("New session");
  });

  it("closes the selected lane with Delete or Backspace from the closed trigger, which keeps focus", () => {
    const onClose = vi.fn();
    // Sparse slots, so a close by position rather than by slot would show.
    const sparse = [0, 2, 3, 5].map((slot) => ({
      ...lanes(1)[0]!,
      slot,
      label: `Session ${slot + 1}`,
    }));
    render(<Host initial={sparse} initialActive={2} onClose={onClose} />);
    act(() => picker().focus());

    // Handled, so nothing above the strip reads the key as well.
    expect(fireEvent.keyDown(picker(), { key: "Delete" })).toBe(false);
    expect(onClose).toHaveBeenCalledWith(2);
    expect(picker().getAttribute("aria-label")).toBe("Session 4");
    expect(document.activeElement).toBe(picker());

    fireEvent.keyDown(picker(), { key: "Backspace" });
    expect(onClose).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(picker(), { key: "x" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores a held close key and modified chords, since the trigger outlives every lane", () => {
    const onClose = vi.fn();
    render(<Host initialActive={0} onClose={onClose} />);
    act(() => picker().focus());
    fireEvent.keyDown(picker(), { key: "Delete", repeat: true });
    fireEvent.keyDown(picker(), { key: "Backspace", metaKey: true });
    fireEvent.keyDown(picker(), { key: "Backspace", altKey: true });
    fireEvent.keyDown(picker(), { key: "Delete", shiftKey: true });
    fireEvent.keyDown(picker(), { key: "Delete", ctrlKey: true });
    expect(onClose).not.toHaveBeenCalled();
    // The same key, unmodified, still closes.
    fireEvent.keyDown(picker(), { key: "Delete" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the menu on Escape, ahead of whatever the panel registered", async () => {
    const hidePanel = vi.fn();
    const panel = registerEscape(hidePanel);
    try {
      render(strip());
      await openPicker();
      act(() => {
        dispatchEscape();
      });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(hidePanel).not.toHaveBeenCalled();

      // Closed, the menu is off the stack and Escape is the panel's again.
      act(() => {
        dispatchEscape();
      });
      expect(hidePanel).toHaveBeenCalledTimes(1);
    } finally {
      panel.unregister();
    }
  });

  it("leaves focus where picking a lane sent it, rather than pulling it back to the trigger", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      // As the panel's reveal does: the terminal takes focus a frame after the pick,
      // once the menu has stopped trapping it.
      render(<Host initialActive={0} onSelect={() => setTimeout(() => outside.focus(), 0)} />);
      act(() => picker().focus());
      const menu = await openPicker();
      fireEvent.click(within(menu).getAllByRole("menuitemradio")[2]!);
      await settle();
      expect(document.activeElement).toBe(outside);
      expect(picker().getAttribute("aria-label")).toBe("Session 3");
    } finally {
      outside.remove();
    }
  });

  it("puts focus back on the trigger when nothing took it, as a lane still launching leaves it", async () => {
    render(strip({ onOpenSession: vi.fn(), canOpenSession: true }));
    act(() => picker().focus());
    const menu = await openPicker();
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "New session" }), {
      key: "Enter",
    });
    await settle();
    expect(document.activeElement).toBe(picker());
  });
});

describe("HelpSessionTabs — what the tabs used to pin, as the picker carries it", () => {
  it("follows a selection made from the menu: checked row, trigger and the body's name together", async () => {
    const sparse = [0, 2, 5].map((slot) => ({
      ...lanes(1)[0]!,
      slot,
      label: `Session ${slot + 1}`,
    }));
    render(<Host initial={sparse} initialActive={0} />);
    fireEvent.click(within(await openPicker()).getAllByRole("menuitemradio")[2]!);
    expect(picker().getAttribute("aria-label")).toBe("Session 6");
    expect(document.getElementById(helpSessionTabId("strip", 5))?.textContent).toBe("Session 6");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const checked = within(await openPicker())
      .getAllByRole("menuitemradio")
      .map((item) => item.getAttribute("aria-checked"));
    expect(checked).toEqual(["false", "false", "true"]);
  });

  it("lets an agent choice start a session where New session can't, and parks each on its own gate", async () => {
    const onOpenSession = vi.fn();
    const onOpenSessionWithAgent = vi.fn();
    render(
      strip({
        tabs: lanes(MAX_ASSISTANT_SLOTS),
        onOpenSession,
        canOpenSession: false,
        newSessionAgentIds: ["claude", "codex"],
        // An empty lane at the ceiling: a named agent fills it.
        canOpenSessionWithAgent: true,
        onOpenSessionWithAgent,
      })
    );
    const menu = await openPicker();
    const [plain, , withCodex] = within(menu).getAllByRole("menuitem");
    expect(plain!.hasAttribute("data-disabled")).toBe(true);
    expect(withCodex!.hasAttribute("data-disabled")).toBe(false);
    // No cap reason on an item that can still act.
    expect(withCodex!.textContent).not.toContain("maximum");
    fireEvent.click(plain!);
    expect(onOpenSession).not.toHaveBeenCalled();
    fireEvent.click(withCodex!);
    expect(onOpenSessionWithAgent).toHaveBeenCalledWith("codex");
  });

  it("never fires a parked agent item", async () => {
    const onOpenSessionWithAgent = vi.fn();
    render(
      strip({
        newSessionAgentIds: ["claude", "codex"],
        canOpenSessionWithAgent: false,
        onOpenSessionWithAgent,
      })
    );
    fireEvent.click(within(await openPicker()).getAllByRole("menuitem")[0]!);
    expect(onOpenSessionWithAgent).not.toHaveBeenCalled();
  });

  it("offers no New session without a handler, and no restart without one", async () => {
    render(strip({ tabs: lanes(2, () => ({ canRestart: true })) }));
    const names = within(await openPicker())
      .getAllByRole("menuitem")
      .map((a) => a.textContent);
    expect(names).not.toContain("New session");
    expect(names).not.toContain("Restart conversation");
    expect(names).toContain("Close session");
  });

  it("names a task-titled lane in the tooltip, with its agent once agents mix", async () => {
    const tabs = lanes(2, (slot) => ({
      agentId: slot === 0 ? "claude" : "codex",
      ...(slot === 0 ? { label: "Refactor the…", fullTitle: "Refactor the session store" } : {}),
    }));
    // A menu closed by the test before arms the one-shot close-time tooltip suppression
    // on whatever takes focus next; let something else take it.
    const sink = document.createElement("button");
    document.body.appendChild(sink);
    act(() => sink.focus());
    sink.remove();
    render(strip({ tabs }));
    fireEvent.focus(picker());
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("Refactor the session store — Claude");
  });

  it("holds the tooltip shut while the menu is open", async () => {
    render(strip({ tabs: lanes(2, (slot) => (slot === 1 ? { agentState: "working" } : {})) }));
    await openPicker();
    fireEvent.focus(picker());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("truncates a task title from its end, without pinning its last word", () => {
    render(
      strip({
        tabs: lanes(1, () => ({ label: "Fix the flaky tests", fullTitle: "Fix the flaky tests" })),
      })
    );
    const truncating = picker().querySelector(".truncate");
    expect(truncating?.textContent).toBe("Fix the flaky tests");
  });

  it("gives every row the same leading columns once any row needs one", async () => {
    const tabs = lanes(3, (slot) => ({
      agentState: slot === 1 ? "working" : undefined,
      agentId: slot === 2 ? null : slot === 0 ? "claude" : "codex",
    }));
    render(strip({ tabs }));
    const items = within(await openPicker()).getAllByRole("menuitemradio");
    // The title is the first text-bearing span after the leading glyph columns.
    const leading = (item: HTMLElement) => {
      const row = item.querySelector(":scope > span:not(:first-child)")!;
      const title = Array.from(row.children).findIndex((c) => c.classList.contains("break-words"));
      return title;
    };
    const counts = items.map(leading);
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(2);
  });

  it("survives the selected lane going missing and coming back, with nothing left on Escape", async () => {
    const hidePanel = vi.fn();
    const panel = registerEscape(hidePanel);
    try {
      const { rerender, container } = render(strip({ tabs: lanes(2), activeSlot: 1 }));
      await openPicker();
      rerender(strip({ tabs: lanes(2), activeSlot: 4 }));
      expect(container.firstChild).toBeNull();
      act(() => {
        dispatchEscape();
      });
      expect(hidePanel).toHaveBeenCalledTimes(1);
      rerender(strip({ tabs: lanes(2), activeSlot: 1 }));
      expect(picker().getAttribute("aria-label")).toBe("Session 2");
    } finally {
      panel.unregister();
    }
  });
});

describe("TabStateIndicator", () => {
  it("marks only work in flight: working and directing, never a stop or a prompt", () => {
    const drawn = (state: HelpSessionTab["agentState"]) =>
      render(<TabStateIndicator agentState={state} />).container.childElementCount;
    expect(drawn("working")).toBe(1);
    expect(drawn("directing")).toBe(1);
    // Two different marks, not one glyph in two colours.
    const markup = (state: HelpSessionTab["agentState"]) =>
      render(<TabStateIndicator agentState={state} />).container.querySelector("svg")?.innerHTML;
    expect(markup("working")).not.toBe(markup("directing"));
    expect(drawn("waiting")).toBe(0);
    expect(drawn("idle")).toBe(0);
    expect(drawn("completed")).toBe(0);
    expect(drawn(undefined)).toBe(0);
  });
});
