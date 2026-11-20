// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentUsageTrackingSnapshot } from "@shared/types/ipc/agentUsage";
import { useAgentUsageTrackingStore } from "@/store/agentUsageTrackingStore";
import { AgentUsageTrackingSection } from "../AgentUsageTrackingSection";

const setTracking = vi.fn<(payload: { enabled: boolean }) => Promise<AgentUsageTrackingSnapshot>>();
const getTracking = vi.fn<() => Promise<AgentUsageTrackingSnapshot>>();

function switchEl(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[role="switch"]')!;
}

describe("AgentUsageTrackingSection (#17981)", () => {
  beforeEach(() => {
    setTracking.mockReset();
    getTracking.mockReset();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { agentUsage: { setTracking, getTracking } },
    });
    useAgentUsageTrackingStore.setState({ enabled: true, revision: 0 });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "electron");
  });

  it("turns tracking off and back on for this machine, with a reset to on", async () => {
    let revision = 0;
    setTracking.mockImplementation(async ({ enabled }) => ({ enabled, revision: ++revision }));
    const { container } = render(<AgentUsageTrackingSection />);
    expect(switchEl(container).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByLabelText("Reset Track agent usage to default")).toBeNull();

    await act(async () => fireEvent.click(switchEl(container)));
    expect(setTracking).toHaveBeenLastCalledWith({ enabled: false });
    expect(switchEl(container).getAttribute("aria-checked")).toBe("false");

    await act(async () => fireEvent.click(switchEl(container)));
    expect(setTracking).toHaveBeenLastCalledWith({ enabled: true });
    expect(switchEl(container).getAttribute("aria-checked")).toBe("true");

    await act(async () => fireEvent.click(switchEl(container)));
    await act(async () =>
      fireEvent.click(screen.getByLabelText("Reset Track agent usage to default"))
    );
    expect(setTracking).toHaveBeenLastCalledWith({ enabled: true });
    expect(switchEl(container).getAttribute("aria-checked")).toBe("true");
  });

  it("shows what main holds after a failed save, and saves the change again on Retry", async () => {
    // Another window turned it off meanwhile: the failed save shows main's value, not a guess.
    useAgentUsageTrackingStore.setState({ enabled: true, revision: 0 });
    setTracking.mockRejectedValueOnce(new Error("disk full"));
    getTracking.mockResolvedValue({ enabled: false, revision: 3 });
    const { container } = render(<AgentUsageTrackingSection />);
    await act(async () => fireEvent.click(switchEl(container)));
    expect(getTracking).toHaveBeenCalledTimes(1);
    expect(switchEl(container).getAttribute("aria-checked")).toBe("false");
    const retry = screen.getByRole("button", { name: "Retry" });

    setTracking.mockResolvedValueOnce({ enabled: false, revision: 3 });
    await act(async () => fireEvent.click(retry));
    expect(setTracking).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("leaves Retry off screen when a later save went through", async () => {
    let fail!: (error: Error) => void;
    setTracking.mockImplementationOnce(
      () => new Promise<AgentUsageTrackingSnapshot>((_resolve, reject) => (fail = reject))
    );
    setTracking.mockResolvedValueOnce({ enabled: false, revision: 1 });
    getTracking.mockResolvedValue({ enabled: false, revision: 1 });
    const { container } = render(<AgentUsageTrackingSection />);
    fireEvent.click(switchEl(container));
    await act(async () => fireEvent.click(switchEl(container)));
    expect(switchEl(container).getAttribute("aria-checked")).toBe("false");
    await act(async () => fail(new Error("late")));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
