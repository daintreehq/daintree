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
import { isolatedComposerScope } from "@/lib/draftKey";
import { HybridInputBar } from "../HybridInputBar";

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
    useVoiceRecordingStore.setState({ status: "recording", activeTarget: target, micSignal: "live" });
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
    expect(discard).toHaveBeenCalledWith("term-1");
    expect(discard).not.toHaveBeenCalledWith(REPLY.panelId);
    expect(surface("reply").listening).toBe(true);
  });

  it("finishes only its own dictation when the reply sends, never the pane's", async () => {
    const stop = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    const discard = vi.spyOn(voiceRecordingService, "discardPendingCorrections");
    const onReplySend = vi.fn();
    const { surface } = await mountBoth(vi.fn(), onReplySend);
    dictating(PANE);

    await sendFrom(surface("reply").view, "reply text");

    expect(onReplySend).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith(REPLY.panelId);
    expect(discard).not.toHaveBeenCalledWith("term-1");
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
});
