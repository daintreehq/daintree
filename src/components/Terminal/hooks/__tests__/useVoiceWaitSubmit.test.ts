// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Compartment } from "@codemirror/state";
import { useTerminalInputStore } from "@/store/terminalInputStore";

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: { stop: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/store", () => ({
  useVoiceRecordingStore: {
    getState: () => ({
      activeTarget: { panelId: "test-panel" },
      status: "recording",
    }),
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ currentProject: undefined }),
  },
}));

import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { useVoiceWaitSubmit } from "../useVoiceWaitSubmit";

const stopMock = vi.mocked(voiceRecordingService.stop);

const PANEL_ID = "test-panel";

describe("terminalInputStore voiceSubmitting", () => {
  beforeEach(() => {
    useTerminalInputStore.setState({ voiceSubmittingPanels: new Set() });
  });

  it("setVoiceSubmitting adds and removes panels", () => {
    const store = useTerminalInputStore.getState();

    store.setVoiceSubmitting(PANEL_ID, true);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(true);

    store.setVoiceSubmitting(PANEL_ID, false);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("clearTerminalState clears voiceSubmitting", () => {
    useTerminalInputStore.getState().setVoiceSubmitting(PANEL_ID, true);
    useTerminalInputStore.getState().clearTerminalState(PANEL_ID);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("does not trigger unnecessary state updates", () => {
    const store = useTerminalInputStore.getState();
    store.setVoiceSubmitting(PANEL_ID, false);
    const before = useTerminalInputStore.getState().voiceSubmittingPanels;
    store.setVoiceSubmitting(PANEL_ID, false);
    const after = useTerminalInputStore.getState().voiceSubmittingPanels;
    expect(before).toBe(after);
  });
});

describe("useVoiceWaitSubmit", () => {
  let sendFromEditor: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    useTerminalInputStore.setState({ voiceSubmittingPanels: new Set() });
    sendFromEditor = vi.fn<() => void>();
    stopMock.mockReset();
    stopMock.mockResolvedValue(undefined);
  });

  function renderWaitSubmit() {
    return renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: PANEL_ID,
        editorViewRef: { current: null },
        editableCompartmentRef: { current: new Compartment() },
        sendFromEditor,
      })
    );
  }

  it("stops the session, sends, and clears the submitting flag", async () => {
    const { result } = renderWaitSubmit();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("does not send when cancelled while the transcript is still finishing", async () => {
    let resolveStop!: () => void;
    stopMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        })
    );

    const { result } = renderWaitSubmit();

    act(() => {
      result.current.startVoiceWaitSubmit();
    });
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(true);

    let cancelled = false;
    act(() => {
      cancelled = result.current.cancelVoiceWaitSubmit();
    });
    expect(cancelled).toBe(true);

    await act(async () => {
      resolveStop();
    });

    expect(sendFromEditor).not.toHaveBeenCalled();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("cancel is a no-op when nothing is waiting", () => {
    const { result } = renderWaitSubmit();
    expect(result.current.cancelVoiceWaitSubmit()).toBe(false);
  });

  it("ignores a second start while one is already waiting", async () => {
    let resolveStop!: () => void;
    stopMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        })
    );

    const { result } = renderWaitSubmit();

    act(() => {
      result.current.startVoiceWaitSubmit();
      result.current.startVoiceWaitSubmit();
    });
    expect(stopMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStop();
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
  });
});
