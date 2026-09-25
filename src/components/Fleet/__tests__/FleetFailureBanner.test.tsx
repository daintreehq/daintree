// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// jsdom omits matchMedia; InlineStatusBanner reads it for prefers-reduced-motion.
vi.stubGlobal(
  "matchMedia",
  vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
);
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue(undefined),
  },
}));

const unconfirmed = vi.hoisted(() => new Map<string, number>());
const confirmCrossHostResend = vi.hoisted(() => vi.fn());
vi.mock("../crossHostFleet", () => ({
  crossHostSafeRetryDeadline: (id: string) => unconfirmed.get(id) ?? null,
  confirmCrossHostResend,
  getCrossHostTarget: (id: string) =>
    unconfirmed.has(id) ? { key: id, hostName: "studio-01", hostId: "h1", terminalId: "t" } : null,
}));

import { FleetFailureBanner } from "../FleetFailureBanner";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { actionService } from "@/services/ActionService";

function resetStore() {
  useFleetFailureStore.setState({
    failedIds: new Set(),
    payload: null,
    disarmedCount: 0,
  });
}

describe("FleetFailureBanner", () => {
  beforeEach(() => {
    resetStore();
    unconfirmed.clear();
    vi.clearAllMocks();
  });

  it("renders nothing when there are no failed ids", () => {
    const { container } = render(<FleetFailureBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders broadcast-failed banner with replay-capable copy when payload is non-null", () => {
    useFleetFailureStore.setState({
      failedIds: new Set(["t1", "t2"]),
      payload: "ls\r",
    });
    render(<FleetFailureBanner />);
    expect(screen.getByText("Broadcast failed")).toBeTruthy();
    expect(screen.getByText("2 terminals rejected the write.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("uses singular noun when exactly one target failed", () => {
    useFleetFailureStore.setState({
      failedIds: new Set(["t1"]),
      payload: "ls\r",
    });
    render(<FleetFailureBanner />);
    expect(screen.getByText("1 terminal rejected the write.")).toBeTruthy();
  });

  it("omits the retry action and shows no-replay copy when payload is null", () => {
    useFleetFailureStore.setState({
      failedIds: new Set(["t1", "t2"]),
      payload: null,
    });
    render(<FleetFailureBanner />);
    expect(
      screen.getByText("2 terminals rejected a keystroke. Single keystrokes can't be replayed.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("dispatches fleet.retryFailures when the retry button is clicked", () => {
    useFleetFailureStore.setState({
      failedIds: new Set(["t1"]),
      payload: "ls\r",
    });
    render(<FleetFailureBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(actionService.dispatch).toHaveBeenCalledWith("fleet.retryFailures", undefined, {
      source: "user",
    });
  });

  it("clears the failure store when the dismiss button is clicked", () => {
    useFleetFailureStore.setState({
      failedIds: new Set(["t1"]),
      payload: "ls\r",
    });
    render(<FleetFailureBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const s = useFleetFailureStore.getState();
    expect(s.failedIds.size).toBe(0);
    expect(s.payload).toBeNull();
  });

  it("names auto-disarmed unreachable panes recorded with the same broadcast (#10930)", () => {
    useFleetFailureStore.getState().recordFailure("ls\r", ["t1"], 1);
    render(<FleetFailureBanner />);
    expect(
      screen.getByText("1 terminal rejected the write. 1 unreachable terminal was disarmed.")
    ).toBeTruthy();
  });

  it("pluralizes the disarmed suffix", () => {
    useFleetFailureStore.getState().recordFailure("ls\r", ["t1", "t2"], 2);
    render(<FleetFailureBanner />);
    expect(
      screen.getByText("2 terminals rejected the write. 2 unreachable terminals were disarmed.")
    ).toBeTruthy();
  });

  it("keeps the plain copy when the broadcast had no permanent failures", () => {
    useFleetFailureStore.getState().recordFailure("ls\r", ["t1"]);
    render(<FleetFailureBanner />);
    expect(screen.getByText("1 terminal rejected the write.")).toBeTruthy();
  });

  it("resets the disarmed count when the failure set is cleared", () => {
    useFleetFailureStore.getState().recordFailure("ls\r", ["t1"], 3);
    useFleetFailureStore.getState().dismissId("t1");
    expect(useFleetFailureStore.getState().disarmedCount).toBe(0);
  });

  it("offers a plain retry while another host's unconfirmed submit is still safe to resend", () => {
    unconfirmed.set("host-fleet:h1:t", Date.now() + 60_000);
    useFleetFailureStore.getState().recordFailure("go\r", ["host-fleet:h1:t"]);
    render(<FleetFailureBanner />);
    expect(screen.getByText("1 terminal rejected the write.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("stops offering a safe retry once the window closes, and resends only after confirmation", () => {
    vi.useFakeTimers();
    try {
      unconfirmed.set("host-fleet:h1:t", Date.now() + 1_000);
      useFleetFailureStore.getState().recordFailure("go\r", ["host-fleet:h1:t"]);
      render(<FleetFailureBanner />);
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.getByText("Broadcast unconfirmed")).toBeTruthy();
      expect(
        screen.getByText(
          "Couldn't confirm whether 1 agent on studio-01 received the prompt. Sending it again may deliver it twice."
        )
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Send again…" }));
      expect(actionService.dispatch).not.toHaveBeenCalled();
      expect(screen.getByText("Send the prompt to studio-01 again?")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
      expect(confirmCrossHostResend).toHaveBeenCalledWith(["host-fleet:h1:t"]);
      expect(actionService.dispatch).toHaveBeenCalledWith("fleet.retryFailures", undefined, {
        source: "user",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the safe targets first when a broadcast mixes both", () => {
    unconfirmed.set("host-fleet:h1:t", Date.now() - 1);
    useFleetFailureStore.getState().recordFailure("go\r", ["t1", "host-fleet:h1:t"]);
    render(<FleetFailureBanner />);
    expect(
      screen.getByText(
        "1 terminal rejected the write. Couldn't confirm whether 1 agent on studio-01 received the prompt. Sending it again may deliver it twice."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    // The unconfirmed agent stays reachable even while the other target keeps failing.
    fireEvent.click(screen.getByRole("button", { name: "Send again…" }));
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    expect(confirmCrossHostResend).toHaveBeenCalledWith(["host-fleet:h1:t"]);
  });
});
