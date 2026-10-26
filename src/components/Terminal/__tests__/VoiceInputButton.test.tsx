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
      pendingTarget: null,
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

  // #14604: the finishing session drains on its own; a click starts the next.
  it.each([
    { disabled: false, starts: true },
    { disabled: true, starts: false },
  ])(
    "a click while this panel's session finishes starts the next one (disabled: $disabled)",
    ({ disabled, starts }) => {
      useVoiceRecordingStore.setState({
        isConfigured: true,
        status: "finishing",
        activeTarget: { panelId: "panel-1" } as never,
      });
      const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

      const { getByRole } = render(
        <VoiceInputButton
          panelId="panel-1"
          projectId="project-1"
          projectName="Daintree"
          disabled={disabled}
        />
      );
      const button = getByRole("button");
      fireEvent.click(button);

      expect((button as HTMLButtonElement).disabled).toBe(!starts);
      expect(toggleSpy).toHaveBeenCalledTimes(starts ? 1 : 0);
    }
  );

  it.each([
    { status: "idle" as const, activePanel: null, pending: false, clickable: false },
    { status: "recording" as const, activePanel: "panel-2", pending: false, clickable: false },
    { status: "recording" as const, activePanel: "panel-1", pending: false, clickable: true },
    { status: "finishing" as const, activePanel: "panel-2", pending: true, clickable: false },
  ])(
    "a disabled input only allows stopping its own session ($status on $activePanel, pending $pending)",
    ({ status, activePanel, pending, clickable }) => {
      useVoiceRecordingStore.setState({
        isConfigured: true,
        status,
        micSignal: "live",
        activeTarget: activePanel ? ({ panelId: activePanel } as never) : null,
        pendingTarget: pending ? ({ panelId: "panel-1" } as never) : null,
      });
      const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

      const { getByRole } = render(
        <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Daintree" disabled />
      );
      const button = getByRole("button");
      fireEvent.click(button);

      expect((button as HTMLButtonElement).disabled).toBe(!clickable);
      expect(toggleSpy).toHaveBeenCalledTimes(clickable ? 1 : 0);
    }
  );

  // #14604: a start queued here behind a finishing session ends on the next click.
  it.each([
    { label: "same panel", activePanel: "panel-1" },
    { label: "another panel", activePanel: "panel-2" },
  ])("names a queued start's click as a stop ($label)", async ({ activePanel }) => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "finishing",
      micSignal: "live",
      activeTarget: { panelId: activePanel } as never,
      pendingTarget: { panelId: "panel-1" } as never,
    });

    render(<VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Daintree" />);
    const button = screen.getByRole("button");

    expect(button.getAttribute("aria-label")).toBe("Stop voice recording");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.focus(button);
    expect((await screen.findByRole("tooltip")).textContent).toContain("Click to stop");
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
