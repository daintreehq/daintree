// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { VoiceInputButton } from "../VoiceInputButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

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
      errorMessage: null,
      activeTarget: null,
      elapsedSeconds: 0,
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
      <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Canopy" />
    );

    expect(container.innerHTML).toContain("lucide-mic");
    expect(container.innerHTML).not.toContain("lucide-mic-off");
  });

  it("shows the disabled mic icon when voice input is not configured", () => {
    const { container } = render(
      <VoiceInputButton panelId="panel-1" projectId="project-1" projectName="Canopy" />
    );

    expect(container.innerHTML).toContain("lucide-mic-off");
  });
});
