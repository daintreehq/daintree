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
  act(() => useFleetPendingActionStore.getState().request(next));
  return next;
}

function pending(): FleetPendingActionSnapshot | null {
  return useFleetPendingActionStore.getState().pending;
}

function restartDispatches(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter((c: unknown[]) => c[0] === "fleet.restart");
}

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe("useFleetPendingConfirm", () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;
  let host: HTMLElement;
  let terminal: HTMLTextAreaElement;
  let terminalKeys: string[];

  beforeEach(() => {
    useFleetPendingActionStore.setState({ pending: null });
    useAnnouncerStore.setState({ polite: null, assertive: null });
    resetEscapeStack();
    dispatchSpy = vi.spyOn(actionService, "dispatch");
    host = mount(
      '<div data-panel-id="a"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>' +
        '<div data-hybrid-input-root><div contenteditable="true" data-hybrid-input-editor="true"></div></div></div>'
    );
    terminal = host.querySelector("textarea")!;
    terminalKeys = [];
    host.addEventListener("keydown", (e) => terminalKeys.push(e.key));
  });

  afterEach(() => {
    host.remove();
    dispatchSpy.mockRestore();
    vi.useRealTimers();
  });

  describe("keys from a terminal", () => {
    it("confirms once from the prompt editor and keeps the Enter from it", () => {
      render(<Harness />);
      request();
      const editor = host.querySelector<HTMLElement>("[data-hybrid-input-editor]")!;

      expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(false);
      expect(terminalKeys).toEqual([]);
      // With the confirm answered, the next Enter is the editor's again.
      expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(true);

      expect(terminalKeys).toEqual(["Enter"]);
      expect(restartDispatches(dispatchSpy)).toEqual([
        ["fleet.restart", { confirmed: true }, { source: "keybinding" }],
      ]);
      expect(pending()).toBeNull();
    });

    it("takes a held Enter's repeat from the terminal without confirming", () => {
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(terminal, { key: "Enter", repeat: true })).toBe(false);

      expect(terminalKeys).toEqual([]);
      expect(restartDispatches(dispatchSpy)).toEqual([]);
      expect(pending()).not.toBeNull();
    });

    it.each([
      { name: "Shift+Enter", init: { key: "Enter", shiftKey: true } },
      { name: "an IME's Enter", init: { key: "Enter", isComposing: true } },
      { name: "typing", init: { key: "y" } },
      { name: "Tab", init: { key: "Tab" } },
    ])("passes $name through to the terminal and drops the confirm", ({ init }) => {
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(terminal, init)).toBe(true);

      expect(terminalKeys).toEqual([init.key]);
      expect(restartDispatches(dispatchSpy)).toEqual([]);
      expect(pending()).toBeNull();
    });

    it.each([
      { name: "a modifier on its own", init: { key: "Shift", shiftKey: true } },
      { name: "a Cmd shortcut", init: { key: "R", metaKey: true, shiftKey: true } },
      { name: "a Ctrl shortcut", init: { key: "k", ctrlKey: true } },
    ])("keeps the confirm through $name", ({ init }) => {
      render(<Harness />);
      request();

      fireEvent.keyDown(terminal, init);

      expect(pending()).not.toBeNull();
    });

    it("cancels on Escape and retires its escape-stack entry", () => {
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(terminal, { key: "Escape" })).toBe(false);

      expect(terminalKeys).toEqual([]);
      expect(pending()).toBeNull();
      expect(dispatchEscape()).toBe(false);
    });
  });

  describe("keys elsewhere", () => {
    it("leaves Enter in an isolated surface's editor to it", () => {
      const isolated = mount(
        '<div data-keybindings-isolated=""><div class="xterm"><textarea></textarea></div></div>'
      );
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(isolated.querySelector("textarea")!, { key: "Enter" })).toBe(true);

      expect(restartDispatches(dispatchSpy)).toEqual([]);
      expect(pending()).toBeNull();
      isolated.remove();
    });

    it("leaves Enter in a field to the field and drops the confirm", () => {
      const field = mount('<input type="text" />');
      render(<Harness />);
      request();

      expect(fireEvent.keyDown(field.querySelector("input")!, { key: "Enter" })).toBe(true);

      expect(restartDispatches(dispatchSpy)).toEqual([]);
      expect(pending()).toBeNull();
      field.remove();
    });

    it("keeps the confirm while Tab moves the keyboard toward its buttons", () => {
      render(<Harness />);
      request();

      fireEvent.keyDown(document.body, { key: "Tab" });
      fireEvent.keyDown(screen.getByText("Cancel restart"), { key: "Tab" });

      expect(pending()).not.toBeNull();
    });

    it("leaves Enter and Space on the banner's buttons to native activation", () => {
      render(<Harness />);
      request();
      const cancel = screen.getByText("Cancel restart");

      expect(fireEvent.keyDown(cancel, { key: "Enter" })).toBe(true);
      expect(fireEvent.keyDown(cancel, { key: " " })).toBe(true);

      expect(restartDispatches(dispatchSpy)).toEqual([]);
      expect(pending()).not.toBeNull();
    });
  });

  describe("pointer", () => {
    it("confirms once from the banner's button", () => {
      render(<Harness />);
      request();
      const button = screen.getByText("Restart agents");

      fireEvent.pointerDown(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(restartDispatches(dispatchSpy)).toEqual([
        ["fleet.restart", { confirmed: true }, { source: "user" }],
      ]);
      expect(pending()).toBeNull();
    });

    it("cancels from the banner's button", () => {
      render(<Harness />);
      request();
      const button = screen.getByText("Cancel restart");

      fireEvent.pointerDown(button);
      fireEvent.click(button);

      expect(restartDispatches(dispatchSpy)).toEqual([]);
      expect(pending()).toBeNull();
    });

    it("drops the confirm on a press anywhere else, leaving the press alone", () => {
      render(<Harness />);
      request();

      expect(fireEvent.pointerDown(terminal)).toBe(true);

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
      render(<Harness />);
      request();

      terminal.focus();
      document.body.focus();

      expect(pending()).not.toBeNull();
    });

    it("lapses unanswered and says so", () => {
      vi.useFakeTimers();
      render(<Harness />);
      request();

      act(() => vi.advanceTimersByTime(FLEET_CONFIRM_TTL_MS - 1));
      expect(pending()).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));

      expect(pending()).toBeNull();
      expect(useAnnouncerStore.getState().polite?.msg).toBe("Restart confirmation expired");
    });

    it("gives a replacement its own full lifetime", () => {
      vi.useFakeTimers();
      render(<Harness />);
      request();
      act(() => vi.advanceTimersByTime(FLEET_CONFIRM_TTL_MS - 1000));

      const replacement = request();
      act(() => vi.advanceTimersByTime(1000));
      expect(pending()).toBe(replacement);

      act(() => vi.advanceTimersByTime(FLEET_CONFIRM_TTL_MS - 1000));
      expect(pending()).toBeNull();
    });

    it("won't confirm past its deadline when the timer was held back", () => {
      vi.useFakeTimers();
      render(<Harness />);
      request();

      vi.setSystemTime(Date.now() + FLEET_CONFIRM_TTL_MS);
      expect(fireEvent.keyDown(terminal, { key: "Enter" })).toBe(false);

      expect(restartDispatches(dispatchSpy)).toEqual([]);
      expect(pending()).toBeNull();
      expect(useAnnouncerStore.getState().polite?.msg).toBe("Restart confirmation expired");
    });

    it("lets go of the keyboard once the confirm is gone", () => {
      const { unmount } = render(<Harness />);
      request();
      act(() => useFleetPendingActionStore.getState().clear());

      expect(fireEvent.keyDown(terminal, { key: "Enter" })).toBe(true);

      request();
      unmount();
      expect(fireEvent.keyDown(terminal, { key: "Enter" })).toBe(true);
      expect(terminalKeys).toEqual(["Enter", "Enter"]);
      expect(restartDispatches(dispatchSpy)).toEqual([]);
    });
  });
});
