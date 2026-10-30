// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useTerminalInputStore } from "@/store/terminalInputStore";

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: {
    stop: vi.fn().mockResolvedValue(undefined),
    sendSessions: vi.fn(() => new Set<string>()),
    hasPendingCorrection: vi.fn(() => false),
    expectedCorrectionWindow: vi.fn(() => null),
    waitForPendingCorrections: vi.fn().mockResolvedValue(true),
    observeSendCorrections: vi.fn(() => ({ failed: () => false, release: () => {} })),
    onSpokenSend: vi.fn(() => () => {}),
  },
}));

const voiceState = vi.hoisted(() => ({
  activeTarget: { panelId: "test-panel" },
  status: "recording",
}));
vi.mock("@/store", () => ({
  useVoiceRecordingStore: { getState: () => voiceState },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ currentProject: undefined }),
  },
}));

const panelState = vi.hoisted(() => ({ focusedId: null as string | null }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => panelState },
}));

import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { useVoiceWaitSubmit } from "../useVoiceWaitSubmit";
import type { ClaimSendHandBack } from "../useSendHandBack";

const stopMock = vi.mocked(voiceRecordingService.stop);
const hasPendingMock = vi.mocked(voiceRecordingService.hasPendingCorrection);
const waitMock = vi.mocked(voiceRecordingService.waitForPendingCorrections);
const onSpokenSendMock = vi.mocked(voiceRecordingService.onSpokenSend);
const sendSessionsMock = vi.mocked(voiceRecordingService.sendSessions);
const landingMock = vi.mocked(voiceRecordingService.expectedCorrectionWindow);
const observeMock = vi.mocked(voiceRecordingService.observeSendCorrections);
// The sessions a send reads as it starts, which its wait and send take.
const OWNED = new Set(["owned-session"]);

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
  let onSpokenSendTooShort: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    useTerminalInputStore.setState({ voiceSubmittingPanels: new Set() });
    sendFromEditor = vi.fn<() => void>();
    onSpokenSendTooShort = vi.fn<() => void>();
    stopMock.mockReset();
    stopMock.mockResolvedValue(undefined);
    hasPendingMock.mockReset();
    hasPendingMock.mockReturnValue(false);
    waitMock.mockReset();
    waitMock.mockResolvedValue(true);
    onSpokenSendMock.mockReset();
    onSpokenSendMock.mockReturnValue(() => {});
    sendSessionsMock.mockReset();
    sendSessionsMock.mockReturnValue(OWNED);
    landingMock.mockReset();
    landingMock.mockReturnValue(null);
    observeMock.mockReset();
    observeMock.mockReturnValue({ failed: () => false, release: () => {} });
    useTerminalInputStore.getState().clearDraftInput(PANEL_ID);
    panelState.focusedId = null;
    voiceState.status = "recording";
    (document.activeElement as HTMLElement | null)?.blur();
  });

  function renderWaitSubmit(isDisabled?: () => boolean, claimSendHandBack?: ClaimSendHandBack) {
    return renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: PANEL_ID,
        editorViewRef: { current: null },
        editableCompartmentRef: { current: new Compartment() },
        sendFromEditor,
        claimSendHandBack,
        isDisabled,
        onSpokenSendTooShort,
      })
    );
  }

  function spokenSendHandler(): (options?: { spoken?: boolean; tooShort?: boolean }) => void {
    const call = onSpokenSendMock.mock.calls.at(-1);
    expect(call?.[0]).toBe(PANEL_ID);
    return call![2];
  }

  describe("spoken send", () => {
    it("stops the session and sends a prompt of three or more words", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "fix the login bug");
      renderWaitSubmit();

      await act(async () => {
        spokenSendHandler()();
      });

      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
      expect(onSpokenSendTooShort).not.toHaveBeenCalled();
    });

    it("waits for the correction before sending, as Enter does", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "fix the login bug");
      hasPendingMock.mockReturnValue(true);
      let landCorrection!: (landed: boolean) => void;
      waitMock.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            landCorrection = resolve;
          })
      );
      renderWaitSubmit();

      await act(async () => {
        spokenSendHandler()();
      });
      expect(waitMock).toHaveBeenCalledWith(PANEL_ID, expect.any(AbortSignal), OWNED);
      expect(sendFromEditor).not.toHaveBeenCalled();

      await act(async () => {
        landCorrection(true);
      });
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
    });

    // #14920: the session panel's Send is a press, not an utterance.
    it("sends a short draft when the session panel asks, as Enter would", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "fix it");
      renderWaitSubmit();

      await act(async () => {
        spokenSendHandler()({ spoken: false });
      });

      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
    });

    it("leaves the keyboard where it is for the session panel's send", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "fix the login bug");
      const handBack = vi.fn();
      const claimSendHandBack = vi.fn(() => handBack);
      renderWaitSubmit(undefined, claimSendHandBack);

      await act(async () => {
        spokenSendHandler()({ spoken: false });
      });

      // No claim, and a hand-back of its own that hands nothing back, so the
      // send can't claim one either.
      expect(claimSendHandBack).not.toHaveBeenCalled();
      expect(sendFromEditor).toHaveBeenCalledWith(
        expect.any(Function),
        expect.anything(),
        undefined
      );
      expect(sendFromEditor).not.toHaveBeenCalledWith(handBack, expect.anything(), undefined);
    });

    it.each([
      ["", false],
      ["fix it", true],
      ["  ok , ! ", true],
    ])("stops but leaves %j unsent, saying so for a reply: %s", async (draft, says) => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, draft);
      renderWaitSubmit();

      await act(async () => {
        spokenSendHandler()();
      });

      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(sendFromEditor).not.toHaveBeenCalled();
      expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
      expect(onSpokenSendTooShort).toHaveBeenCalledTimes(says ? 1 : 0);
    });

    // #14944: the service found the draft too short and stopped the dictation itself.
    it("says a reply was too short to send without stopping, waiting or sending", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "yes");
      hasPendingMock.mockReturnValue(true);
      const claimSendHandBack = vi.fn(() => vi.fn());
      renderWaitSubmit(undefined, claimSendHandBack);

      await act(async () => {
        spokenSendHandler()({ tooShort: true });
      });

      expect(onSpokenSendTooShort).toHaveBeenCalledTimes(1);
      expect(stopMock).not.toHaveBeenCalled();
      expect(waitMock).not.toHaveBeenCalled();
      expect(sendFromEditor).not.toHaveBeenCalled();
      expect(claimSendHandBack).not.toHaveBeenCalled();
      expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
    });

    it("says nothing of a too-short reply in a disabled composer, and stops nothing more", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "yes");
      renderWaitSubmit(() => true);

      await act(async () => {
        spokenSendHandler()({ tooShort: true });
      });

      expect(onSpokenSendTooShort).not.toHaveBeenCalled();
      expect(stopMock).not.toHaveBeenCalled();
    });

    it("says nothing late for a send cancelled before its cleanup left it too short", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "um so yeah");
      hasPendingMock.mockReturnValue(true);
      let landCorrection!: (landed: boolean) => void;
      waitMock.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            landCorrection = resolve;
          })
      );
      const { result } = renderWaitSubmit();

      await act(async () => {
        spokenSendHandler()();
      });
      act(() => {
        result.current.cancelVoiceWaitSubmit();
      });
      await act(async () => {
        useTerminalInputStore.getState().setDraftInput(PANEL_ID, "Yeah.");
        landCorrection(true);
      });

      expect(onSpokenSendTooShort).not.toHaveBeenCalled();
      expect(sendFromEditor).not.toHaveBeenCalled();
    });

    it("joins a stop already finishing and sends once its correction lands (#14803)", async () => {
      voiceState.status = "finishing";
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "fix the login bug");
      let endStop!: () => void;
      stopMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            endStop = resolve;
          })
      );
      hasPendingMock.mockReturnValue(true);
      let landCorrection!: (landed: boolean) => void;
      waitMock.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            landCorrection = resolve;
          })
      );
      renderWaitSubmit();

      await act(async () => {
        spokenSendHandler()();
      });
      expect(stopMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ reason: "send" })
      );
      await act(async () => {
        endStop();
      });
      expect(sendFromEditor).not.toHaveBeenCalled();

      await act(async () => {
        landCorrection(true);
      });
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
    });

    it("rechecks the draft after the correction lands", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "um so yeah");
      hasPendingMock.mockReturnValue(true);
      let landCorrection!: (landed: boolean) => void;
      waitMock.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            landCorrection = resolve;
          })
      );
      renderWaitSubmit();

      await act(async () => {
        spokenSendHandler()();
      });
      await act(async () => {
        useTerminalInputStore.getState().setDraftInput(PANEL_ID, "Yeah.");
        landCorrection(true);
      });

      expect(sendFromEditor).not.toHaveBeenCalled();
      expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
      expect(onSpokenSendTooShort).toHaveBeenCalledTimes(1);
    });

    it.each(["", "  "])("says nothing of a reply when the cleanup leaves %j", async (cleaned) => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "um so yeah");
      hasPendingMock.mockReturnValue(true);
      let landCorrection!: (landed: boolean) => void;
      waitMock.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            landCorrection = resolve;
          })
      );
      renderWaitSubmit();

      await act(async () => {
        spokenSendHandler()();
      });
      await act(async () => {
        useTerminalInputStore.getState().setDraftInput(PANEL_ID, cleaned);
        landCorrection(true);
      });

      expect(sendFromEditor).not.toHaveBeenCalled();
      expect(onSpokenSendTooShort).not.toHaveBeenCalled();
    });

    it("claims the keyboard's hand-back at the command and sends with it, as Enter does", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "fix the login bug");
      const handBack = vi.fn();
      const claimSendHandBack = vi.fn(() => handBack);
      renderWaitSubmit(undefined, claimSendHandBack);

      await act(async () => {
        spokenSendHandler()();
      });

      expect(claimSendHandBack).toHaveBeenCalledTimes(1);
      expect(sendFromEditor).toHaveBeenCalledWith(
        handBack,
        expect.objectContaining({ text: "fix the login bug", kept: "", sessions: OWNED }),
        undefined
      );
    });

    it("only stops dictation when the composer is disabled", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "fix the login bug");
      renderWaitSubmit(() => true);

      await act(async () => {
        spokenSendHandler()();
      });

      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(sendFromEditor).not.toHaveBeenCalled();
      expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
    });

    it("leaves Enter free to send a short prompt", async () => {
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "yes");
      const { result } = renderWaitSubmit();

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      expect(sendFromEditor).toHaveBeenCalledTimes(1);
    });

    it("unregisters when the composer unmounts", () => {
      const unsubscribe = vi.fn();
      onSpokenSendMock.mockReturnValue(unsubscribe);
      const { unmount } = renderWaitSubmit();

      unmount();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  it("stops the session, sends, and clears the submitting flag", async () => {
    const { result } = renderWaitSubmit();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  // A press during the wait has to count against the hand-back (#14692).
  it("claims the keyboard's hand-back before locking the editor, and sends with it", async () => {
    let resolveStop!: () => void;
    stopMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        })
    );
    const editable = new Compartment();
    const view = new EditorView({
      state: EditorState.create({ extensions: [editable.of(EditorView.editable.of(true))] }),
    });
    const handBack = vi.fn();
    let editableAtClaim: boolean | undefined;
    const claimSendHandBack = vi.fn(() => {
      editableAtClaim = view.state.facet(EditorView.editable);
      return handBack;
    });
    const { result } = renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: PANEL_ID,
        editorViewRef: { current: view },
        editableCompartmentRef: { current: editable },
        sendFromEditor,
        claimSendHandBack,
      })
    );

    act(() => {
      result.current.startVoiceWaitSubmit();
    });
    expect(claimSendHandBack).toHaveBeenCalledTimes(1);
    expect(editableAtClaim).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(sendFromEditor).not.toHaveBeenCalled();

    await act(async () => {
      resolveStop();
    });

    expect(sendFromEditor).toHaveBeenCalledWith(
      handBack,
      expect.objectContaining({ kept: "" }),
      undefined
    );
    expect(claimSendHandBack).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("sends by the route taken at the press, once, and the next wait by none", async () => {
    let resolveStop!: () => void;
    stopMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        })
    );
    const route = { submitText: vi.fn(async () => true), sendEnter: vi.fn() };
    const { result } = renderWaitSubmit();

    act(() => {
      result.current.startVoiceWaitSubmit({ route });
    });
    expect(sendFromEditor).not.toHaveBeenCalled();
    await act(async () => {
      resolveStop();
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(sendFromEditor).toHaveBeenLastCalledWith(undefined, expect.anything(), route);

    stopMock.mockResolvedValue(undefined);
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(2);
    expect(sendFromEditor).toHaveBeenLastCalledWith(undefined, expect.anything(), undefined);
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

  it("hands the progress the cleanup's own start as well as its landing", async () => {
    hasPendingMock.mockReturnValue(true);
    waitMock.mockImplementation(() => new Promise<boolean>(() => {}));
    landingMock.mockReturnValue({ startedAt: 1_000, landsAt: 3_000 });

    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    expect(result.current.voiceSubmitWait).toMatchObject({
      phase: "polishing",
      beganAt: 1_000,
      expectedAt: 3_000,
    });
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

    expect(sendSessionsMock).toHaveBeenCalledWith(PANEL_ID, undefined);
    expect(hasPendingMock).toHaveBeenCalledWith(PANEL_ID, OWNED);
    expect(landingMock).toHaveBeenCalledWith(PANEL_ID, OWNED);
    expect(waitMock).toHaveBeenCalledWith(PANEL_ID, expect.any(AbortSignal), OWNED);
    expect(result.current.voiceSubmitPhase).toBe("polishing");
    expect(sendFromEditor).not.toHaveBeenCalled();

    await act(async () => {
      finishCorrection(true);
    });

    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("says the cleanup failed when a pass it followed did, and lets the passes go", async () => {
    const release = vi.fn();
    observeMock.mockReturnValueOnce({ failed: () => true, release });

    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    expect(observeMock).toHaveBeenLastCalledWith(PANEL_ID, OWNED);
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(result.current.voiceSubmitOutcome).toEqual({
      kind: "sent",
      attempt: 1,
      cleanup: "failed",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the cleanup's word through a handover, and leaves it off a send held back", async () => {
    observeMock.mockReturnValue({ failed: () => true, release: () => {} });
    let handOver!: (taken: boolean) => void;
    const send = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          handOver = resolve;
        })
      )
      .mockReturnValueOnce(false);
    const { result } = renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: PANEL_ID,
        editorViewRef: { current: null },
        editableCompartmentRef: { current: new Compartment() },
        sendFromEditor: send,
      })
    );

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(result.current.voiceSubmitOutcome).toEqual({
      kind: "sending",
      attempt: 1,
      cleanup: "failed",
    });
    await act(async () => {
      handOver(true);
    });
    expect(result.current.voiceSubmitOutcome).toEqual({
      kind: "sent",
      attempt: 1,
      cleanup: "failed",
    });

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(result.current.voiceSubmitOutcome).toEqual({ kind: "held", attempt: 2 });
  });

  it.each(["refused", "rejected"] as const)(
    "leaves the cleanup's word off a handover that was %s",
    async (how) => {
      observeMock.mockReturnValue({ failed: () => true, release: () => {} });
      let refuse!: () => void;
      const handover = new Promise<boolean>((resolve, reject) => {
        refuse = how === "refused" ? () => resolve(false) : () => reject(new Error("no host"));
      });
      const { result } = renderHook(() =>
        useVoiceWaitSubmit({
          terminalId: PANEL_ID,
          editorViewRef: { current: null },
          editableCompartmentRef: { current: new Compartment() },
          sendFromEditor: () => handover,
        })
      );

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });
      expect(result.current.voiceSubmitOutcome?.kind).toBe("sending");
      await act(async () => {
        refuse();
      });
      expect(result.current.voiceSubmitOutcome).toEqual({ kind: "held", attempt: 1 });
    }
  );

  it("leaves the correction to land when Escape cancels the wait for it", async () => {
    const release = vi.fn();
    observeMock.mockReturnValueOnce({ failed: () => false, release });
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
    // At Escape, not once the wait it abandoned settles.
    expect(release).toHaveBeenCalled();

    await act(async () => {
      finishCorrection(true);
    });

    expect(sendFromEditor).not.toHaveBeenCalled();
  });

  it("still sends once its cleanup lands when the composer unmounts mid-wait (#15510)", async () => {
    let finishCorrection!: (landed: boolean) => void;
    hasPendingMock.mockReturnValue(true);
    waitMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishCorrection = resolve;
        })
    );
    useTerminalInputStore.getState().setDraftInput(PANEL_ID, "fix the login bug");
    const handBack = vi.fn();
    const atEnter = { imagePaths: ["/tmp/shot.png"], fanOut: true };
    const captureDeparture = vi.fn(() => atEnter);

    const { result, unmount } = renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: PANEL_ID,
        editorViewRef: { current: null },
        editableCompartmentRef: { current: new Compartment() },
        sendFromEditor,
        claimSendHandBack: () => handBack,
        captureDeparture,
      })
    );
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(captureDeparture).toHaveBeenCalledTimes(1);
    unmount();
    expect(waitMock.mock.calls[0]![1]!.aborted).toBe(false);
    // Still waiting: another composer for this draft can't start a second send.
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(true);
    expect(sendFromEditor).not.toHaveBeenCalled();

    hasPendingMock.mockReturnValue(false);
    await act(async () => {
      finishCorrection(true);
    });

    // Through the departed composer, from the store, and with no hand-back
    // to a composer that is gone.
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    const [sentHandBack, voiceSend, route, departed] = sendFromEditor.mock.calls[0] as unknown[];
    expect(sentHandBack).not.toBe(handBack);
    expect(voiceSend).toMatchObject({ draft: "fix the login bug", text: "fix the login bug" });
    expect(route).toBeUndefined();
    // As the composer had it at Enter, not as anything reads after it left.
    expect(departed).toBe(atEnter);
    expect(captureDeparture).toHaveBeenCalledTimes(1);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("still sends as dictated when the cleanup fails after the composer unmounted", async () => {
    let finishCorrection!: (landed: boolean) => void;
    hasPendingMock.mockReturnValue(true);
    observeMock.mockReturnValueOnce({ failed: () => true, release: () => {} });
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
    hasPendingMock.mockReturnValue(false);
    await act(async () => {
      finishCorrection(false);
    });

    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("sends each of several replies whose composers left mid-wait to its own draft, once (#15510)", async () => {
    const pending = new Set<string>();
    const land = new Map<string, (landed: boolean) => void>();
    hasPendingMock.mockImplementation((panelId: string) => pending.has(panelId));
    waitMock.mockImplementation(
      (panelId: string) =>
        new Promise<boolean>((resolve) => {
          land.set(panelId, (landed) => {
            pending.delete(panelId);
            resolve(landed);
          });
        })
    );
    const replies = ["run-1", "run-2", "run-3"].map((runId) => ({
      runId,
      voiceId: `canopy-reply:${runId}`,
      send: vi.fn<() => void>(),
    }));

    for (const reply of replies) {
      // Its composer's own scope, as an isolated reply keeps it.
      useTerminalInputStore
        .getState()
        .setDraftInput(reply.runId, `reply to ${reply.runId}`, "canopy-reply");
      pending.add(reply.voiceId);
      const { result, unmount } = renderHook(() =>
        useVoiceWaitSubmit({
          terminalId: reply.runId,
          projectId: "canopy-reply",
          voice: { panelId: reply.voiceId, projectId: undefined },
          editorViewRef: { current: null },
          editableCompartmentRef: { current: new Compartment() },
          sendFromEditor: reply.send,
        })
      );
      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });
      unmount();
    }

    for (const voiceId of ["canopy-reply:run-3", "canopy-reply:run-1", "canopy-reply:run-2"]) {
      await act(async () => {
        land.get(voiceId)!(true);
      });
    }

    for (const reply of replies) {
      expect(reply.send).toHaveBeenCalledTimes(1);
      expect((reply.send.mock.calls[0] as unknown[])[1]).toMatchObject({
        text: `reply to ${reply.runId}`,
      });
      expect(useTerminalInputStore.getState().isVoiceSubmitting(reply.voiceId)).toBe(false);
    }
  });

  it("keeps a send Escape called off unsent after the composer unmounts", async () => {
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
    act(() => {
      result.current.cancelVoiceWaitSubmit();
    });
    unmount();
    await act(async () => {
      finishCorrection(true);
    });

    expect(sendFromEditor).not.toHaveBeenCalled();
  });

  it("clears its status when the composer moves to another terminal mid-wait", async () => {
    hasPendingMock.mockReturnValue(true);
    waitMock.mockImplementation(() => new Promise<boolean>(() => {}));

    const { result, rerender } = renderHook(
      ({ terminalId }: { terminalId: string }) =>
        useVoiceWaitSubmit({
          terminalId,
          editorViewRef: { current: null },
          editableCompartmentRef: { current: new Compartment() },
          sendFromEditor,
        }),
      { initialProps: { terminalId: PANEL_ID } }
    );
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(result.current.voiceSubmitPhase).toBe("polishing");

    rerender({ terminalId: "other-panel" });

    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
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

describe("useVoiceWaitSubmit keys during the wait (#14780)", () => {
  let sendFromEditor: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    useTerminalInputStore.setState({ voiceSubmittingPanels: new Set() });
    sendFromEditor = vi.fn<() => void>();
    stopMock.mockReset();
    stopMock.mockResolvedValue(undefined);
    hasPendingMock.mockReset();
    hasPendingMock.mockReturnValue(true);
    observeMock.mockReset();
    observeMock.mockReturnValue({ failed: () => false, release: () => {} });
    waitMock.mockReset();
    // A cleanup that never lands on its own: only the wait's signal ends it.
    waitMock.mockImplementation(
      (_panelId, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener("abort", () => resolve(false), { once: true });
        })
    );
    onSpokenSendMock.mockReset();
    onSpokenSendMock.mockReturnValue(() => {});
    panelState.focusedId = null;
    (document.activeElement as HTMLElement | null)?.blur();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  function renderWaitSubmit(
    terminalId = PANEL_ID,
    send: Parameters<typeof useVoiceWaitSubmit>[0]["sendFromEditor"] = sendFromEditor
  ) {
    return renderHook(() =>
      useVoiceWaitSubmit({
        terminalId,
        editorViewRef: { current: null },
        editableCompartmentRef: { current: new Compartment() },
        sendFromEditor: send,
      })
    );
  }

  // The lock blurs the editor, so a key during the wait reaches the page.
  function pressKey(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("sends what stands at a second Enter while the cleanup is on its way", async () => {
    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(result.current.voiceSubmitPhase).toBe("polishing");
    const signal = waitMock.mock.calls[0]![1]!;

    let event!: KeyboardEvent;
    await act(async () => {
      event = pressKey("Enter");
    });

    expect(event.defaultPrevented).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
    expect(result.current.voiceSubmitOutcome).toEqual({
      kind: "sent",
      attempt: 1,
      cleanup: "skipped",
    });
  });

  it("skips the cleanup wait once the transcript drains after a second Enter", async () => {
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
    expect(result.current.voiceSubmitPhase).toBe("finishing");

    await act(async () => {
      pressKey("Enter");
    });
    // The words still on their way are part of what stands.
    expect(sendFromEditor).not.toHaveBeenCalled();

    await act(async () => {
      resolveStop();
    });
    expect(waitMock).not.toHaveBeenCalled();
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(result.current.voiceSubmitOutcome?.cleanup).toBe("skipped");
  });

  it("says a send that dropped a cleanup still on its way skipped it, whatever else failed", async () => {
    observeMock.mockReturnValue({ failed: () => true, release: () => {} });
    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      pressKey("Enter");
    });

    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(result.current.voiceSubmitOutcome?.cleanup).toBe("skipped");
  });

  it("says nothing of a cleanup that landed between a second Enter and the send", async () => {
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
    await act(async () => {
      pressKey("Enter");
    });

    hasPendingMock.mockReturnValue(false);
    await act(async () => {
      resolveStop();
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(result.current.voiceSubmitOutcome).toEqual({ kind: "sent", attempt: 1 });
  });

  it("keeps the route the wait was started with through a second Enter, and drops it at Escape", async () => {
    const route = { submitText: vi.fn(async () => true), sendEnter: vi.fn() };
    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit({ route });
    });
    await act(async () => {
      pressKey("Enter");
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(sendFromEditor).toHaveBeenLastCalledWith(undefined, expect.anything(), route);

    await act(async () => {
      result.current.startVoiceWaitSubmit({ route });
    });
    act(() => {
      pressKey("Escape");
    });
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      pressKey("Enter");
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(2);
    expect(sendFromEditor).toHaveBeenLastCalledWith(undefined, expect.anything(), undefined);
  });

  it("calls the send off at Escape and lets go of the keys at once", async () => {
    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    const signal = waitMock.mock.calls[0]![1]!;

    let afterwards!: KeyboardEvent;
    act(() => {
      pressKey("Escape");
      // Before the parked wait has had a turn to end.
      afterwards = pressKey("Enter");
    });

    expect(signal.aborted).toBe(true);
    expect(afterwards.defaultPrevented).toBe(false);
    await act(async () => {});
    expect(sendFromEditor).not.toHaveBeenCalled();
    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("leaves Enter alone with the keyboard elsewhere, with a modifier, or held down", async () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    const ignored = [
      pressKey("Enter", {}, field),
      pressKey("Enter", { shiftKey: true }),
      pressKey("Enter", { metaKey: true }),
      pressKey("Enter", { isComposing: true }),
    ];
    // The Enter that started the wait, held down: swallowed, never a second press.
    const held = pressKey("Enter", { repeat: true });
    await act(async () => {});

    expect(ignored.map((event) => event.defaultPrevented)).toEqual([false, false, false, false]);
    expect(held.defaultPrevented).toBe(true);
    expect(sendFromEditor).not.toHaveBeenCalled();
    expect(result.current.voiceSubmitPhase).toBe("polishing");
  });

  it("leaves a key in another pane's bar to that pane", async () => {
    const bar = document.createElement("div");
    bar.setAttribute("data-hybrid-input-root", "other-panel");
    const button = document.createElement("button");
    bar.appendChild(button);
    document.body.appendChild(bar);
    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    let event!: KeyboardEvent;
    await act(async () => {
      event = pressKey("Enter", {}, button);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(sendFromEditor).not.toHaveBeenCalled();
  });

  it("takes a key in its own editor, and a page key while a modal hosts that editor", async () => {
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    const compartment = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: compartment.of(EditorView.editable.of(true)),
      }),
      parent: modal,
    });
    const sendOther = vi.fn<() => void>();
    const mine = renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: PANEL_ID,
        editorViewRef: { current: view },
        editableCompartmentRef: { current: compartment },
        sendFromEditor,
      })
    );
    // Another pane is waiting too, and it is the selected one.
    const theirs = renderWaitSubmit("other-panel", sendOther);
    panelState.focusedId = "other-panel";
    try {
      await act(async () => {
        mine.result.current.startVoiceWaitSubmit();
        theirs.result.current.startVoiceWaitSubmit();
      });

      await act(async () => {
        pressKey("Enter");
      });
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
      expect(sendOther).not.toHaveBeenCalled();

      await act(async () => {
        mine.result.current.startVoiceWaitSubmit();
      });
      await act(async () => {
        pressKey("Enter", {}, view.contentDOM);
      });
      expect(sendFromEditor).toHaveBeenCalledTimes(2);
      expect(sendOther).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("takes a key in its own bar, wherever the page's selection is", async () => {
    const bar = document.createElement("div");
    bar.setAttribute("data-hybrid-input-root", PANEL_ID);
    const button = document.createElement("button");
    bar.appendChild(button);
    document.body.appendChild(bar);
    const sendOther = vi.fn<() => void>();
    const { result } = renderWaitSubmit();
    const theirs = renderWaitSubmit("other-panel", sendOther);
    panelState.focusedId = "other-panel";
    await act(async () => {
      result.current.startVoiceWaitSubmit();
      theirs.result.current.startVoiceWaitSubmit();
    });

    await act(async () => {
      pressKey("Enter", {}, button);
    });

    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(sendOther).not.toHaveBeenCalled();
  });

  it("lets go of Enter and Escape once its send has gone", async () => {
    const { result } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      pressKey("Enter");
    });
    expect(sendFromEditor).toHaveBeenCalledTimes(1);

    const after = [pressKey("Enter"), pressKey("Escape")];
    expect(after.map((event) => event.defaultPrevented)).toEqual([false, false]);
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
  });

  it("lets go of them when the composer unmounts mid-wait, and the send waits on", async () => {
    const { result, unmount } = renderWaitSubmit();
    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    const signal = waitMock.mock.calls[0]![1]!;
    unmount();

    expect(pressKey("Enter").defaultPrevented).toBe(false);
    expect(pressKey("Escape").defaultPrevented).toBe(false);
    await act(async () => {});
    expect(signal.aborted).toBe(false);
    expect(sendFromEditor).not.toHaveBeenCalled();
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(true);
  });

  it("keeps the first departed composer's send when the one that took the wait over leaves too", async () => {
    const sendFirst = vi.fn<() => void>();
    const first = renderWaitSubmit(PANEL_ID, sendFirst);
    await act(async () => {
      first.result.current.startVoiceWaitSubmit();
    });
    first.unmount();
    // A composer for a later incarnation of the same run takes the wait over, and leaves.
    const sendLater = vi.fn<() => void>();
    renderWaitSubmit(PANEL_ID, sendLater).unmount();

    const third = renderWaitSubmit(PANEL_ID, vi.fn<() => void>());
    await act(async () => {
      pressKey("Enter");
    });

    expect(sendLater).not.toHaveBeenCalled();
    expect(sendFirst).toHaveBeenCalledTimes(1);
    expect(third.result.current.voiceSubmitOutcome?.kind).toBe("sent");
  });

  it("hands a wait to the composer that mounts for its draft, whose Escape calls it off", async () => {
    const first = renderWaitSubmit();
    await act(async () => {
      first.result.current.startVoiceWaitSubmit();
    });
    const signal = waitMock.mock.calls[0]![1]!;
    first.unmount();

    const sendAgain = vi.fn<() => void>();
    const again = renderWaitSubmit(PANEL_ID, sendAgain);
    expect(again.result.current.voiceSubmitPhase).toBe("polishing");

    let event!: KeyboardEvent;
    await act(async () => {
      event = pressKey("Escape");
    });

    expect(event.defaultPrevented).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(again.result.current.voiceSubmitPhase).toBeNull();
    expect(again.result.current.voiceSubmitOutcome?.kind).toBe("cancelled");
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
    expect(sendFromEditor).not.toHaveBeenCalled();
    expect(sendAgain).not.toHaveBeenCalled();
  });

  it("sends what stands at the second Enter of the composer that took the wait over, as the one that left would", async () => {
    let accept!: (taken: boolean) => void;
    const sendFirst = vi.fn(
      (..._args: unknown[]) =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        })
    );
    const first = renderWaitSubmit(PANEL_ID, sendFirst);
    await act(async () => {
      first.result.current.startVoiceWaitSubmit();
    });
    first.unmount();

    const sendAgain = vi.fn<() => void>();
    const again = renderWaitSubmit(PANEL_ID, sendAgain);
    await act(async () => {
      pressKey("Enter");
    });

    // Through the departed composer's send: this one's editor never held its
    // chips, and its terminal may not take input yet.
    expect(sendAgain).not.toHaveBeenCalled();
    expect(sendFirst).toHaveBeenCalledTimes(1);
    expect(sendFirst.mock.calls[0]).toHaveLength(4);
    expect(again.result.current.voiceSubmitPhase).toBeNull();
    expect(again.result.current.voiceSubmitOutcome).toMatchObject({ kind: "sending" });

    // Its outcome settles in the composer showing it.
    await act(async () => {
      accept(true);
    });
    expect(again.result.current.voiceSubmitOutcome?.kind).toBe("sent");
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("gives a page Enter to the selected pane's composer when two are waiting", async () => {
    const sendOther = vi.fn<() => void>();
    const first = renderWaitSubmit();
    const second = renderWaitSubmit("other-panel", sendOther);
    await act(async () => {
      first.result.current.startVoiceWaitSubmit();
      second.result.current.startVoiceWaitSubmit();
    });
    expect(first.result.current.voiceSubmitPhase).toBe("polishing");
    expect(second.result.current.voiceSubmitPhase).toBe("polishing");

    // Neither selected: the key is nobody's.
    let unclaimed!: KeyboardEvent;
    await act(async () => {
      unclaimed = pressKey("Enter");
    });
    expect(unclaimed.defaultPrevented).toBe(false);

    panelState.focusedId = "other-panel";
    await act(async () => {
      pressKey("Enter");
    });

    expect(sendOther).toHaveBeenCalledTimes(1);
    expect(sendFromEditor).not.toHaveBeenCalled();
    expect(first.result.current.voiceSubmitPhase).toBe("polishing");
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
    panelState.focusedId = null;
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
    expect(sendSessionsMock).toHaveBeenCalledWith("other-panel", undefined);
    expect(waitMock).toHaveBeenCalledWith("other-panel", expect.any(AbortSignal), OWNED);
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
