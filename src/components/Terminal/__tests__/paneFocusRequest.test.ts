// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";
import { usePanelStore } from "@/store/panelStore";
import {
  _resetPaneFocusRequestsForTesting,
  captureFocusEpoch,
  holdPaneFocus,
  isFocusEpochCurrent,
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
  it("keeps a request nothing could take yet", () => {
    expect(requestPaneFocus("a", "hybridInput")).toBe(false);
    expect(requestedPaneSurface("a")).toBe("hybridInput");
    expect(pendingPaneSurface("a")).toBe("hybridInput");
  });

  it("lets a newer request supersede the older one and its deferred work", () => {
    requestPaneFocus("a", "hybridInput");
    const epoch = captureFocusEpoch();

    requestPaneFocus("a", "xterm");

    expect(requestedPaneSurface("a")).toBe("xterm");
    expect(isFocusEpochCurrent(epoch)).toBe(false);
  });

  it("ends the request and supersedes deferred work on a press anywhere", () => {
    requestPaneFocus("a", "hybridInput");
    const epoch = captureFocusEpoch();
    expect(isFocusEpochCurrent(epoch)).toBe(true);

    press();

    expect(requestedPaneSurface("a")).toBeNull();
    expect(isFocusEpochCurrent(epoch)).toBe(false);
  });

  // Deferred work scheduled after the press belongs to the new epoch: the
  // press that selects a pane must not cancel the focus it leads to.
  it("lets work scheduled after a press stand", () => {
    press();
    const epoch = captureFocusEpoch();
    expect(isFocusEpochCurrent(epoch)).toBe(true);
  });

  it("survives the selection landing on its own pane and ends when it moves on", () => {
    usePanelStore.setState({ focusedId: "other" });
    requestPaneFocus("a", "hybridInput");

    usePanelStore.setState({ focusedId: "a" });
    expect(requestedPaneSurface("a")).toBe("hybridInput");

    usePanelStore.setState({ focusedId: "b" });
    expect(requestedPaneSurface("a")).toBeNull();

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
    ])("ends when focus lands on %s", (_, target) => {
      const pane = mountPane("a");
      const elsewhere = target(pane);
      requestPaneFocus("a", "hybridInput");

      elsewhere.focus();

      expect(requestedPaneSurface("a")).toBeNull();
    });
  });

  describe("what a pane settled on when it arrived", () => {
    it("is pending for a hybrid input that mounts late, but outranks nothing", () => {
      holdPaneFocus("a", "hybridInput");

      expect(pendingPaneSurface("a")).toBe("hybridInput");
      expect(requestedPaneSurface("a")).toBeNull();
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

  it("leaves an epoch captured before a reset stale", () => {
    const epoch = captureFocusEpoch();
    _resetPaneFocusRequestsForTesting();
    expect(isFocusEpochCurrent(epoch)).toBe(false);
  });
});
