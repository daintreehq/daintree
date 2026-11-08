// @vitest-environment jsdom
import { useRef } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { useFleetPendingConfirm, FLEET_CONFIRM_TTL_MS } from "../useFleetPendingConfirm";
import {
  useFleetPendingActionStore,
  type FleetPendingActionSnapshot,
} from "@/store/fleetPendingActionStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { actionService } from "@/services/ActionService";
import { _resetForTests as resetEscapeStack, dispatchEscape } from "@/lib/escapeStack";

function Harness() {
  const pending = useFleetPendingActionStore((s) => s.pending);
  const bannerRef = useRef<HTMLDivElement>(null);
  const { confirm, cancel } = useFleetPendingConfirm(pending, bannerRef);
  if (pending === null) return null;
  return (
    <div ref={bannerRef} data-testid="banner">
      <button type="button" onClick={cancel}>
        Cancel restart
      </button>
      <button type="button" onClick={confirm}>
        Restart agents
      </button>
    </div>
  );
}

function request(snapshot?: Partial<FleetPendingActionSnapshot>): FleetPendingActionSnapshot {
  const next = { kind: "restart" as const, targetCount: 3, sessionLossCount: 0, ...snapshot };
  act(() => {
    useFleetPendingActionStore.getState().request(next);
  });
  return next;
}

function pending(): FleetPendingActionSnapshot | null {
  return useFleetPendingActionStore.getState().pending;
}

function announced(): string | undefined {
  return useAnnouncerStore.getState().polite?.msg;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useFleetPendingConfirm", () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;
  let mounted: HTMLElement[];
  let terminal: HTMLTextAreaElement;
  let editor: HTMLElement;
  let paneKeys: string[];

  function mount(html: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    mounted.push(host);
    return host;
  }

  function restartDispatches(): unknown[][] {
    return dispatchSpy.mock.calls.filter((c: unknown[]) => c[0] === "fleet.restart");
  }

  beforeEach(() => {
    useFleetPendingActionStore.setState({ pending: null });
    useAnnouncerStore.setState({ polite: null, assertive: null });
    resetEscapeStack();
    dispatchSpy = vi.spyOn(actionService, "dispatch");
    mounted = [];
    const pane = mount(
      '<div data-panel-id="a"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>' +
        '<div data-hybrid-input-root><div contenteditable="true" data-hybrid-input-editor="true"></div></div></div>'
    );
    terminal = pane.querySelector("textarea")!;
    editor = pane.querySelector<HTMLElement>("[data-hybrid-input-editor]")!;
    paneKeys = [];
    pane.addEventListener("keydown", (e) => paneKeys.push(e.key));
  });

  afterEach(() => {
    // Releases any held-key swallowing a test left behind.
    fireEvent.blur(window);
    for (const el of mounted) el.remove();
    dispatchSpy.mockRestore();
    vi.useRealTimers();
  });

  describe("keys from a terminal", () => {
    it("confirms from the prompt editor, clearing before it dispatches", () => {
      render(<Harness />);
      request();
      const cleared = vi.fn();
      const unsubscribe = useFleetPendingActionStore.subscribe((s) => {
        if (s.pending === null) cleared();
      });

      expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(false);
      unsubscribe();

      expect(paneKeys).toEqual([]);
      expect(restartDispatches()).toEqual([
        ["fleet.restart", { confirmed: true }, { source: "keybinding" }],
      ]);
      expect(cleared.mock.invocationCallOrder[0]).toBeLessThan(
        dispatchSpy.mock.invocationCallOrder[0]!
      );
      expect(announced()).toBeUndefined();
      // With the confirm answered, the next Enter is the editor's again.
      fireEvent.keyUp(editor, { key: "Enter" });
      expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(true);
      expect(paneKeys).toEqual(["Enter"]);
    });

    it.each(["Enter", "Escape"])(
      "keeps a held %s's repeats from the terminal until it comes up",
      (key) => {
        render(<Harness />);
        request();

        fireEvent.keyDown(terminal, { key });
        expect(fireEvent.keyDown(terminal, { key, repeat: true })).toBe(false);
        expect(fireEvent.keyDown(terminal, { key, repeat: true })).toBe(false);
        expect(paneKeys).toEqual([]);

        fireEvent.keyUp(terminal, { key });
        expect(fireEvent.keyDown(terminal, { key })).toBe(true);
        expect(paneKeys).toEqual([key]);
        expect(restartDispatches().length).toBe(key === "Enter" ? 1 : 0);
      }
    );

    it.each(["Enter", "Escape"])(
      "takes a repeating %s from the terminal without answering",
      (key) => {
        render(<Harness />);
        request();

        expect(fireEvent.keyDown(terminal, { key, repeat: true })).toBe(false);

        expect(paneKeys).toEqual([]);
        expect(restartDispatches()).toEqual([]);
        expect(pending()).not.toBeNull();
      }
    );

    it.each([
      { name: "Shift+Enter", init: { key: "Enter", shiftKey: true } },
      { name: "Alt+Enter", init: { key: "Enter", altKey: true } },
      { name: "Ctrl+Enter", init: { key: "Enter", ctrlKey: true } },
      { name: "Cmd+Enter", init: { key: "Enter", metaKey: true } },
      { name: "an IME's Enter", init: { key: "Enter", isComposing: true } },
      { name: "an IME's Process Enter", init: { key: "Enter", keyCode: 229 } },
      { name: "typing", init: { key: "y" } },
      { name: "Ctrl+C", init: { key: "c", ctrlKey: true } },
      { name: "a Cmd shortcut", init: { key: "k", metaKey: true } },
      { name: "Tab", init: { key: "Tab" } },
    ])("passes $name through to the terminal and drops the confirm", ({ init }) => {
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(terminal, init)).toBe(true);

      expect(paneKeys).toEqual([init.key]);
      expect(restartDispatches()).toEqual([]);
      expect(pending()).toBeNull();
      expect(announced()).toBeUndefined();
    });

    it.each([
      { name: "a modifier on its own", init: { key: "Shift", shiftKey: true } },
      {
        name: "the held chord that asked",
        init: { key: "R", metaKey: true, shiftKey: true, repeat: true },
      },
      { name: "Shift+Escape", init: { key: "Escape", shiftKey: true } },
      { name: "an IME's Escape", init: { key: "Escape", isComposing: true } },
    ])("passes $name through and keeps the confirm", ({ init }) => {
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(terminal, init)).toBe(true);

      expect(paneKeys).toEqual([init.key]);
      expect(pending()).not.toBeNull();
    });

    it("cancels on Escape without a word", () => {
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(terminal, { key: "Escape" })).toBe(false);

      expect(paneKeys).toEqual([]);
      expect(pending()).toBeNull();
      expect(announced()).toBeUndefined();
    });

    it("leaves Enter and Escape to a modal open over the terminal", () => {
      const modal = mount(
        '<div role="dialog" aria-modal="true"><div class="xterm"><textarea></textarea></div></div>'
      );
      const inModal = modal.querySelector("textarea")!;
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(inModal, { key: "Escape" })).toBe(true);
      expect(pending()).not.toBeNull();
      expect(fireEvent.keyDown(inModal, { key: "Enter" })).toBe(true);

      expect(restartDispatches()).toEqual([]);
      expect(pending()).toBeNull();
    });
  });

  describe("keys elsewhere", () => {
    it("leaves Enter in an isolated surface's terminal to it", () => {
      const isolated = mount(
        '<div data-keybindings-isolated=""><div class="xterm"><textarea></textarea></div></div>'
      );
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(isolated.querySelector("textarea")!, { key: "Enter" })).toBe(true);

      expect(restartDispatches()).toEqual([]);
      expect(pending()).toBeNull();
    });

    it.each([
      { name: "a field", html: '<input type="text" />', selector: "input" },
      { name: "a link", html: '<a href="#x">Docs</a>', selector: "a" },
      {
        name: "a disclosure",
        html: "<details><summary>More</summary></details>",
        selector: "summary",
      },
      {
        name: "a time picker's segment",
        html: '<span role="spinbutton" tabindex="0">09</span>',
        selector: "span",
      },
      {
        name: "a listbox option",
        html: '<div role="option" tabindex="0">One</div>',
        selector: "div",
      },
    ])("leaves Enter on $name to it and drops the confirm", ({ html, selector }) => {
      const el = mount(html).querySelector<HTMLElement>(selector)!;
      const seen = vi.fn();
      el.addEventListener("keydown", seen);
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(el, { key: "Enter" })).toBe(true);

      expect(seen).toHaveBeenCalledTimes(1);
      expect(restartDispatches()).toEqual([]);
      expect(pending()).toBeNull();
    });

    it("confirms on Enter from the page", () => {
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(document.body, { key: "Enter" })).toBe(false);

      expect(restartDispatches()).toEqual([
        ["fleet.restart", { confirmed: true }, { source: "keybinding" }],
      ]);
    });

    it("lets Tab through toward its buttons and keeps the confirm", () => {
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(document.body, { key: "Tab" })).toBe(true);
      expect(fireEvent.keyDown(screen.getByText("Cancel restart"), { key: "Tab" })).toBe(true);

      expect(pending()).not.toBeNull();
    });

    it("leaves Enter and Space on its own buttons to them", () => {
      render(<Harness />);
      request();
      const cancel = screen.getByText("Cancel restart");

      expect(fireEvent.keyDown(cancel, { key: "Enter" })).toBe(true);
      expect(fireEvent.keyDown(cancel, { key: " " })).toBe(true);

      expect(restartDispatches()).toEqual([]);
      expect(pending()).not.toBeNull();
    });

    it("cancels through the escape stack, then gives up its entry", () => {
      render(<Harness />);
      request();

      let handled = false;
      act(() => {
        handled = dispatchEscape();
      });

      expect(handled).toBe(true);
      expect(pending()).toBeNull();
      expect(dispatchEscape()).toBe(false);
    });
  });

  describe("pointer", () => {
    it("confirms once from its button", () => {
      render(<Harness />);
      request();
      const button = screen.getByText("Restart agents");

      fireEvent.pointerDown(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(restartDispatches()).toEqual([
        ["fleet.restart", { confirmed: true }, { source: "user" }],
      ]);
      expect(pending()).toBeNull();
    });

    it("cancels from its button, not from the press on it", () => {
      render(<Harness />);
      const asked = request();
      const button = screen.getByText("Cancel restart");

      fireEvent.pointerDown(button);
      expect(pending()).toBe(asked);
      fireEvent.click(button);

      expect(restartDispatches()).toEqual([]);
      expect(pending()).toBeNull();
    });

    it("drops the confirm on a press anywhere else, leaving the press alone", () => {
      const seen = vi.fn();
      terminal.addEventListener("pointerdown", seen);
      render(<Harness />);
      request();

      expect(fireEvent.pointerDown(terminal)).toBe(true);

      expect(seen).toHaveBeenCalledTimes(1);
      expect(pending()).toBeNull();
    });
  });

  describe("lifetime", () => {
    it("drops the confirm when the window loses focus", () => {
      render(<Harness />);
      request();

      fireEvent.blur(window);

      expect(pending()).toBeNull();
    });

    it("keeps the confirm through focus moving on its own", () => {
      const other = mount('<input type="text" />').querySelector("input")!;
      render(<Harness />);
      request();

      terminal.focus();
      other.focus();

      expect(document.activeElement).toBe(other);
      expect(pending()).not.toBeNull();
    });

    it("lapses unanswered and says so", () => {
      vi.useFakeTimers();
      render(<Harness />);
      request();

      advance(FLEET_CONFIRM_TTL_MS - 1);
      expect(pending()).not.toBeNull();
      advance(1);

      expect(pending()).toBeNull();
      expect(announced()).toBe("Restart confirmation expired");
    });

    it("gives a replacement its own full lifetime", () => {
      vi.useFakeTimers();
      render(<Harness />);
      request();
      advance(FLEET_CONFIRM_TTL_MS - 1000);

      const replacement = request();
      advance(1000);
      expect(pending()).toBe(replacement);

      advance(FLEET_CONFIRM_TTL_MS - 1000);
      expect(pending()).toBeNull();
    });

    it.each([
      {
        name: "Enter",
        answer: (terminalEl: HTMLElement) => fireEvent.keyDown(terminalEl, { key: "Enter" }),
      },
      {
        name: "its button",
        answer: () => fireEvent.click(screen.getByText("Restart agents")),
      },
    ])("won't confirm by $name past its deadline when the timer was held back", ({ answer }) => {
      vi.useFakeTimers();
      render(<Harness />);
      request();

      vi.setSystemTime(Date.now() + FLEET_CONFIRM_TTL_MS);
      expect(pending()).not.toBeNull();
      answer(terminal);

      expect(restartDispatches()).toEqual([]);
      expect(pending()).toBeNull();
      expect(announced()).toBe("Restart confirmation expired");
    });

    it("lets go of the keyboard once the confirm is gone", () => {
      render(<Harness />);
      request();
      act(() => {
        useFleetPendingActionStore.getState().clear();
      });

      expect(fireEvent.keyDown(terminal, { key: "Enter" })).toBe(true);
      expect(paneKeys).toEqual(["Enter"]);
    });

    it("lets go of the keyboard, the pointer, the window and its timer on unmount", () => {
      vi.useFakeTimers();
      const { unmount } = render(<Harness />);
      const asked = request();
      unmount();

      expect(fireEvent.keyDown(terminal, { key: "Enter" })).toBe(true);
      fireEvent.pointerDown(terminal);
      fireEvent.blur(window);
      advance(FLEET_CONFIRM_TTL_MS);

      expect(pending()).toBe(asked);
      expect(restartDispatches()).toEqual([]);
    });
  });
});
