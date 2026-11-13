// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { _resetForTests, registerEscape } from "@/lib/escapeStack";
import { nestedLayerOwnsEscape, _resetForTests as resetOwnedEscape } from "@/lib/pluginManagerEscape";
import { useGlobalEscapeDispatcher } from "../useGlobalEscapeDispatcher";

function Host() {
  useGlobalEscapeDispatcher();
  return null;
}

describe("useGlobalEscapeDispatcher — layers open inside the plugin manager (#16942)", () => {
  let listbox: HTMLElement;

  beforeEach(() => {
    _resetForTests();
    resetOwnedEscape();
    const manager = document.createElement("div");
    manager.setAttribute("data-plugin-manager-open", "");
    listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    listbox.setAttribute("data-state", "open");
    document.body.append(manager, listbox);
  });

  afterEach(() => document.body.replaceChildren());

  function pressEscape(onCapture?: (event: KeyboardEvent) => void) {
    const capture = (event: KeyboardEvent) => onCapture?.(event);
    window.addEventListener("keydown", capture, true);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    try {
      act(() => {
        listbox.dispatchEvent(event);
      });
    } finally {
      window.removeEventListener("keydown", capture, true);
    }
    return event;
  }

  it("leaves the manager on the stack when an open layer had the key", () => {
    const closeManager = vi.fn();
    registerEscape(closeManager);
    render(<Host />);

    pressEscape();

    expect(closeManager).not.toHaveBeenCalled();
  });

  it("holds to the capture-phase call after the layer has closed during the event", () => {
    const closeManager = vi.fn();
    registerEscape(closeManager);
    render(<Host />);

    pressEscape((event) => {
      expect(nestedLayerOwnsEscape(event)).toBe(true);
      listbox.setAttribute("data-state", "closed");
    });

    expect(closeManager).not.toHaveBeenCalled();
  });

  it("closes the manager when nothing is open over it", () => {
    listbox.setAttribute("data-state", "closed");
    const closeManager = vi.fn();
    registerEscape(closeManager);
    render(<Host />);

    const event = pressEscape();

    expect(closeManager).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
