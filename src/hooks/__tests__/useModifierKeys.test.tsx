// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useModifierKeys } from "../useModifierKeys";

function setHidden(value: boolean) {
  Object.defineProperty(document, "hidden", {
    value,
    configurable: true,
    writable: true,
  });
}

function key(type: "keydown" | "keyup", init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent(type, init));
}

afterEach(() => {
  setHidden(false);
});

describe("useModifierKeys", () => {
  it("tracks meta and alt down/up", () => {
    const { result } = renderHook(() => useModifierKeys());
    expect(result.current).toEqual({ meta: false, alt: false });

    act(() => key("keydown", { key: "Meta", metaKey: true }));
    expect(result.current.meta).toBe(true);

    act(() => key("keydown", { key: "Alt", metaKey: true, altKey: true }));
    expect(result.current.alt).toBe(true);

    act(() => {
      key("keyup", { key: "Meta", altKey: true });
      key("keyup", { key: "Alt" });
    });
    expect(result.current).toEqual({ meta: false, alt: false });
  });

  it("keeps meta while Command is held and Control is released — issue #13584", () => {
    const { result } = renderHook(() => useModifierKeys());

    act(() => {
      key("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
      key("keydown", { key: "Control", code: "ControlLeft", metaKey: true, ctrlKey: true });
      key("keyup", { key: "Control", code: "ControlLeft", metaKey: true });
    });
    expect(result.current.meta).toBe(true);

    act(() => key("keyup", { key: "Meta", code: "MetaLeft" }));
    expect(result.current.meta).toBe(false);
  });

  it("keeps meta while Control is held and Command is released", () => {
    const { result } = renderHook(() => useModifierKeys());

    act(() => {
      key("keydown", { key: "Control", ctrlKey: true });
      key("keydown", { key: "Meta", metaKey: true, ctrlKey: true });
      key("keyup", { key: "Meta", ctrlKey: true });
    });
    expect(result.current.meta).toBe(true);
  });

  it.each([
    ["Meta", "metaKey", "meta"],
    ["Control", "ctrlKey", "meta"],
    ["Alt", "altKey", "alt"],
  ] as const)("keeps %s set until both left and right keys are released", (name, flag, field) => {
    const { result } = renderHook(() => useModifierKeys());

    act(() => {
      key("keydown", { key: name, code: `${name}Left`, [flag]: true });
      key("keydown", { key: name, code: `${name}Right`, [flag]: true });
      key("keyup", { key: name, code: `${name}Left`, [flag]: true });
    });
    expect(result.current[field]).toBe(true);

    act(() => key("keyup", { key: name, code: `${name}Right` }));
    expect(result.current[field]).toBe(false);
  });

  it("syncs from ordinary key events after a missed modifier event", () => {
    const { result } = renderHook(() => useModifierKeys());

    act(() => key("keydown", { key: "k", metaKey: true }));
    expect(result.current.meta).toBe(true);

    act(() => key("keyup", { key: "k" }));
    expect(result.current.meta).toBe(false);
  });

  it("keeps the same state object when flags do not change", () => {
    const { result } = renderHook(() => useModifierKeys());

    act(() => key("keydown", { key: "Meta", metaKey: true }));
    const first = result.current;
    act(() => key("keydown", { key: "Meta", metaKey: true, repeat: true }));
    expect(result.current).toBe(first);
  });

  it("resets modifiers on window blur", () => {
    const { result } = renderHook(() => useModifierKeys());

    act(() => key("keydown", { key: "Alt", metaKey: true, altKey: true }));
    expect(result.current).toEqual({ meta: true, alt: true });

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current).toEqual({ meta: false, alt: false });
  });

  it("resets modifiers on visibilitychange when the document hides — issue #7303", () => {
    const { result } = renderHook(() => useModifierKeys());

    act(() => key("keydown", { key: "Alt", metaKey: true, altKey: true }));
    expect(result.current).toEqual({ meta: true, alt: true });

    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toEqual({ meta: false, alt: false });
  });

  it("does not reset modifiers on visibilitychange when document is still visible", () => {
    const { result } = renderHook(() => useModifierKeys());

    act(() => key("keydown", { key: "Meta", metaKey: true }));
    expect(result.current.meta).toBe(true);

    act(() => {
      setHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.meta).toBe(true);
  });
});
