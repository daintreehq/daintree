// @vitest-environment jsdom
/**
 * A view that watches while another screen drives shows the driver's draft in
 * each composer as the host reads it back (#13283). The bar is read-only then,
 * and never writes its own copy of the text back over a newer one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";

// jsdom has no layout: CodeMirror measures text through Range rects it lacks.
const originalRangeRects = Range.prototype.getClientRects;
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  Range.prototype.getClientRects = originalRangeRects;
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(followsDriver: boolean) {
  return render(
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
  const content = container.querySelector(".cm-content")?.cloneNode(true) as HTMLElement | null;
  if (!content) return "";
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
});
