// @vitest-environment jsdom
import { beforeAll, describe, it, expect } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { GridScrollbar } from "../GridScrollbar";

beforeAll(() => {
  // jsdom has no pointer capture; the thumb only needs the calls to exist.
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.hasPointerCapture ??= () => false;
});

function overflowingRoot(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 3000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 1000 });
  el.scrollTo = () => {};
  document.body.appendChild(el);
  return el;
}

describe("GridScrollbar thumb", () => {
  it("only a primary press grabs the thumb", async () => {
    const root = overflowingRoot();
    const { container } = render(<GridScrollbar scrollRoot={root} revision={0} />);
    await act(async () => {});
    const thumb = container.querySelector<HTMLElement>('[role="scrollbar"]');
    if (!thumb) throw new Error("thumb did not render for an overflowing root");

    for (const button of [1, 2]) {
      fireEvent.pointerDown(thumb, { button, pointerId: 1, clientY: 100 });
      expect(thumb.dataset.phase).not.toBe("drag");
    }

    fireEvent.pointerDown(thumb, { button: 0, pointerId: 1, clientY: 100 });
    expect(thumb.dataset.phase).toBe("drag");
  });
});
