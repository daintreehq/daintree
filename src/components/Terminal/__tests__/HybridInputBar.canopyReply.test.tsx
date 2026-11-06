// @vitest-environment jsdom
/**
 * Canopy's reply and the grid pane's composer type to the same terminal, each
 * with its own dictation (#14777): what one dictates, sends or cancels never
 * reaches the other's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore, type VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { canopyReplyVoiceId } from "@/services/canopyReplyDictation";
import {
  recordCorrectionLanded,
  takeLandedCorrection,
  writeComposerDraftThrough,
} from "@/services/voiceCorrectionLanding";
import { isolatedComposerScope } from "@/lib/draftKey";
import { HybridInputBar, type HybridInputBarHandle } from "../HybridInputBar";
import { correctionReviewField } from "../inputEditorExtensions/correctionReview";
import { createRef } from "react";

const WT_ID = "/repo/wt";

const REPLY: VoiceRecordingTarget = {
  panelId: canopyReplyVoiceId("term-1"),
  panelTitle: "Reply to claude",
  surface: "canopy-reply",
  terminalId: "term-1",
};
const PANE: VoiceRecordingTarget = { panelId: "term-1", panelTitle: "claude" };

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
});

beforeEach(() => {
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panel = {
    id: "term-1",
    title: "claude",
    kind: "terminal",
    cwd: WT_ID,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    detectedAgentId: "claude",
    launchAgentId: "claude",
    agentState: "waiting",
    runtimeStatus: "running",
  } as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
    panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
    focusedId: panel.id,
  });
  useTerminalInputStore.setState({ draftInputs: new Map() });
  takeLandedCorrection("term-1", undefined, "");
  takeLandedCorrection(REPLY.panelId, undefined, "");
  useVoiceRecordingStore.setState({
    panelBuffers: {},
    status: "idle",
    activeTarget: null,
    pendingTarget: null,
    micSignal: "pending",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useVoiceRecordingStore.setState({ status: "idle", activeTarget: null, micSignal: "pending" });
});

async function mountBoth(onPaneSend = vi.fn(), onReplySend = vi.fn()) {
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <div data-testid="pane">
          <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onPaneSend} />
        </div>
        <div data-testid="reply">
          <HybridInputBar
            isolated
            terminalId="term-1"
            cwd=""
            agentId="claude"
            onSend={onReplySend}
            voiceTarget={REPLY}
          />
        </div>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const surface = (testId: string) => {
    const root = result.getByTestId(testId);
    return {
      root,
      view: EditorView.findFromDOM(root.querySelector<HTMLElement>(".cm-editor")!)!,
      mic: root.querySelector('button[aria-label*="voice"]'),
      listening: root.querySelector('[data-voice-active="true"]') !== null,
    };
  };
  return { ...result, surface };
}

function dictating(target: VoiceRecordingTarget) {
  act(() => {
    useVoiceRecordingStore.setState({
      status: "recording",
      activeTarget: target,
      micSignal: "live",
    });
  });
}

/** A correction swapped into `target`'s draft, as the voice service lands one. */
async function landCorrectionIn(target: VoiceRecordingTarget, sessionId: string) {
  await act(async () => {
    const voice = useVoiceRecordingStore.getState();
    voice.beginSession(target, sessionId);
    voice.finishSession();
    const inputs = useTerminalInputStore.getState();
    inputs.setDraftInput(target.panelId, "Open the Zustand store.");
    recordCorrectionLanded(target.panelId, undefined, {
      from: 0,
      rawText: "open the zoo stand store",
      correctedText: "Open the Zustand store.",
      baseline: null,
      sessionId,
    });
    inputs.bumpExternalDraftRevision({ keepsSelection: true });
  });
}

async function sendFrom(view: EditorView, text: string) {
  await act(async () => {
    view.dispatch({ changes: { from: 0, insert: text }, userEvent: "input.type" });
  });
  await act(async () => {
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
  });
}

describe("HybridInputBar — Canopy's reply beside the pane's own composer", () => {
  it("offers the reply a mic of its own, and a plain isolated composer none", async () => {
    const { surface } = await mountBoth();
    expect(surface("reply").mic).not.toBeNull();
    cleanup();

    const plain = render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar isolated terminalId="term-1" cwd="" agentId="claude" onSend={() => {}} />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    expect(plain.container.querySelector('button[aria-label*="voice"]')).toBeNull();
  });

  it("listens in the reply alone while the reply is dictated into, and in the pane alone for the pane", async () => {
    const { surface } = await mountBoth();

    dictating(REPLY);
    expect(surface("reply").listening).toBe(true);
    expect(surface("pane").listening).toBe(false);

    dictating(PANE);
    expect(surface("reply").listening).toBe(false);
    expect(surface("pane").listening).toBe(true);
  });

  it("ends each composer's correction review only when its own next dictation begins (#14875)", async () => {
    const { surface } = await mountBoth();
    const restore = (testId: string) =>
      surface(testId).view.state.field(correctionReviewField, false) != null;
    await landCorrectionIn(PANE, "pane-1");
    await landCorrectionIn(REPLY, "reply-1");
    expect([restore("pane"), restore("reply")]).toEqual([true, true]);

    await act(async () => useVoiceRecordingStore.getState().beginSession(PANE, "pane-2"));
    expect([restore("pane"), restore("reply")]).toEqual([false, true]);

    await act(async () => useVoiceRecordingStore.getState().beginSession(REPLY, "reply-2"));
    expect([restore("pane"), restore("reply")]).toEqual([false, false]);
  });

  it("shows what the voice service writes under the reply's id in the reply, never in the pane", async () => {
    const { surface } = await mountBoth();

    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput(REPLY.panelId, "dictated reply");
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
    });

    expect(surface("reply").view.state.doc.toString()).toBe("dictated reply");
    expect(surface("pane").view.state.doc.toString()).toBe("");
    // The address the reply already kept its draft under, so none is lost.
    expect(useTerminalInputStore.getState().getDraftInput("term-1", isolatedComposerScope())).toBe(
      "dictated reply"
    );
  });

  it("leaves the reply's dictation running when the pane's own composer sends", async () => {
    const stop = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    const discard = vi.spyOn(voiceRecordingService, "discardPendingCorrections");
    const onPaneSend = vi.fn();
    const { surface } = await mountBoth(onPaneSend);
    dictating(REPLY);

    await sendFrom(surface("pane").view, "ship it");

    expect(onPaneSend).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(discard.mock.calls.map(([panelId]) => panelId)).toEqual(["term-1"]);
    expect(surface("reply").listening).toBe(true);
  });

  it("leaves the pane's dictation running when the reply sends", async () => {
    const stop = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    const discard = vi.spyOn(voiceRecordingService, "discardPendingCorrections");
    const onReplySend = vi.fn();
    const { surface } = await mountBoth(vi.fn(), onReplySend);
    dictating(PANE);

    await sendFrom(surface("reply").view, "reply text");

    expect(onReplySend).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(discard.mock.calls.map(([panelId]) => panelId)).toEqual([REPLY.panelId]);
  });

  it("leaves the pane's dictation running when Escape is pressed in the reply", async () => {
    const stop = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    const { surface } = await mountBoth();
    dictating(PANE);

    const content = surface("reply").root.querySelector<HTMLElement>(".cm-content")!;
    content.focus();
    act(() => {
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });

    expect(stop).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().activeTarget?.panelId).toBe("term-1");
    expect(useVoiceRecordingStore.getState().status).toBe("recording");
    expect(surface("pane").listening).toBe(true);
  });

  it("finishes the reply's own dictation before its send goes", async () => {
    let finish!: () => void;
    const stop = vi.spyOn(voiceRecordingService, "stop").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const onReplySend = vi.fn();
    const { surface } = await mountBoth(vi.fn(), onReplySend);
    dictating(REPLY);

    await sendFrom(surface("reply").view, "reply text");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onReplySend).not.toHaveBeenCalled();

    await act(async () => finish());
    expect(onReplySend).toHaveBeenCalledTimes(1);
  });

  it("sends on ⌘↩ by the reply's route, a dictated send after its wait, and leaves the pane's composer alone", async () => {
    let finish!: () => void;
    vi.spyOn(voiceRecordingService, "stop").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const routed = vi.fn(async (_text: string, _imagePaths: readonly string[]) => true);
    const submitText = vi.fn(async (_text: string, _imagePaths: readonly string[]) => true);
    const onPaneSend = vi.fn();
    const { getByTestId } = render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <div data-testid="pane">
            <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onPaneSend} />
          </div>
          <div data-testid="reply">
            <HybridInputBar
              isolated
              terminalId="term-1"
              cwd=""
              agentId="claude"
              onSend={() => {}}
              submitText={submitText}
              voiceTarget={REPLY}
              modEnterSend={() => ({ submitText: routed, sendEnter: vi.fn() })}
            />
          </div>
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    const viewOf = (testId: string) =>
      EditorView.findFromDOM(getByTestId(testId).querySelector<HTMLElement>(".cm-editor")!)!;
    const isMac = /Mac/.test(navigator.platform);
    const modEnter = async (view: EditorView, text: string) => {
      await act(async () => {
        view.dispatch({ changes: { from: 0, insert: text }, userEvent: "input.type" });
      });
      await act(async () => {
        runScopeHandlers(
          view,
          new KeyboardEvent("keydown", { key: "Enter", metaKey: isMac, ctrlKey: !isMac }),
          "editor"
        );
      });
    };

    routed.mockResolvedValueOnce(false);
    await modEnter(viewOf("reply"), "refused");
    expect(routed).toHaveBeenCalledWith("refused", []);
    // Refused, the reply keeps what was typed, as a refused Enter does.
    expect(viewOf("reply").state.doc.toString()).toBe("refused");
    await act(async () => {
      viewOf("reply").dispatch({ changes: { from: 0, to: viewOf("reply").state.doc.length } });
    });

    await modEnter(viewOf("reply"), "go on");
    expect(routed).toHaveBeenLastCalledWith("go on", []);
    expect(submitText).not.toHaveBeenCalled();
    expect(viewOf("reply").state.doc.toString()).toBe("");

    dictating(REPLY);
    await modEnter(viewOf("reply"), "then the next");
    expect(routed).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    expect(routed).toHaveBeenLastCalledWith("then the next", []);
    expect(submitText).not.toHaveBeenCalled();

    await modEnter(viewOf("pane"), "not sent");
    expect(onPaneSend).not.toHaveBeenCalled();
    expect(viewOf("pane").state.doc.toString()).toBe("not sent");
  });

  it("keeps the dictation key with the reply once it is expanded out of Canopy's pane", async () => {
    const { surface } = await mountBoth();
    const { view } = surface("reply");
    const isMac = /Mac/.test(navigator.platform);
    await act(async () => {
      runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "e", shiftKey: true, metaKey: isMac, ctrlKey: !isMac }),
        "editor"
      );
    });

    await vi.waitFor(() => {
      const host = view.dom.parentElement;
      expect(host?.closest('[data-testid="reply"]')).toBeNull();
      expect(host?.closest("[data-keybindings-isolated]")).not.toBeNull();
      expect(host?.closest("[data-dictation-owner]")).not.toBeNull();
    });
  });

  it("puts the caret at the end of a draft the reply hasn't shown a caret in, for dictation", async () => {
    useTerminalInputStore
      .getState()
      .setDraftInput("term-1", "Context first:", isolatedComposerScope());
    const ref = createRef<HybridInputBarHandle>();
    const { container } = render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar
            ref={ref}
            isolated
            terminalId="term-1"
            cwd=""
            agentId="claude"
            onSend={() => {}}
            voiceTarget={REPLY}
          />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(view.state.doc.toString()).toBe("Context first:");

    act(() => ref.current!.focusForDictation());

    expect(view.contentDOM.contains(document.activeElement)).toBe(true);
    expect(view.state.selection.main.head).toBe("Context first:".length);
  });

  it("offers Escape in the reply to the reply's dictation, not the pane's", async () => {
    const handleEscape = vi.spyOn(voiceRecordingService, "handleEscape").mockReturnValue(true);
    const onSendKey = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar
            isolated
            terminalId="term-1"
            cwd=""
            agentId="claude"
            onSend={() => {}}
            onSendKey={onSendKey}
            voiceTarget={REPLY}
          />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    const content = container.querySelector<HTMLElement>(".cm-content")!;
    content.focus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      content.dispatchEvent(event);
    });

    expect(handleEscape).toHaveBeenCalledWith(REPLY.panelId);
    expect(onSendKey).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("places a correction in the reply's typing the store hasn't caught up with, and leaves the pane's alone (#15873)", async () => {
    const { surface } = await mountBoth();
    const reply = surface("reply").view;
    const pane = surface("pane").view;
    const RAW = "open the zoo stand store";
    const FIXED = "Open the Zustand store.";
    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput(REPLY.panelId, RAW);
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
    });

    // Typing in both composers is a render from the store when the reply's correction lands.
    await act(async () => {
      reply.dispatch({
        changes: { from: 0, insert: "/review " },
        selection: { anchor: "/review ".length },
        userEvent: "input.type",
      });
      pane.dispatch({ changes: { from: 0, insert: "pane text" }, userEvent: "input.type" });
      writeComposerDraftThrough(REPLY.panelId, undefined);
      const inputs = useTerminalInputStore.getState();
      const before = inputs.getDraftInput(REPLY.panelId);
      expect(before).toBe("/review " + RAW);
      expect(inputs.getDraftInput("term-1")).toBe("");
      const from = "/review ".length;
      const after = "/review " + FIXED;
      inputs.setDraftInput(REPLY.panelId, after);
      recordCorrectionLanded(REPLY.panelId, undefined, {
        from,
        rawText: RAW,
        correctedText: FIXED,
        baseline: null,
        sessionId: "reply-session",
        write: { before, after, changes: [{ from, to: before.length, insert: FIXED }] },
      });
      inputs.bumpExternalDraftRevision({ keepsSelection: true });
    });

    expect(reply.state.doc.toString()).toBe("/review " + FIXED);
    expect(useTerminalInputStore.getState().getDraftInput(REPLY.panelId)).toBe("/review " + FIXED);
    expect(pane.state.doc.toString()).toBe("pane text");
    expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe("pane text");
  });
});
