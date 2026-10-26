// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, type RenderOptions } from "@testing-library/react";
import { VoiceInputButton } from "../VoiceInputButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

function createVoiceInputApi() {
  return {
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    sendAudioChunk: vi.fn(),
    onTranscriptionDelta: vi.fn(() => () => {}),
    onTranscriptionComplete: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    checkMicPermission: vi.fn(),
    requestMicPermission: vi.fn(),
    openMicSettings: vi.fn(),
    validateApiKey: vi.fn(),
  };
}

describe("VoiceInputButton", () => {
  beforeEach(() => {
    window.electron = {
      voiceInput: createVoiceInputApi(),
    } as unknown as typeof window.electron;
    useVoiceRecordingStore.setState({
      isConfigured: false,
      status: "idle",
      lastError: null,
      activeTarget: null,
      elapsedSeconds: 0,
      micSignal: "pending",
      panelBuffers: {},
      announcement: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the active mic icon when voice input is configured but idle", () => {
    useVoiceRecordingStore.setState({ isConfigured: true });
    const { container } = render(
      <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Daintree" />
    );

    expect(container.innerHTML).toContain("lucide-mic");
  });

  it("renders a setup affordance when voice input is not configured", () => {
    const { getByLabelText } = render(
      <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Daintree" />
    );

    expect(getByLabelText("Set up voice input")).toBeTruthy();
  });

  it("still renders when not configured but actively recording on this panel", () => {
    useVoiceRecordingStore.setState({
      isConfigured: false,
      status: "recording",
      activeTarget: { panelId: "panel-1" } as never,
    });
    const { container } = render(
      <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Daintree" />
    );

    expect(container.innerHTML).not.toBe("");
  });

  it("renders a resume affordance when this panel is paused", async () => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "paused",
      activeTarget: { panelId: "panel-1" } as never,
    });
    const { getByRole } = render(
      <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Daintree" />
    );
    const button = getByRole("button");
    expect(button.getAttribute("aria-label")).toBe("Resume voice recording");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.focus(button);
    expect((await screen.findByRole("tooltip")).textContent).toContain("Paused");
  });

  it("clicking while paused calls togglePause instead of toggle", () => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "paused",
      activeTarget: { panelId: "panel-1" } as never,
    });
    const togglePauseSpy = vi
      .spyOn(voiceRecordingService, "togglePause")
      .mockImplementation(() => undefined);
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    const { getByRole } = render(
      <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Daintree" />
    );
    fireEvent.click(getByRole("button"));

    expect(togglePauseSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it.each([
    { status: "connecting" as const, micSignal: "pending" as const, tip: "Starting microphone…" },
    { status: "recording" as const, micSignal: "pending" as const, tip: "Starting microphone…" },
    { status: "recording" as const, micSignal: "silent" as const, tip: "No audio from microphone" },
    {
      status: "recording" as const,
      micSignal: "silent" as const,
      micDeviceLabel: "AirPods Pro",
      tip: "No audio from AirPods Pro",
    },
    { status: "connecting" as const, micSignal: "live" as const, tip: "Stop recording" },
    { status: "recording" as const, micSignal: "live" as const, tip: "Stop recording" },
  ])(
    "only claims listening once the mic delivers audio ($status, mic $micSignal) — #13105",
    async ({ status, micSignal, micDeviceLabel = null, tip }) => {
      useVoiceRecordingStore.setState({
        isConfigured: true,
        status,
        micSignal,
        micDeviceLabel,
        activeTarget: { panelId: "panel-1" },
      });
      const { getByRole } = render(
        <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Daintree" />
      );
      const button = getByRole("button");
      // Either way the session is open and a press stops it.
      expect(button.getAttribute("aria-label")).toBe("Stop voice recording");
      expect(button.getAttribute("aria-pressed")).toBe("true");
      fireEvent.focus(button);
      expect((await screen.findByRole("tooltip")).textContent).toContain(tip);
    }
  );
  it("marks an error only on the panel it happened in", () => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "error",
      errorPanelId: "panel-1",
    });
    const { getByRole, rerender } = render(<VoiceInputButton panelId="panel-1" />);
    expect(getByRole("button").className).toContain("text-activity-waiting");
    rerender(<VoiceInputButton panelId="panel-2" />);
    expect(getByRole("button").className).not.toContain("text-activity-waiting");
  });

  it("swaps the stop glyph for a spinner while reconnecting", () => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "reconnecting",
      micSignal: "live",
      activeTarget: { panelId: "panel-1" } as never,
    });
    const { getByRole } = render(<VoiceInputButton panelId="panel-1" />);
    expect(getByRole("button").querySelector(".status-mark")).toBeNull();
  });

  it("warns in the tooltip when the paused session is about to auto-stop", async () => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "paused",
      pauseStopWarning: true,
      activeTarget: { panelId: "panel-1" } as never,
    });
    const { getByRole } = render(<VoiceInputButton panelId="panel-1" />);
    fireEvent.focus(getByRole("button"));
    expect((await screen.findByRole("tooltip")).textContent).toContain("stops in 10s");
  });
});
