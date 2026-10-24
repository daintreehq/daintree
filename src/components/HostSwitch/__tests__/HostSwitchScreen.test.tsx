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
  return document.querySelector('[data-testid="host-switch-screen"]') as HTMLElement;
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
  (window as unknown as { electron: unknown }).electron = {
    remoteHosts: { cancelPendingSwitch: m.cancelPendingSwitch },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HostSwitchScreen", () => {
  it("shows where the window is going at once while the link comes up, and Cancel goes back", () => {
    render(<HostSwitchScreen pending={pending()} />);
    expect(screen().className).not.toContain("opacity-0");
    expect(screen().textContent).toContain("Connecting to studio-02…");
    expect(document.activeElement).toBe(button("Cancel"));

    fireEvent.click(button("Cancel")!);
    expect(m.cancelPendingSwitch).toHaveBeenCalledWith({ switchId: "sw-1" });

    fireEvent.keyDown(screen(), { key: "Escape" });
    expect(m.cancelPendingSwitch).toHaveBeenCalledTimes(2);
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

  it("can't be cancelled once the window is moving", () => {
    render(<HostSwitchScreen pending={pending({ phase: "opening", committed: true })} />);
    expect(button("Cancel")).toBeNull();
    fireEvent.keyDown(screen(), { key: "Escape" });
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
