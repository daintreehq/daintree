// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingHostSwitch } from "@shared/types/ipc/remoteHosts";

const m = vi.hoisted(() => ({
  switchToHost: vi.fn(async () => {}),
  cancelPendingSwitch: vi.fn(async () => true),
}));
vi.mock("@/components/Hosts/hostSwitching", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/hostSwitching")>()),
  switchToHost: m.switchToHost,
}));

import { _resetForTests, dispatchEscape, registerEscape } from "@/lib/escapeStack";
import { HostSwitchScreen } from "../HostSwitchScreen";

function pending(overrides: Partial<PendingHostSwitch> = {}): PendingHostSwitch {
  return {
    switchId: "sw-1",
    hostId: "studio-02",
    hostName: "studio-02",
    projectName: null,
    phase: "connecting",
    ...overrides,
  };
}

function screen(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="host-switch-screen"]');
  if (!element) throw new Error("no switch screen");
  return element;
}

function button(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label) ??
    null
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  m.switchToHost.mockClear();
  m.cancelPendingSwitch.mockClear();
  Reflect.set(window, "electron", {
    remoteHosts: { cancelPendingSwitch: m.cancelPendingSwitch },
  });
});

afterEach(() => {
  cleanup();
  _resetForTests();
  vi.useRealTimers();
});

describe("HostSwitchScreen", () => {
  it("shows where the window is going at once while the link comes up, and Cancel goes back", () => {
    render(<HostSwitchScreen pending={pending()} />);
    expect(screen().className).not.toContain("opacity-0");
    expect(screen().textContent).toContain("Switching to studio-02");
    expect(screen().textContent).toContain("Connecting…");
    expect(document.activeElement).toBe(button("Cancel"));

    fireEvent.click(button("Cancel")!);
    expect(m.cancelPendingSwitch).toHaveBeenCalledWith({ switchId: "sw-1" });

    // Escape and Cmd/Ctrl+W both reach the escape stack, where the screen is on top.
    expect(dispatchEscape()).toBe(true);
    expect(m.cancelPendingSwitch).toHaveBeenCalledTimes(2);
  });

  it("lets a palette opened over it close first, and keeps the focus that palette took", () => {
    const { rerender } = render(<HostSwitchScreen pending={pending()} />);
    const closePalette = vi.fn();
    const palette = registerEscape(closePalette);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    rerender(
      <HostSwitchScreen
        pending={pending({
          phase: "failed",
          failure: { code: "HOST_DISCONNECTED", message: "down" },
        })}
      />
    );
    expect(document.activeElement).toBe(input);
    dispatchEscape();
    expect(closePalette).toHaveBeenCalled();
    expect(m.cancelPendingSwitch).not.toHaveBeenCalled();
    palette.unregister();
    input.remove();
  });

  it("lets a dialog already open when the switch began close first", () => {
    const closeDialog = vi.fn();
    const dialog = registerEscape(closeDialog);
    render(<HostSwitchScreen pending={pending()} />);
    dispatchEscape();
    expect(closeDialog).toHaveBeenCalled();
    expect(m.cancelPendingSwitch).not.toHaveBeenCalled();
    dialog.unregister();
    dispatchEscape();
    expect(m.cancelPendingSwitch).toHaveBeenCalledTimes(1);
  });

  it("leaves focus with a palette opened inside the loading gate", () => {
    render(<HostSwitchScreen pending={pending({ phase: "opening" })} />);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    act(() => void vi.advanceTimersByTime(400));
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("keeps Tab on its own controls", () => {
    render(
      <HostSwitchScreen
        pending={pending({
          phase: "failed",
          failure: { code: "HOST_DISCONNECTED", message: "down" },
        })}
      />
    );
    expect(document.activeElement).toBe(button("Retry"));
    fireEvent.keyDown(screen(), { key: "Tab" });
    expect(document.activeElement).toBe(button("Cancel"));
    // The reason is in flow, never a scroll box, so it is not a stop of its own.
    fireEvent.keyDown(screen(), { key: "Tab" });
    expect(document.activeElement).toBe(button("Retry"));
    fireEvent.keyDown(screen(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("holds back a host that is answering until the loading gate, and stays up across phases", () => {
    const { rerender } = render(<HostSwitchScreen pending={pending({ phase: "opening" })} />);
    expect(screen().className).toContain("opacity-0");
    act(() => void vi.advanceTimersByTime(400));
    expect(screen().className).not.toContain("opacity-0");

    rerender(<HostSwitchScreen pending={pending({ switchId: "sw-2", phase: "opening" })} />);
    expect(screen().className).not.toContain("opacity-0");
  });

  it("says Still working… past five seconds, and counts again for a new attempt", () => {
    const { rerender } = render(<HostSwitchScreen pending={pending()} />);
    expect(screen().textContent).not.toContain("Still working…");
    act(() => void vi.advanceTimersByTime(5_000));
    expect(screen().textContent).toContain("Still working…");

    rerender(<HostSwitchScreen pending={pending({ switchId: "sw-2" })} />);
    expect(screen().textContent).not.toContain("Still working…");
  });

  it("keeps one screen, one logo and one heading through every phase, a failure and a Retry", () => {
    const failure = { code: "HOST_DISCONNECTED" as const, message: "ssh: connect timed out" };
    const { rerender } = render(<HostSwitchScreen pending={pending()} />);
    const root = screen();
    const mark = document.querySelector('[data-testid="daintree-mark"]');
    expect(mark).not.toBeNull();
    expect(root.querySelector('[aria-current="step"] .animate-spin')).not.toBeNull();
    expect(root.textContent).toContain("Connecting…");
    const heading = root.querySelector("h2")!;
    expect(heading.textContent).toBe("Switching to studio-02");

    rerender(<HostSwitchScreen pending={pending({ phase: "starting" })} />);
    expect(root.textContent).toContain("Starting Daintree on the host…");
    expect(root.textContent).not.toContain("Connecting…");
    rerender(<HostSwitchScreen pending={pending({ phase: "opening", projectName: "api" })} />);
    expect(root.textContent).toContain("Opening the project…");
    act(() => void vi.advanceTimersByTime(5_000));
    expect(root.textContent).toContain("Still working…");
    expect(heading.textContent).toBe("Switching to studio-02");

    rerender(<HostSwitchScreen pending={pending({ phase: "failed", failure })} />);
    expect(heading.textContent).toBe("Couldn't switch to studio-02");
    expect(root.textContent).toContain("ssh: connect timed out");
    expect(root.textContent).not.toContain("Still working…");
    expect(root.querySelector(".animate-spin")).toBeNull();
    expect(button("Retry")).not.toBeNull();

    rerender(<HostSwitchScreen pending={pending({ switchId: "sw-2" })} />);
    expect(heading.textContent).toBe("Switching to studio-02");
    expect(root.querySelector(".animate-spin")).not.toBeNull();

    expect(screen()).toBe(root);
    expect(document.querySelector('[data-testid="daintree-mark"]')).toBe(mark);
    expect(document.querySelectorAll('[data-testid="daintree-mark"]')).toHaveLength(1);
  });

  it("draws the logo in only once the screen is shown, not while it is held back", () => {
    render(<HostSwitchScreen pending={pending({ phase: "opening" })} />);
    expect(document.querySelector('[data-testid="daintree-mark"]')).toBeNull();
    act(() => void vi.advanceTimersByTime(400));
    expect(document.querySelector('[data-testid="daintree-mark"]')).not.toBeNull();
  });

  it("can't be cancelled once the window is moving", () => {
    render(<HostSwitchScreen pending={pending({ phase: "opening", committed: true })} />);
    expect(button("Cancel")).toBeNull();
    // With nothing left to press, the screen itself keeps focus, and Tab with it.
    act(() => void vi.advanceTimersByTime(400));
    expect(document.activeElement).toBe(screen());
    fireEvent.keyDown(screen(), { key: "Tab" });
    expect(document.activeElement).toBe(screen());
    // Still on the escape stack: the key goes nowhere rather than to the project behind.
    expect(dispatchEscape()).toBe(true);
    expect(m.cancelPendingSwitch).not.toHaveBeenCalled();
  });

  it("ends a failed switch here, with what was seen, a retry of the same switch, and Cancel", () => {
    const focusIntent = { intent: "focus-panel" as const, panelId: "t-1" };
    render(
      <HostSwitchScreen
        pending={pending({
          phase: "failed",
          request: { projectId: "proj-1", focusIntent },
          failure: { code: "HOST_DISCONNECTED", message: "ssh: connect to host timed out" },
        })}
      />
    );
    expect(screen().textContent).toContain("Couldn't switch to studio-02");
    expect(screen().textContent).toContain("ssh: connect to host timed out");
    expect(document.activeElement).toBe(button("Retry"));

    fireEvent.click(button("Retry")!);
    expect(m.switchToHost).toHaveBeenCalledWith("studio-02", false, "proj-1", { focusIntent });
    // A retry replaces this screen with its own; it doesn't leave it first.
    expect(m.cancelPendingSwitch).not.toHaveBeenCalled();

    fireEvent.click(button("Cancel")!);
    expect(m.cancelPendingSwitch).toHaveBeenCalledWith({ switchId: "sw-1" });
  });
});
