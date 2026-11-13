// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DockFocusLandmarkContext,
  focusFirstAccepting,
  isFocusTargetVisible,
  openPopoverContent,
  releaseFocusOwner,
  useDockPillHideHandoff,
  visibleFocusables,
} from "../dockFocusHandoff";
import {
  _resetTooltipFocusSuppressionForTests,
  isTooltipSuppressedForElement,
} from "@/lib/tooltipFocusSuppression";

afterEach(() => {
  cleanup();
  _resetTooltipFocusSuppressionForTests();
});

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe("isFocusTargetVisible", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("rejects a button under a status pill that is hidden", () => {
    const host = mount(
      `<span data-visible="false"><button id="quiet">Waiting</button></span>
       <span data-visible="true"><button id="live">Errors</button></span>`
    );
    expect(isFocusTargetVisible(host.querySelector<HTMLElement>("#quiet")!)).toBe(false);
    expect(isFocusTargetVisible(host.querySelector<HTMLElement>("#live")!)).toBe(true);
  });

  it("rejects disabled, hidden, inert and aria-hidden controls and detached ones", () => {
    const host = mount(
      `<button id="disabled" disabled></button>
       <div hidden><button id="hidden"></button></div>
       <div inert><button id="inert"></button></div>
       <button id="ghost" aria-hidden="true" tabindex="-1"></button>`
    );
    for (const id of ["disabled", "hidden", "inert", "ghost"]) {
      expect(isFocusTargetVisible(host.querySelector<HTMLElement>(`#${id}`)!), id).toBe(false);
    }
    expect(isFocusTargetVisible(document.createElement("button"))).toBe(false);
  });

  it("defers to checkVisibility where the engine has it, so display: none is caught", () => {
    const host = mount(`<button id="b"></button>`);
    const button = host.querySelector<HTMLElement>("#b")!;
    button.checkVisibility = vi.fn(() => false);
    expect(isFocusTargetVisible(button)).toBe(false);
    expect(button.checkVisibility).toHaveBeenCalledWith({ visibilityProperty: true });

    button.checkVisibility = vi.fn(() => true);
    expect(isFocusTargetVisible(button)).toBe(true);
  });
});

describe("openPopoverContent", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("answers for an open popover and refuses one that is on its way out", () => {
    const host = mount(`<div id="pop" data-state="open"></div>`);
    const pop = host.querySelector<HTMLElement>("#pop")!;
    expect(openPopoverContent("pop")).toBe(pop);

    pop.setAttribute("data-state", "closed");
    expect(openPopoverContent("pop")).toBeNull();
    expect(openPopoverContent("missing")).toBeNull();
  });
});

describe("releaseFocusOwner", () => {
  const blur = (target: Element, relatedTarget: Element | null) => ({ target, relatedTarget });
  const buttons = () => {
    const host = mount(`<button id="a"></button><button id="b"></button>`);
    return { a: host.querySelector<HTMLElement>("#a")!, b: host.querySelector<HTMLElement>("#b")! };
  };

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("lets go at once when the blur names where focus went", () => {
    const { a, b } = buttons();
    const ref = { current: a as Element | null };

    releaseFocusOwner(blur(a, b), ref);

    expect(ref.current).toBeNull();
  });

  it("does not let a stale blur release the element that has since taken over", async () => {
    const { a, b } = buttons();
    const ref = { current: a as Element | null };

    releaseFocusOwner(blur(a, null), ref);
    ref.current = b;
    await Promise.resolve();

    expect(ref.current).toBe(b);
  });

  it("holds the claim while the element is still the document's focus", async () => {
    const { a } = buttons();
    a.focus();
    const ref = { current: a as Element | null };

    releaseFocusOwner(blur(a, null), ref);
    await Promise.resolve();

    expect(ref.current).toBe(a);
  });

  it("lets go once focus has fallen to the document", async () => {
    const { a } = buttons();
    const ref = { current: a as Element | null };

    releaseFocusOwner(blur(a, null), ref);
    await Promise.resolve();

    expect(ref.current).toBeNull();
  });

  it("lets go once the element has gone", async () => {
    const { b } = buttons();
    b.focus();
    const ref = { current: b as Element | null };

    releaseFocusOwner(blur(b, null), ref);
    b.remove();
    await Promise.resolve();

    expect(ref.current).toBeNull();
  });
});

describe("visibleFocusables / focusFirstAccepting", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("lists only the visible matches, in document order", () => {
    const host = mount(
      `<span data-visible="false"><button id="a"></button></span>
       <span data-visible="true"><button id="b"></button></span>
       <button id="c"></button>`
    );
    expect(visibleFocusables(host, "button").map((el) => el.id)).toEqual(["b", "c"]);
    expect(visibleFocusables(null, "button")).toEqual([]);
  });

  it("moves on from a candidate that refuses focus", () => {
    const host = mount(`<button id="stuck"></button><button id="next"></button>`);
    const stuck = host.querySelector<HTMLElement>("#stuck")!;
    const next = host.querySelector<HTMLElement>("#next")!;
    stuck.focus = vi.fn();

    focusFirstAccepting([null, stuck, next]);

    expect(stuck.focus).toHaveBeenCalled();
    expect(document.activeElement).toBe(next);
  });

  it("keeps the destination's focus-driven tooltip shut", () => {
    const host = mount(`<button id="dest"></button>`);
    const dest = host.querySelector<HTMLElement>("#dest")!;

    focusFirstAccepting([dest]);

    expect(isTooltipSuppressedForElement(dest)).toBe(true);
  });

  it("hands focus over ringless only when told the source had no ring", () => {
    const host = mount(`<button id="dest"></button>`);
    const dest = host.querySelector<HTMLElement>("#dest")!;
    const focus = vi.spyOn(dest, "focus");

    focusFirstAccepting([dest], { focusVisible: false });
    focusFirstAccepting([dest], { focusVisible: true });
    focusFirstAccepting([dest]);

    expect(focus.mock.calls).toEqual([
      [{ preventScroll: true, focusVisible: false }],
      [{ preventScroll: true }],
      [{ preventScroll: true }],
    ]);
  });

  it("never focuses a candidate under a hidden pill", () => {
    const host = mount(
      `<span data-visible="false"><button id="quiet"></button></span><button id="live"></button>`
    );
    focusFirstAccepting(Array.from(host.querySelectorAll<HTMLElement>("button")));
    expect(document.activeElement).toBe(host.querySelector("#live"));
  });
});

describe("useDockPillHideHandoff", () => {
  const handoff = vi.fn();
  const landmark = { handoff, resolve: () => null };

  function Pill({ count }: { count: number }) {
    const handlers = useDockPillHideHandoff(count);
    return (
      <span data-visible={count > 0 ? "true" : "false"} {...handlers}>
        <button type="button" data-testid="trigger" />
        {count > 0 && <button type="button" data-testid="row" />}
      </span>
    );
  }

  function renderPill(count: number) {
    const tree = (n: number) => (
      <DockFocusLandmarkContext.Provider value={landmark}>
        <input data-testid="outside" />
        <Pill count={n} />
      </DockFocusLandmarkContext.Provider>
    );
    const view = render(tree(count));
    return { ...view, setCount: (n: number) => view.rerender(tree(n)) };
  }

  beforeEach(() => {
    handoff.mockClear();
  });

  it("hands focus on when the pill hides under a focused trigger", () => {
    const { getByTestId, setCount } = renderPill(2);
    act(() => getByTestId("trigger").focus());

    setCount(0);

    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("hands focus on when the focused row is removed with the last entry", () => {
    const { getByTestId, setCount } = renderPill(1);
    act(() => getByTestId("row").focus());

    setCount(0);

    expect(document.activeElement).toBe(document.body);
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("keeps focus through a count that falls but does not reach zero", () => {
    const { getByTestId, setCount } = renderPill(2);
    act(() => getByTestId("trigger").focus());

    setCount(1);
    expect(handoff).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(getByTestId("trigger"));

    setCount(0);
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("does not hand off a second time when the effect re-runs at zero", () => {
    const { getByTestId, rerender } = renderPill(1);
    act(() => getByTestId("trigger").focus());
    const again = (n: number, forward: () => void) =>
      rerender(
        <DockFocusLandmarkContext.Provider value={{ handoff: forward, resolve: () => null }}>
          <input data-testid="outside" />
          <Pill count={n} />
        </DockFocusLandmarkContext.Provider>
      );

    again(0, () => handoff());
    // A new landmark identity re-runs the effect; the claim was spent already.
    again(0, () => handoff());

    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("tells the dock whether the focus it is taking over was ringed", () => {
    const ringless = renderPill(1);
    const trigger = ringless.getByTestId("trigger");
    vi.spyOn(trigger, "matches").mockImplementation((selector: string) =>
      selector === ":focus-visible" ? false : Element.prototype.matches.call(trigger, selector)
    );
    act(() => trigger.focus());
    ringless.setCount(0);
    expect(handoff).toHaveBeenLastCalledWith({ focusVisible: false });
    ringless.unmount();

    const ringed = renderPill(1);
    const other = ringed.getByTestId("trigger");
    vi.spyOn(other, "matches").mockImplementation((selector: string) =>
      selector === ":focus-visible" ? true : Element.prototype.matches.call(other, selector)
    );
    act(() => other.focus());
    ringed.setCount(0);
    expect(handoff).toHaveBeenLastCalledWith({ focusVisible: true });
  });

  it("hands off in the commit itself, before any passive effect can run", () => {
    const order: string[] = [];
    handoff.mockImplementation(() => order.push("handoff"));
    function Parent({ count }: { count: number }) {
      // A parent's layout effect follows its children's and precedes passive ones.
      useLayoutEffect(() => {
        order.push(`parent-layout-${count}`);
      });
      return <Pill count={count} />;
    }
    const tree = (n: number) => (
      <DockFocusLandmarkContext.Provider value={landmark}>
        <Parent count={n} />
      </DockFocusLandmarkContext.Provider>
    );
    const view = render(tree(1));
    act(() => view.getByTestId("trigger").focus());
    order.length = 0;

    view.rerender(tree(0));

    expect(order).toEqual(["handoff", "parent-layout-0"]);
    handoff.mockReset();
  });

  it("leaves focus where the user put it", () => {
    const { getByTestId, setCount } = renderPill(1);
    act(() => getByTestId("trigger").focus());
    act(() => getByTestId("outside").focus());

    setCount(0);

    expect(handoff).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(getByTestId("outside"));
  });

  it("ignores focus that left for the document before the pill hid", async () => {
    const { getByTestId, setCount } = renderPill(1);
    const trigger = getByTestId("trigger");
    act(() => trigger.focus());
    act(() => trigger.blur());
    await act(async () => {
      await Promise.resolve();
    });

    setCount(0);

    expect(handoff).not.toHaveBeenCalled();
  });

  it("keeps a focus that never entered the pill out of it", () => {
    const { setCount } = renderPill(1);

    setCount(0);

    expect(handoff).not.toHaveBeenCalled();
  });

  it("holds its claim when the window loses focus with the element still focused", async () => {
    const { getByTestId, setCount } = renderPill(1);
    const trigger = getByTestId("trigger");
    act(() => trigger.focus());
    // A window switch blurs the element without moving the document's focus.
    act(() => {
      trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    setCount(0);

    expect(handoff).toHaveBeenCalledTimes(1);
  });
});
