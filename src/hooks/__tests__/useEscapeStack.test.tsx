// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useEscapeStack } from "../useEscapeStack";
import { useGlobalEscapeDispatcher } from "../useGlobalEscapeDispatcher";
import { _resetForTests } from "@/lib/escapeStack";

beforeEach(() => {
  _resetForTests();
});

function Dispatcher() {
  useGlobalEscapeDispatcher();
  return null;
}

function Layer({ enabled, onEscape }: { enabled: boolean; onEscape: () => void }) {
  useEscapeStack(enabled, onEscape);
  return null;
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe("useEscapeStack + useGlobalEscapeDispatcher", () => {
  it("dispatches Escape to topmost layer only", () => {
    const dialogClose = vi.fn();
    const paletteClose = vi.fn();

    render(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={dialogClose} />
        <Layer enabled={true} onEscape={paletteClose} />
      </>
    );

    pressEscape();

    expect(paletteClose).toHaveBeenCalledOnce();
    expect(dialogClose).not.toHaveBeenCalled();
  });

  it("falls through to next layer after unmount", () => {
    const dialogClose = vi.fn();
    const paletteClose = vi.fn();

    const { rerender } = render(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={dialogClose} />
        <Layer enabled={true} onEscape={paletteClose} />
      </>
    );

    rerender(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={dialogClose} />
      </>
    );

    pressEscape();

    expect(dialogClose).toHaveBeenCalledOnce();
    expect(paletteClose).not.toHaveBeenCalled();
  });

  it("no-ops when stack is empty", () => {
    render(<Dispatcher />);

    const prevented = { value: false };
    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      prevented.value = event.defaultPrevented;
    });

    expect(prevented.value).toBe(false);
  });

  it("disabled layer is not on the stack", () => {
    const dialogClose = vi.fn();
    const paletteClose = vi.fn();

    render(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={dialogClose} />
        <Layer enabled={false} onEscape={paletteClose} />
      </>
    );

    pressEscape();

    expect(dialogClose).toHaveBeenCalledOnce();
    expect(paletteClose).not.toHaveBeenCalled();
  });

  it("toggling enabled adds/removes from stack", () => {
    const dialogClose = vi.fn();
    const paletteClose = vi.fn();

    const { rerender } = render(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={dialogClose} />
        <Layer enabled={false} onEscape={paletteClose} />
      </>
    );

    rerender(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={dialogClose} />
        <Layer enabled={true} onEscape={paletteClose} />
      </>
    );

    pressEscape();

    expect(paletteClose).toHaveBeenCalledOnce();
    expect(dialogClose).not.toHaveBeenCalled();
  });

  it("handler callback updates reflect on next Escape", () => {
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = render(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={first} />
      </>
    );

    rerender(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={second} />
      </>
    );

    pressEscape();

    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("does not dispatch when event.defaultPrevented is true", () => {
    const handler = vi.fn();

    render(
      <>
        <Dispatcher />
        <Layer enabled={true} onEscape={handler} />
      </>
    );

    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault();
      window.dispatchEvent(event);
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
