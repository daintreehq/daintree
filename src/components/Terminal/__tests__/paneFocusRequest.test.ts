// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";
import { usePanelStore } from "@/store/panelStore";
import {
  _resetPaneFocusRequestsForTesting,
  captureFocusEpoch,
  holdPaneFocus,
  isFocusEpochCurrent,
  paneSurfaceHoldingFocus,
  pendingPaneSurface,
  requestPaneFocus,
  requestedPaneSurface,
} from "../paneFocusRequest";

/** A pane as the DOM shows it: its root, terminal, hybrid input and notes. */
function mountPane(id: string) {
  const root = document.createElement("div");
  root.setAttribute("data-panel-id", id);
  root.innerHTML = `
    <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
    <div data-hybrid-input-root="${id}"><div contenteditable="true" tabindex="0"></div></div>
    <textarea data-scratchpad></textarea>
    <button>Restart</button>`;
  document.body.appendChild(root);
  return {
    xterm: root.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!,
    editor: root.querySelector<HTMLElement>("[contenteditable]")!,
    notes: root.querySelector<HTMLTextAreaElement>("[data-scratchpad]")!,
    button: root.querySelector<HTMLButtonElement>("button")!,
  };
}

function press(target: EventTarget = document.body) {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

describe("paneFocusRequest", () => {
  beforeEach(() => {
    usePanelStore.setState({ focusedId: "a" });
  });

  afterEach(() => {
    _resetPaneFocusRequestsForTesting();
    document.body.innerHTML = "";
  });

  it("asks the pane for the named surface and reports whether it landed", () => {
    const handler = vi.fn((_surface?: string) => true);
    const cleanup = registerPanelFocusHandler("a", handler);

    expect(requestPaneFocus("a", "hybridInput")).toBe(true);
    expect(handler).toHaveBeenCalledExactlyOnceWith("hybridInput");
    expect(requestedPaneSurface("a")).toBe("hybridInput");
    expect(requestedPaneSurface("b")).toBeNull();

    cleanup();
  });

  // A pane that isn't mounted, or a hybrid input still loading, keeps the
  // request for when it can take it.
  it.each([
    ["no pane is mounted", null],
    ["the pane's surface isn't ready", () => false],
  ])("keeps a request nothing could take yet: %s", (_, handler) => {
    const cleanup = handler ? registerPanelFocusHandler("a", handler) : () => {};

    expect(requestPaneFocus("a", "hybridInput")).toBe(false);
    expect(requestedPaneSurface("a")).toBe("hybridInput");
    expect(pendingPaneSurface("a")).toBe("hybridInput");

    cleanup();
  });

  // The same pane and surface asked again still calls off the first ask's
  // frames: the newer one schedules its own.
  it("lets a newer request supersede the older one's deferred work", () => {
    requestPaneFocus("a", "hybridInput");
    const epoch = captureFocusEpoch();

    requestPaneFocus("a", "hybridInput");

    expect(requestedPaneSurface("a")).toBe("hybridInput");
    expect(isFocusEpochCurrent(epoch)).toBe(false);
  });

  it("hands the request over to a newer one for another surface", () => {
    requestPaneFocus("a", "hybridInput");
    requestPaneFocus("a", "xterm");
    expect(requestedPaneSurface("a")).toBe("xterm");
  });

  it("ends the request and supersedes deferred work on a press anywhere", () => {
    requestPaneFocus("a", "hybridInput");
    const epoch = captureFocusEpoch();
    expect(isFocusEpochCurrent(epoch)).toBe(true);

    press();

    expect(requestedPaneSurface("a")).toBeNull();
    expect(isFocusEpochCurrent(epoch)).toBe(false);
  });

  // Counted in the capture phase, before any handler the press reaches: the
  // press that selects a pane must not cancel the focus it leads to.
  it("lets work a press's own handlers schedule stand", () => {
    const before = captureFocusEpoch();
    const target = document.createElement("div");
    document.body.appendChild(target);
    let during = -1;
    target.addEventListener("pointerdown", () => {
      during = captureFocusEpoch();
    });

    press(target);

    expect(isFocusEpochCurrent(before)).toBe(false);
    expect(isFocusEpochCurrent(during)).toBe(true);
  });

  it("survives the selection landing on its own pane and ends when it moves on", () => {
    usePanelStore.setState({ focusedId: "other" });
    requestPaneFocus("a", "hybridInput");

    usePanelStore.setState({ focusedId: "a" });
    expect(requestedPaneSurface("a")).toBe("hybridInput");
    const epoch = captureFocusEpoch();

    usePanelStore.setState({ focusedId: "b" });
    expect(requestedPaneSurface("a")).toBeNull();
    // The pane it left calls off its own frames; a reconcile after a panel
    // closes mustn't call off unrelated work like the assistant's reveal.
    expect(isFocusEpochCurrent(epoch)).toBe(true);

    // Coming back is a fresh arrival, not the old request revived.
    usePanelStore.setState({ focusedId: "a" });
    expect(requestedPaneSurface("a")).toBeNull();
  });

  describe("focus moving on", () => {
    it("survives focus landing on the surface it asked for", () => {
      const pane = mountPane("a");
      requestPaneFocus("a", "hybridInput");
      pane.editor.focus();
      expect(requestedPaneSurface("a")).toBe("hybridInput");

      requestPaneFocus("a", "xterm");
      pane.xterm.focus();
      expect(requestedPaneSurface("a")).toBe("xterm");
    });

    // A container, a button or the dock popover's content taking focus on the
    // way to the pane is not the user going somewhere else.
    it("survives focus landing on something that takes no typing", () => {
      const pane = mountPane("a");
      requestPaneFocus("a", "hybridInput");
      pane.button.focus();
      expect(requestedPaneSurface("a")).toBe("hybridInput");
    });

    it.each([
      ["the pane's own terminal", (pane: ReturnType<typeof mountPane>) => pane.xterm],
      ["the pane's Scratchpad", (pane: ReturnType<typeof mountPane>) => pane.notes],
      ["another pane's hybrid input", () => mountPane("b").editor],
    ])("ends when focus lands on %s, with the grabs scheduled for it", (_, target) => {
      const pane = mountPane("a");
      const elsewhere = target(pane);
      requestPaneFocus("a", "hybridInput");
      const epoch = captureFocusEpoch();

      elsewhere.focus();

      expect(requestedPaneSurface("a")).toBeNull();
      expect(isFocusEpochCurrent(epoch)).toBe(false);
    });

    it("ends a terminal request when another pane's terminal takes focus", () => {
      mountPane("a");
      const other = mountPane("b");
      requestPaneFocus("a", "xterm");

      other.xterm.focus();

      expect(requestedPaneSurface("a")).toBeNull();
    });
  });

  describe("what a pane settled on when it arrived", () => {
    it("is pending for a hybrid input that mounts late, but outranks nothing", () => {
      holdPaneFocus("a", "hybridInput");

      expect(pendingPaneSurface("a")).toBe("hybridInput");
      expect(pendingPaneSurface("b")).toBeNull();
      expect(requestedPaneSurface("a")).toBeNull();
    });

    it("replaces a request for another pane", () => {
      requestPaneFocus("a", "hybridInput");
      holdPaneFocus("b", "xterm");

      expect(requestedPaneSurface("a")).toBeNull();
      expect(pendingPaneSurface("b")).toBe("xterm");
    });

    it("never replaces an explicit request for the same pane", () => {
      requestPaneFocus("a", "hybridInput");
      holdPaneFocus("a", "xterm");

      expect(requestedPaneSurface("a")).toBe("hybridInput");
      expect(pendingPaneSurface("a")).toBe("hybridInput");
    });

    it("supersedes no deferred work", () => {
      const epoch = captureFocusEpoch();
      holdPaneFocus("a", "hybridInput");
      expect(isFocusEpochCurrent(epoch)).toBe(true);
    });

    it("ends on a press like a request does", () => {
      holdPaneFocus("a", "hybridInput");
      press();
      expect(pendingPaneSurface("a")).toBeNull();
    });
  });

  describe("which surface holds the keyboard", () => {
    it("names the pane's own surface, and only that pane's", () => {
      const a = mountPane("a");
      mountPane("b");

      a.editor.focus();
      expect(paneSurfaceHoldingFocus("a")).toBe("hybridInput");
      expect(paneSurfaceHoldingFocus("b")).toBeNull();

      a.xterm.focus();
      expect(paneSurfaceHoldingFocus("a")).toBe("xterm");
      expect(paneSurfaceHoldingFocus("b")).toBeNull();
    });

    it("counts neither the notes nor the pane's other controls", () => {
      const a = mountPane("a");

      a.notes.focus();
      expect(paneSurfaceHoldingFocus("a")).toBeNull();
      a.button.focus();
      expect(paneSurfaceHoldingFocus("a")).toBeNull();
    });
  });

  it("leaves an epoch captured before a reset stale", () => {
    const epoch = captureFocusEpoch();
    _resetPaneFocusRequestsForTesting();
    expect(isFocusEpochCurrent(epoch)).toBe(false);
  });
});
