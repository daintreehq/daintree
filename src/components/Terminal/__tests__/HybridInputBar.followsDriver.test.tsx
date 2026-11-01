// @vitest-environment jsdom
/**
 * A view that watches while another screen drives shows the driver's draft in
 * each composer as the host reads it back (#13283). The bar is read-only then,
 * and never writes its own copy of the text back over a newer one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { writeComposerDraftThrough } from "@/services/voiceCorrectionLanding";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";

// jsdom has no layout: CodeMirror measures text through Range rects it lacks.
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

// A test below swaps the setter for a spy; every other test writes through the real one.
const realSetDraftInput = useTerminalInputStore.getState().setDraftInput;

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
  useTerminalInputStore.setState({ draftInputs: new Map(), setDraftInput: realSetDraftInput });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function bar(followsDriver: boolean) {
  return (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId="term-1"
          cwd={WT_ID}
          agentId="claude"
          onSend={() => {}}
          disabled={followsDriver}
          followsDriver={followsDriver}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

function mount(followsDriver: boolean) {
  return render(bar(followsDriver));
}

/** What the host's read-back does: put the driver's draft in the store and tell editors. */
async function hostDraft(text: string): Promise<void> {
  await act(async () => {
    useTerminalInputStore.setState((state) => {
      const drafts = new Map(state.draftInputs);
      if (text === "") drafts.delete("term-1");
      else drafts.set("term-1", text);
      return { draftInputs: drafts };
    });
    useTerminalInputStore.getState().bumpExternalDraftRevision();
  });
}

/** The document's text, without the placeholder an empty editor shows. */
function editorText(container: HTMLElement): string {
  const content = container.querySelector(".cm-content")?.cloneNode(true);
  if (!(content instanceof HTMLElement)) return "";
  for (const placeholder of content.querySelectorAll(".cm-placeholder")) placeholder.remove();
  return content.textContent ?? "";
}

describe("HybridInputBar following the driver's draft", () => {
  it("shows each draft the driver types, and clears with it", async () => {
    const { container } = mount(true);
    await act(async () => {});

    await hostDraft("fix the");
    expect(editorText(container)).toBe("fix the");
    await hostDraft("fix the flaky test");
    expect(editorText(container)).toBe("fix the flaky test");
    await hostDraft("");
    expect(editorText(container)).toBe("");
  });

  it("never writes its own copy of the text back to the drafts", async () => {
    const { container } = mount(true);
    await act(async () => {});
    const setDraftInput = vi.fn();
    useTerminalInputStore.setState({ setDraftInput });

    await hostDraft("driver typing");
    await hostDraft("driver typing more");

    expect(editorText(container)).toBe("driver typing more");
    expect(setDraftInput).not.toHaveBeenCalled();
    expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe("driver typing more");
  });

  it("leaves the driver's draft in place when a correction asks for its typing (#15873)", async () => {
    const { container } = mount(true);
    await act(async () => {});
    await hostDraft("driver typing");
    const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;

    await act(async () => {
      // Text only this view shows, over the driver's draft it last took in.
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: " here" } });
      writeComposerDraftThrough("term-1", undefined);
      expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe("driver typing");
    });
  });

  it("writes its own typing through for a correction once it takes over (#15873)", async () => {
    const view = mount(true);
    await act(async () => {});
    await hostDraft("fix the parsr");
    await act(async () => {
      view.rerender(bar(false));
    });
    const editor = EditorView.findFromDOM(
      view.container.querySelector<HTMLElement>(".cm-editor")!
    )!;

    await act(async () => {
      editor.dispatch({ changes: { from: 0, insert: "/review " }, userEvent: "input.type" });
      writeComposerDraftThrough("term-1", undefined);
      expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe(
        "/review fix the parsr"
      );
    });
  });

  it("takes over from the driver's latest draft, not the one a render behind", async () => {
    const view = mount(true);
    await act(async () => {});
    await hostDraft("sent by the driver");

    // The driver's send clears the draft in the same render this view takes over.
    await act(async () => {
      useTerminalInputStore.setState({ draftInputs: new Map() });
      useTerminalInputStore.getState().bumpExternalDraftRevision();
      view.rerender(bar(false));
    });

    expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe("");
    expect(editorText(view.container)).toBe("");
  });

  it("takes over with none of the driver's drafts left to undo into", async () => {
    const view = mount(true);
    await act(async () => {});
    await hostDraft("first draft");
    await hostDraft("first draft, revised");

    await act(async () => {
      view.rerender(bar(false));
    });
    const editor = EditorView.findFromDOM(
      view.container.querySelector<HTMLElement>(".cm-editor")!
    )!;
    const isMac = /Mac/.test(navigator.platform);
    await act(async () => {
      runScopeHandlers(
        editor,
        new KeyboardEvent("keydown", { key: "z", metaKey: isMac, ctrlKey: !isMac }),
        "editor"
      );
    });

    expect(editorText(view.container)).toBe("first draft, revised");
  });
});
