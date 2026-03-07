// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { VoiceInputButton } from "../VoiceInputButton";

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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the active mic icon when voice input is configured but idle", () => {
    const { container } = render(
      <VoiceInputButton
        isConfigured
        onTranscriptionDelta={() => {}}
        onTranscriptionComplete={() => {}}
      />
    );

    expect(container.innerHTML).toContain("lucide-mic");
    expect(container.innerHTML).not.toContain("lucide-mic-off");
  });

  it("shows the disabled mic icon when voice input is not configured", () => {
    const { container } = render(
      <VoiceInputButton
        isConfigured={false}
        onTranscriptionDelta={() => {}}
        onTranscriptionComplete={() => {}}
      />
    );

    expect(container.innerHTML).toContain("lucide-mic-off");
  });
});
