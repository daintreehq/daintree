// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { canopyCardDomId } from "../CanopyCard";
import {
  canopyCardKeys,
  canopyKeyboardPlaceOf,
  useCanopyKeyboardPlace,
} from "../useCanopyKeyboardPlace";

/** The panel's keyboard places, as the panel marks them. */
function panel() {
  document.body.innerHTML = `
    <input data-canopy-search="" />
    <div id="${canopyCardDomId("run-1")}" data-canopy-card="" tabindex="0">
      <button data-row-control="">More</button>
    </div>
    <div id="${canopyCardDomId("run-2")}" data-canopy-card="" tabindex="0"></div>
    <section data-canopy-detail="">
      <div data-canopy-terminal=""><textarea></textarea></div>
      <div class="cm-editor"><div data-editor="" tabindex="-1"></div></div>
      <button data-card-button="">Go to terminal</button>
    </section>
    <button data-elsewhere="">Refresh</button>
  `;
  const at = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  return {
    search: at("[data-canopy-search]"),
    row: at(`#${canopyCardDomId("run-1")}`),
    rowControl: at("[data-row-control]"),
    otherRow: at(`#${canopyCardDomId("run-2")}`),
    terminal: at("[data-canopy-terminal] textarea"),
    reply: at("[data-editor]"),
    cardButton: at("[data-card-button]"),
    elsewhere: at("[data-elsewhere]"),
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("canopyKeyboardPlaceOf", () => {
  it("tells the search, each row, the reply and the terminal apart", () => {
    const p = panel();
    expect(canopyKeyboardPlaceOf(p.search)).toBe("search");
    expect(canopyKeyboardPlaceOf(p.row)).toBe(`row:${canopyCardDomId("run-1")}`);
    // A row's own controls take the row's keys too, as the list routes them.
    expect(canopyKeyboardPlaceOf(p.rowControl)).toBe(`row:${canopyCardDomId("run-1")}`);
    expect(canopyKeyboardPlaceOf(p.otherRow)).toBe(`row:${canopyCardDomId("run-2")}`);
    expect(canopyKeyboardPlaceOf(p.reply)).toBe("reply");
    expect(canopyKeyboardPlaceOf(p.terminal)).toBe("terminal");
  });

  it("places the card's own buttons, anything else and nothing nowhere", () => {
    const p = panel();
    expect(canopyKeyboardPlaceOf(p.cardButton)).toBeNull();
    expect(canopyKeyboardPlaceOf(p.elsewhere)).toBeNull();
    expect(canopyKeyboardPlaceOf(document.body)).toBeNull();
    expect(canopyKeyboardPlaceOf(null)).toBeNull();
  });
});

describe("canopyCardKeys", () => {
  const ownRow = `row:${canopyCardDomId("run-1")}` as const;

  it("names the list's keys only from the card's own run's row", () => {
    expect(canopyCardKeys(ownRow, "run-1", null)).toBe("list");
    expect(canopyCardKeys(`row:${canopyCardDomId("run-2")}`, "run-1", "run-1")).toBeNull();
  });

  it("names Enter from the search only when its Enter opens the card's run", () => {
    expect(canopyCardKeys("search", "run-1", "run-1")).toBe("search");
    // An archived run kept open under a fold, with the search's Enter on the list's top row.
    expect(canopyCardKeys("search", "run-1", "run-2")).toBeNull();
    // The search's Enter goes to an assistant.
    expect(canopyCardKeys("search", "run-1", null)).toBeNull();
  });

  it("names the reply's keys from the reply, and nothing from the terminal or elsewhere", () => {
    expect(canopyCardKeys("reply", "run-1", null)).toBe("reply");
    expect(canopyCardKeys("terminal", "run-1", "run-1")).toBeNull();
    expect(canopyCardKeys(null, "run-1", "run-1")).toBeNull();
  });
});

describe("useCanopyKeyboardPlace", () => {
  it("starts where the keyboard already is, as the search takes it on opening", () => {
    const p = panel();
    p.search.focus();
    const { result } = renderHook(() => useCanopyKeyboardPlace(true));
    expect(result.current).toBe("search");
  });

  it("follows the keyboard from place to place", () => {
    const p = panel();
    const { result } = renderHook(() => useCanopyKeyboardPlace(true));
    act(() => p.row.focus());
    expect(result.current).toBe(`row:${canopyCardDomId("run-1")}`);
    act(() => p.reply.focus());
    expect(result.current).toBe("reply");
    act(() => p.cardButton.focus());
    expect(result.current).toBeNull();
    act(() => p.terminal.focus());
    expect(result.current).toBe("terminal");
  });

  it("goes nowhere once the keyboard leaves for nothing", async () => {
    const p = panel();
    const { result } = renderHook(() => useCanopyKeyboardPlace(true));
    act(() => p.reply.focus());
    expect(result.current).toBe("reply");
    await act(async () => p.reply.blur());
    expect(result.current).toBeNull();
  });

  it("follows nothing while closed, and stops when it closes", () => {
    const p = panel();
    const { result, rerender } = renderHook(({ open }) => useCanopyKeyboardPlace(open), {
      initialProps: { open: false },
    });
    act(() => p.reply.focus());
    expect(result.current).toBeNull();
    rerender({ open: true });
    expect(result.current).toBe("reply");
    rerender({ open: false });
    expect(result.current).toBeNull();
    act(() => p.row.focus());
    expect(result.current).toBeNull();
  });
});
