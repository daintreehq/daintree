// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicTestRow } from "../MicTestRow";

const startMicTest = vi.fn();
vi.mock("@/services/voiceMicTest", () => ({
  startMicTest: (...args: unknown[]) => startMicTest(...args),
}));

const opened = { label: "Headset", substituted: false, bluetooth: true };

afterEach(() => {
  startMicTest.mockReset();
});

describe("MicTestRow", () => {
  it("starts a test on the selected device and stops it on demand", async () => {
    const stop = vi.fn();
    startMicTest.mockResolvedValue({ opened, stop });
    render(<MicTestRow deviceId="mic-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await waitFor(() => screen.getByRole("button", { name: "Stop test" }));
    expect(startMicTest.mock.calls[0]![0].deviceId).toBe("mic-1");
    fireEvent.click(screen.getByRole("button", { name: "Stop test" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Test microphone" })).toBeTruthy();
  });

  it("says so in words when the device stays silent", async () => {
    startMicTest.mockResolvedValue({ opened, stop: vi.fn() });
    render(<MicTestRow deviceId="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await waitFor(() => screen.getByRole("button", { name: "Stop test" }));
    act(() => {
      startMicTest.mock.calls[0]![0].onSample({ level: 0, heardSound: false, silent: true });
    });
    expect(screen.getByRole("status").textContent).toContain("No sound from Headset");
    expect(screen.getByRole("status").textContent).toContain("Bluetooth");
  });

  it("keeps the wrong-device note beside the silence advice", async () => {
    startMicTest.mockResolvedValue({
      opened: { label: "Built-in", substituted: true, bluetooth: false },
      stop: vi.fn(),
    });
    render(<MicTestRow deviceId="mic-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await waitFor(() => screen.getByRole("button", { name: "Stop test" }));
    act(() => {
      startMicTest.mock.calls[0]![0].onSample({ level: 0, heardSound: false, silent: true });
    });
    const text = screen.getByRole("status").textContent;
    expect(text).toContain("testing Built-in instead");
    expect(text).toContain("No sound from Built-in");
  });

  it("releases the mic when the page unmounts", async () => {
    const stop = vi.fn();
    startMicTest.mockResolvedValue({ opened, stop });
    const { unmount } = render(<MicTestRow deviceId="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await waitFor(() => screen.getByRole("button", { name: "Stop test" }));
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("releases a stream that opens after the user already stopped", async () => {
    const stop = vi.fn();
    let resolve!: (v: unknown) => void;
    startMicTest.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(<MicTestRow deviceId="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    unmount();
    await act(async () => resolve({ opened, stop }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("explains a refused microphone", async () => {
    startMicTest.mockRejectedValue("denied");
    render(<MicTestRow deviceId="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("blocked"));
  });
});
