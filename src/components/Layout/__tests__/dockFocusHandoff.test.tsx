// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DockFocusLandmarkContext,
  focusFirstAccepting,
  isFocusTargetVisible,
  useDockPillHideHandoff,
  visibleFocusables,
} from "../dockFocusHandoff";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";

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

  it("does not hand off a second time for an unrelated re-render at zero", () => {
    const { getByTestId, setCount } = renderPill(1);
    act(() => getByTestId("trigger").focus());

    setCount(0);
    setCount(0);

    expect(handoff).toHaveBeenCalledTimes(1);
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
