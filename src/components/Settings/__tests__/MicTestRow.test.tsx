// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicTestRow } from "../MicTestRow";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import type { VoiceSessionElsewhere, VoiceSessionSnapshot } from "@shared/types";

const startMicTest = vi.fn();
vi.mock("@/services/voiceMicTest", () => ({
  startMicTest: (...args: unknown[]) => startMicTest(...args),
}));

const service = vi.hoisted(() => ({
  stopActiveSession: vi.fn(),
  stopSessionElsewhereById: vi.fn(),
}));
vi.mock("@/services/VoiceRecordingService", () => ({ voiceRecordingService: service }));

const opened = { label: "Headset", substituted: false, bluetooth: true };

function elsewhere(phase: VoiceSessionSnapshot["phase"] | null): VoiceSessionElsewhere {
  const details: VoiceSessionSnapshot | null = phase && {
    phase,
    kind: "dictation",
    targetTitle: "Claude",
    targetChrome: null,
    targetHostId: null,
    projectName: "Alpha",
    worktreeLabel: null,
    micLabel: null,
    micSignal: "live",
    micNotice: null,
    stopWarning: false,
    correctionEnabled: false,
    locked: false,
    wordCount: 0,
    transcript: "",
    provider: null,
    clock: null,
  };
  return {
    sessionId: "session-elsewhere",
    hostId: "local",
    projectId: "alpha",
    projectName: "Alpha",
    details,
  };
}

function testButton() {
  return screen.getByRole("button", { name: /^(Test microphone|Stop test)$/ }) as HTMLButtonElement;
}

afterEach(() => {
  startMicTest.mockReset();
  service.stopActiveSession.mockReset();
  service.stopSessionElsewhereById.mockReset();
  useVoiceRecordingStore.setState({
    status: "idle",
    activeTarget: null,
    pendingTarget: null,
    sessionElsewhere: null,
  });
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

  it("stops the stream's tracks when the page is hidden", async () => {
    // The real service against a fake device, so this sees the tracks themselves stop.
    const actual =
      await vi.importActual<typeof import("@/services/voiceMicTest")>("@/services/voiceMicTest");
    startMicTest.mockImplementation(actual.startMicTest);
    const trackStop = vi.fn();
    const track = {
      label: "Headset",
      stop: trackStop,
      getSettings: () => ({ deviceId: "mic-1" }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        resume = vi.fn().mockResolvedValue(undefined);
        close = vi.fn().mockResolvedValue(undefined);
        createAnalyser() {
          return { fftSize: 0, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) };
        }
        createMediaStreamSource() {
          return { connect: vi.fn() };
        }
      }
    );
    try {
      const { rerender } = render(<MicTestRow deviceId="mic-1" active />);
      fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
      await waitFor(() => screen.getByRole("button", { name: "Stop test" }));
      expect(trackStop).not.toHaveBeenCalled();
      rerender(<MicTestRow deviceId="mic-1" active={false} />);
      expect(trackStop).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Test microphone" })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  it("takes the row's disabled state and describing ids", () => {
    render(<MicTestRow deviceId="" disabled />);
    const button = screen.getByRole("button", { name: "Test microphone" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain("Nothing is recorded");
    expect(screen.getByRole("meter").getAttribute("aria-describedby")).toBe(describedBy);
  });

  it("keeps Stop test usable when the row is disabled mid-test", async () => {
    const stop = vi.fn();
    startMicTest.mockResolvedValue({ opened, stop });
    const { rerender } = render(<MicTestRow deviceId="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await waitFor(() => screen.getByRole("button", { name: "Stop test" }));
    rerender(<MicTestRow deviceId="" disabled />);
    const button = screen.getByRole("button", { name: "Stop test" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "Test microphone" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("explains a refused microphone", async () => {
    startMicTest.mockRejectedValue("denied");
    render(<MicTestRow deviceId="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("blocked"));
  });

  describe("beside a dictation (#14951)", () => {
    it.each(["arming", "connecting", "recording", "paused", "reconnecting"] as const)(
      "won't test while this view's dictation is %s, and offers to stop it here",
      (status) => {
        useVoiceRecordingStore.setState({ status, activeTarget: { panelId: "p1" } });
        render(<MicTestRow deviceId="" />);
        expect(testButton().disabled).toBe(true);
        expect(screen.getByRole("status").textContent).not.toContain("Nothing is recorded");
        fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
        expect(service.stopActiveSession).toHaveBeenCalledWith({ returnToTarget: false });
        expect(service.stopSessionElsewhereById).not.toHaveBeenCalled();
        expect(startMicTest).not.toHaveBeenCalled();
      }
    );

    it.each(["finishing", "idle"] as const)(
      "counts a start queued while this view is %s as one to stop",
      (status) => {
        useVoiceRecordingStore.setState({ status, pendingTarget: { panelId: "p2" } });
        render(<MicTestRow deviceId="" />);
        expect(testButton().disabled).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
        expect(service.stopActiveSession).toHaveBeenCalledWith({ returnToTarget: false });
      }
    );

    it.each([null, "recording", "paused"] as const)(
      "won't test while another view's dictation is %s, and stops that one",
      (phase) => {
        useVoiceRecordingStore.setState({ sessionElsewhere: elsewhere(phase) });
        render(<MicTestRow deviceId="" />);
        expect(testButton().disabled).toBe(true);
        expect(screen.getByRole("status").textContent).not.toContain("Nothing is recorded");
        fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
        expect(service.stopSessionElsewhereById).toHaveBeenCalledWith("session-elsewhere");
        expect(service.stopActiveSession).not.toHaveBeenCalled();
      }
    );

    it("waits out a dictation that's finishing, with nothing to stop", () => {
      useVoiceRecordingStore.setState({ status: "finishing", activeTarget: { panelId: "p1" } });
      const { rerender } = render(<MicTestRow deviceId="" />);
      expect(testButton().disabled).toBe(true);
      expect(screen.getByRole("status").textContent).toContain("finishing");
      expect(screen.queryByRole("button", { name: "Stop dictation" })).toBeNull();

      act(() => {
        useVoiceRecordingStore.setState({
          status: "idle",
          activeTarget: null,
          sessionElsewhere: elsewhere("finishing"),
        });
      });
      rerender(<MicTestRow deviceId="" />);
      expect(testButton().disabled).toBe(true);
      expect(screen.queryByRole("button", { name: "Stop dictation" })).toBeNull();

      act(() => {
        useVoiceRecordingStore.setState({ sessionElsewhere: null });
      });
      expect(testButton().disabled).toBe(false);
      startMicTest.mockReturnValue(new Promise(() => {}));
      fireEvent.click(testButton());
      expect(startMicTest).toHaveBeenCalledTimes(1);
    });

    it.each(["idle", "error"] as const)(
      "tests again once the dictation ends as %s, without starting by itself",
      (status) => {
        useVoiceRecordingStore.setState({ status: "recording", activeTarget: { panelId: "p1" } });
        render(<MicTestRow deviceId="" />);
        act(() => {
          useVoiceRecordingStore.setState({ status, activeTarget: null });
        });
        expect(testButton().disabled).toBe(false);
        expect(screen.getByRole("status").textContent).toContain("Nothing is recorded");
        expect(screen.queryByRole("button", { name: "Stop dictation" })).toBeNull();
        expect(startMicTest).not.toHaveBeenCalled();
        startMicTest.mockReturnValue(new Promise(() => {}));
        fireEvent.click(testButton());
        expect(startMicTest).toHaveBeenCalledTimes(1);
      }
    );

    it("stops a running test when a dictation starts", async () => {
      const stop = vi.fn();
      startMicTest.mockResolvedValue({ opened, stop });
      render(<MicTestRow deviceId="" />);
      fireEvent.click(testButton());
      await waitFor(() => screen.getByRole("button", { name: "Stop test" }));
      act(() => {
        startMicTest.mock.calls[0]![0].onSample({ level: 0.8, heardSound: true, silent: false });
      });

      act(() => {
        useVoiceRecordingStore.setState({ sessionElsewhere: elsewhere("recording") });
      });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(testButton().textContent).toBe("Test microphone");
      expect(testButton().disabled).toBe(true);
      expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("0");
      act(() => {
        startMicTest.mock.calls[0]![0].onSample({ level: 0.8, heardSound: true, silent: false });
      });
      expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("0");
    });

    it("lets go of a mic that opens after a dictation started", async () => {
      const stop = vi.fn();
      let resolve!: (v: unknown) => void;
      startMicTest.mockReturnValue(new Promise((r) => (resolve = r)));
      render(<MicTestRow deviceId="" />);
      fireEvent.click(testButton());
      const { isCurrent } = startMicTest.mock.calls[0]![0];
      expect(isCurrent()).toBe(true);
      act(() => {
        useVoiceRecordingStore.setState({ status: "connecting", activeTarget: { panelId: "p1" } });
        // Before the row has re-rendered and its cleanup has run.
        expect(isCurrent()).toBe(false);
      });
      await act(async () => resolve({ opened, stop }));
      expect(stop).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Stop test" })).toBeNull();
    });

    it("won't start from a press the button hasn't caught up with", () => {
      render(<MicTestRow deviceId="" />);
      const button = testButton();
      act(() => {
        useVoiceRecordingStore.setState({ status: "arming", pendingTarget: { panelId: "p1" } });
        button.click();
      });
      expect(startMicTest).not.toHaveBeenCalled();
    });
  });
});
