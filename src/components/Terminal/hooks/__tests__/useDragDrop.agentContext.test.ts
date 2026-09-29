// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import type { PluginSendToAgentRefusalReason } from "@shared/types/plugin";

// See useDragDrop.test.ts: both modules build app singletons at import time.
vi.mock("../../useTerminalFileTransfer", () => ({
  IMAGE_EXTENSIONS: /\.(png|jpe?g|bmp|tiff?|avif|heic)$/i,
}));
const setPreferredTerminalFocusTarget = vi.hoisted(() => vi.fn<(target: string) => void>());
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ setPreferredTerminalFocusTarget }) },
}));

// The draft path is its own suite (agentDraft.test.ts); here it is the seam the
// drop routes through, so the question is only what reaches it and when.
const { draftAgentContext, getDraftRefusal } = vi.hoisted(() => ({
  draftAgentContext: vi.fn(),
  getDraftRefusal: vi.fn<(terminalId: string) => PluginSendToAgentRefusalReason | null>(),
}));
vi.mock("@/services/agentHandoff/agentDraft", () => ({ draftAgentContext, getDraftRefusal }));

const { useDragDrop } = await import("../useDragDrop");
const { AGENT_CONTEXT_DRAG_MIME, encodeAgentContextDragPayload } =
  await import("@shared/utils/agentContextDrag");

const TERMINAL_ID = "agent-1";

function fakeView() {
  const dispatch = vi.fn();
  const focus = vi.fn();
  const view = {
    state: { selection: { main: { head: 0 } }, doc: { sliceString: () => "" } },
    dispatch,
    focus,
  } as unknown as EditorView;
  return { dispatch, focus, ref: { current: view } as React.RefObject<EditorView | null> };
}

function dragEvent(types: string[], serialized = ""): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      types,
      files: [],
      dropEffect: "none",
      getData: vi.fn((type: string) => (type === AGENT_CONTEXT_DRAG_MIME ? serialized : "")),
    },
  } as unknown as React.DragEvent;
}

function contextDrag(): React.DragEvent {
  return dragEvent(
    [AGENT_CONTEXT_DRAG_MIME, "text/plain"],
    encodeAgentContextDragPayload({
      v: 1,
      text: "Card body",
      title: "Fix login",
      source: { label: "Kanban" },
    })
  );
}

function render(terminalId: string | undefined) {
  const view = fakeView();
  const onDropSelect = vi.fn();
  const { result } = renderHook(() => useDragDrop(view.ref, "/repo", onDropSelect, terminalId));
  return { result, view, onDropSelect };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDraftRefusal.mockReturnValue(null);
  draftAgentContext.mockImplementation((terminalId: string) => ({
    status: "drafted",
    terminalId,
  }));
});

describe("useDragDrop — agent context", () => {
  it("lights up the file-drop affordance for a pane that can take the draft", () => {
    const { result } = render(TERMINAL_ID);
    const enter = dragEvent([AGENT_CONTEXT_DRAG_MIME, "text/plain"]);
    act(() => result.current.handleDragEnter(enter));
    const over = dragEvent([AGENT_CONTEXT_DRAG_MIME, "text/plain"]);
    act(() => result.current.handleDragOver(over));

    expect(result.current.isDragOverFiles).toBe(true);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("copy");
    expect(getDraftRefusal).toHaveBeenCalledWith(TERMINAL_ID);
  });

  it("refuses the drag outright where the draft would be refused", () => {
    getDraftRefusal.mockReturnValue("input-locked");
    const { result } = render(TERMINAL_ID);
    act(() => result.current.handleDragEnter(dragEvent([AGENT_CONTEXT_DRAG_MIME])));
    const over = dragEvent([AGENT_CONTEXT_DRAG_MIME]);
    act(() => result.current.handleDragOver(over));

    expect(result.current.isDragOverFiles).toBe(false);
    // Claimed and refused, so the contenteditable never pastes the raw text.
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("none");
  });

  it("judges a drag carrying files too by its agent context, as the drop does", () => {
    getDraftRefusal.mockReturnValue("input-locked");
    const { result } = render(TERMINAL_ID);
    const types = ["Files", AGENT_CONTEXT_DRAG_MIME, "text/plain"];
    act(() => result.current.handleDragEnter(dragEvent(types)));
    const over = dragEvent(types);
    act(() => result.current.handleDragOver(over));

    expect(result.current.isDragOverFiles).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe("none");
  });

  it("refuses it on a bar with no pane behind it (the Assistant)", () => {
    const { result } = render(undefined);
    const over = dragEvent([AGENT_CONTEXT_DRAG_MIME]);
    act(() => result.current.handleDragOver(over));
    expect(over.dataTransfer.dropEffect).toBe("none");
    expect(getDraftRefusal).not.toHaveBeenCalled();
  });

  it("drafts the decoded payload, then selects the pane and focuses the bar", async () => {
    const { result, view, onDropSelect } = render(TERMINAL_ID);
    await act(() => result.current.handleDrop(contextDrag()));

    expect(draftAgentContext).toHaveBeenCalledWith(TERMINAL_ID, {
      text: "Card body",
      title: "Fix login",
      sourceLabel: "Kanban",
    });
    expect(setPreferredTerminalFocusTarget).toHaveBeenCalledWith("hybridInput");
    expect(onDropSelect).toHaveBeenCalledTimes(1);
    expect(view.focus).toHaveBeenCalledTimes(1);
    // Nothing goes into the editor directly — the draft store owns the write,
    // and no Enter is ever sent.
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("leaves selection and focus alone when the draft is refused at drop time", async () => {
    draftAgentContext.mockReturnValue({ status: "refused", reason: "restarting" });
    const { result, view, onDropSelect } = render(TERMINAL_ID);
    await act(() => result.current.handleDrop(contextDrag()));

    expect(onDropSelect).not.toHaveBeenCalled();
    expect(view.focus).not.toHaveBeenCalled();
  });

  it("ignores a payload that fails validation", async () => {
    const { result, onDropSelect } = render(TERMINAL_ID);
    const forged = dragEvent([AGENT_CONTEXT_DRAG_MIME], JSON.stringify({ v: 1, text: "" }));
    await act(() => result.current.handleDrop(forged));

    expect(draftAgentContext).not.toHaveBeenCalled();
    expect(onDropSelect).not.toHaveBeenCalled();
  });
});
