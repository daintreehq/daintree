// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeAndAnnounce, restoreFocusTo } from "../accessibility";
import {
  useAnnouncerStore,
  _resetAnnouncerDeliveryForTests,
} from "@/store/accessibilityAnnouncerStore";

interface DocumentWithAriaNotify extends Document {
  ariaNotify?: (message: string, options?: { priority?: "normal" | "high" }) => void;
}

describe("closeAndAnnounce", () => {
  let ariaNotifyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    _resetAnnouncerDeliveryForTests();
    ariaNotifyMock = vi.fn();
    (document as DocumentWithAriaNotify).ariaNotify =
      ariaNotifyMock as unknown as DocumentWithAriaNotify["ariaNotify"];
  });

  afterEach(() => {
    delete (document as DocumentWithAriaNotify).ariaNotify;
  });

  it("closes before announcing so focus returns to the main tree first", () => {
    const calls: string[] = [];
    const closeFn = vi.fn(() => calls.push("close"));
    ariaNotifyMock.mockImplementation(() => calls.push("announce"));

    closeAndAnnounce(closeFn, "Terminal killed");

    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(ariaNotifyMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["close", "announce"]);
  });

  it("forwards a polite priority as ariaNotify 'normal'", () => {
    closeAndAnnounce(() => {}, "Saved", "polite");
    expect(ariaNotifyMock).toHaveBeenCalledWith("Saved", { priority: "normal" });
  });

  it("forwards an assertive priority as ariaNotify 'high'", () => {
    closeAndAnnounce(() => {}, "Failure", "assertive");
    expect(ariaNotifyMock).toHaveBeenCalledWith("Failure", { priority: "high" });
  });

  it("defaults to polite ('normal') when priority is omitted", () => {
    closeAndAnnounce(() => {}, "Closed");
    expect(ariaNotifyMock).toHaveBeenCalledWith("Closed", { priority: "normal" });
  });

  it("forwards an empty message unchanged", () => {
    closeAndAnnounce(() => {}, "");
    expect(ariaNotifyMock).toHaveBeenCalledWith("", { priority: "normal" });
  });

  it("does not announce when closeFn throws", () => {
    const boom = vi.fn(() => {
      throw new Error("close failed");
    });
    expect(() => closeAndAnnounce(boom, "Should not fire")).toThrow("close failed");
    expect(ariaNotifyMock).not.toHaveBeenCalled();
  });

  it("routes through the store DOM fallback when ariaNotify is unavailable", () => {
    delete (document as DocumentWithAriaNotify).ariaNotify;
    closeAndAnnounce(() => {}, "Trashed all sessions");
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Trashed all sessions");
  });

  it("closes before mutating the store on the DOM fallback path too", () => {
    delete (document as DocumentWithAriaNotify).ariaNotify;
    let storeWasEmptyAtCloseTime = false;
    const closeFn = vi.fn(() => {
      storeWasEmptyAtCloseTime = useAnnouncerStore.getState().polite === null;
    });

    closeAndAnnounce(closeFn, "Terminal killed");

    // The store must still be empty at the moment closeFn ran — the
    // announcement is only written after the modal closes.
    expect(storeWasEmptyAtCloseTime).toBe(true);
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Terminal killed");
  });
});

describe("restoreFocusTo", () => {
  let root: HTMLElement;

  function addButton(label: string, parent: HTMLElement = document.body): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = label;
    parent.appendChild(button);
    return button;
  }

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses the first candidate when it is still connected", () => {
    const first = addButton("first");
    const second = addButton("second");

    restoreFocusTo(first, second);

    expect(document.activeElement).toBe(first);
  });

  it("falls through to the next candidate when the first was unmounted", () => {
    const removed = addButton("removed");
    const successor = addButton("successor");
    removed.remove();

    restoreFocusTo(removed, successor);

    expect(document.activeElement).toBe(successor);
  });

  it("skips null and body candidates without consuming the chain", () => {
    const successor = addButton("successor");

    restoreFocusTo(null, document.body, undefined, successor);

    expect(document.activeElement).toBe(successor);
  });

  // Being connected isn't enough to accept focus — .focus() on a disabled
  // element is a silent no-op, which would otherwise drop focus to <body>.
  it("falls through a connected candidate that refuses focus", () => {
    const disabled = addButton("disabled");
    disabled.disabled = true;
    const successor = addButton("successor");

    restoreFocusTo(disabled, successor);

    expect(document.activeElement).toBe(successor);
  });

  it("falls back to the app shell when every candidate refuses focus", () => {
    const shellButton = addButton("shell", root);
    const disabled = addButton("disabled");
    disabled.disabled = true;

    restoreFocusTo(disabled);

    expect(document.activeElement).toBe(shellButton);
  });

  it("stops at the first accepting candidate without touching later ones", () => {
    const accepting = addButton("accepting");
    const successor = addButton("successor");

    restoreFocusTo(accepting, successor);

    expect(document.activeElement).toBe(accepting);
  });

  // Focus falling to <body> strands keyboard users with nothing to tab from.
  it("falls back to the app shell's first tabbable element when no candidate survives", () => {
    const shellButton = addButton("shell", root);
    const removed = addButton("removed");
    removed.remove();

    restoreFocusTo(removed, null);

    expect(document.activeElement).toBe(shellButton);
  });

  // Degrades rather than throwing when the app shell isn't mounted.
  it("does nothing when no candidate survives and nothing is tabbable", () => {
    const removed = addButton("removed");
    removed.remove();
    root.remove();

    expect(() => restoreFocusTo(removed)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});
