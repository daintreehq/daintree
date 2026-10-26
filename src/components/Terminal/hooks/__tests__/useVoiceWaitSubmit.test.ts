// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Compartment } from "@codemirror/state";
import { useTerminalInputStore } from "@/store/terminalInputStore";

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: {
    stop: vi.fn().mockResolvedValue(undefined),
    hasPendingCorrection: vi.fn(() => false),
    waitForPendingCorrections: vi.fn().mockResolvedValue(true),
  },
  VOICE_CORRECTION_SEND_WAIT_MS: 2000,
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
const hasPendingMock = vi.mocked(voiceRecordingService.hasPendingCorrection);
const waitMock = vi.mocked(voiceRecordingService.waitForPendingCorrections);

const PANEL_ID = "test-panel";

describe("terminalInputStore voiceSubmitting", () => {
  beforeEach(() => {
    useTerminalInputStore.setState({ voiceSubmittingPanels: new Set() });
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
    hasPendingMock.mockReset();
    hasPendingMock.mockReturnValue(false);
    waitMock.mockReset();
    waitMock.mockResolvedValue(true);
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

  it("waits for a pending correction before it sends", async () => {
    let finishCorrection!: (landed: boolean) => void;
    hasPendingMock.mockReturnValue(true);
    waitMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishCorrection = resolve;
        })
    );

    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    expect(waitMock).toHaveBeenCalledWith(PANEL_ID, 2000);
    expect(result.current.voiceSubmitPhase).toBe("polishing");
    expect(sendFromEditor).not.toHaveBeenCalled();

    await act(async () => {
      finishCorrection(false);
    });

    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("leaves the correction to land when Escape cancels the wait for it", async () => {
    let finishCorrection!: (landed: boolean) => void;
    hasPendingMock.mockReturnValue(true);
    waitMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishCorrection = resolve;
        })
    );

    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    act(() => {
      expect(result.current.cancelVoiceWaitSubmit()).toBe(true);
    });
    expect(result.current.voiceSubmitPhase).toBeNull();

    await act(async () => {
      finishCorrection(true);
    });

    expect(sendFromEditor).not.toHaveBeenCalled();
  });

  it("drops its send when the composer unmounts mid-wait, leaving the panel free to send", async () => {
    let finishCorrection!: (landed: boolean) => void;
    hasPendingMock.mockReturnValue(true);
    waitMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishCorrection = resolve;
        })
    );

    const { result, unmount } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    unmount();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);

    await act(async () => {
      finishCorrection(true);
    });
    expect(sendFromEditor).not.toHaveBeenCalled();
  });

  it("sends once, from the later attempt, after Escape and a second Enter", async () => {
    const stops: Array<() => void> = [];
    stopMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          stops.push(resolve);
        })
    );

    const { result } = renderWaitSubmit();
    act(() => {
      result.current.startVoiceWaitSubmit();
    });
    act(() => {
      result.current.cancelVoiceWaitSubmit();
    });
    act(() => {
      result.current.startVoiceWaitSubmit();
    });
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(true);

    // The first attempt's stop finishing must not send or unlock the second.
    await act(async () => {
      stops[0]!();
    });
    expect(sendFromEditor).not.toHaveBeenCalled();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(true);

    await act(async () => {
      stops[1]!();
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });
});

describe("useVoiceWaitSubmit submitFromEditor", () => {
  let sendFromEditor: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    useTerminalInputStore.setState({ voiceSubmittingPanels: new Set() });
    sendFromEditor = vi.fn<() => void>();
    stopMock.mockReset();
    stopMock.mockResolvedValue(undefined);
    hasPendingMock.mockReset();
    waitMock.mockReset();
    waitMock.mockResolvedValue(true);
  });

  it("routes through the correction wait when this panel has one pending", async () => {
    // The mocked voice store reports a session on PANEL_ID; this composer is
    // another panel, so only its own pending correction can hold the send.
    hasPendingMock.mockImplementation((panelId) => panelId === "other-panel");
    let finishCorrection!: (landed: boolean) => void;
    waitMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishCorrection = resolve;
        })
    );
    const { result } = renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: "other-panel",
        editorViewRef: { current: null },
        editableCompartmentRef: { current: new Compartment() },
        sendFromEditor,
      })
    );

    await act(async () => {
      result.current.submitFromEditor();
    });

    expect(stopMock).not.toHaveBeenCalled();
    expect(waitMock).toHaveBeenCalledWith("other-panel", 2000);
    expect(sendFromEditor).not.toHaveBeenCalled();

    await act(async () => {
      finishCorrection(true);
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
  });

  it("sends straight away when nothing is finishing or being corrected", () => {
    hasPendingMock.mockReturnValue(false);
    const { result } = renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: "other-panel",
        editorViewRef: { current: null },
        editableCompartmentRef: { current: new Compartment() },
        sendFromEditor,
      })
    );

    act(() => {
      result.current.submitFromEditor();
    });

    expect(waitMock).not.toHaveBeenCalled();
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(useTerminalInputStore.getState().isVoiceSubmitting("other-panel")).toBe(false);
  });
});
