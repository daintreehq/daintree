// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
  });

  it("dispatches fleet.retryFailures when the retry button is clicked", () => {
    useFleetFailureStore.setState({
      failedIds: new Set(["t1"]),
      payload: "ls\r",
    });
    render(<FleetFailureBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
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
});
