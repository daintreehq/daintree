// @vitest-environment jsdom
/**
 * A `#N` in the draft that names an issue or pull request is marked in the
 * composer, and the agent still gets it exactly as typed (#14849).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import type { ForgeReferenceLookupResult } from "@shared/types/forge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { invalidateForgeReferences } from "@/services/forgeReferenceLookup";
import { HybridInputBar } from "../HybridInputBar";
import { REFERENCE_LOOKUP_SETTLE_MS } from "../hooks/useForgeReferenceMarks";

const WT_ID = "/repo/wt";
const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

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

const getReferencesByNumbers = vi.fn(
  async (payload: { cwd: string; numbers: number[] }): Promise<ForgeReferenceLookupResult[]> =>
    payload.numbers.map((number) =>
      number === 14843
        ? {
            number,
            status: "found",
            reference: {
              kind: "pr",
              number,
              title: "Clean up long dictations",
              state: "merged",
              isDraft: false,
            },
          }
        : { number, status: "not_found" }
    )
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  invalidateForgeReferences();
  getReferencesByNumbers.mockClear();
  (window as { electron?: unknown }).electron = { forge: { getReferencesByNumbers } };
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
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  document.body.innerHTML = "";
});

async function mount() {
  const onSend = vi.fn(async (_payload: { text: string }) => true);
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const type = async (text: string) => {
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        userEvent: "input.type",
      });
    });
  };
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    });
  };
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
  };
  return { view, onSend, type, settle, pressEnter };
}

describe("HybridInputBar issue and pull request references (#14849)", () => {
  it("marks a reference to a real pull request and sends it exactly as typed", async () => {
    const { view, onSend, type, settle, pressEnter } = await mount();
    await type("Make sure to merge #14843 and #99 and foo bar");
    await settle();

    expect(getReferencesByNumbers).toHaveBeenCalledExactlyOnceWith({
      cwd: WT_ID,
      numbers: [14843, 99],
    });
    const marks = [...view.dom.querySelectorAll(".cm-forge-ref")].map((el) => el.textContent);
    expect(marks).toEqual(["#14843"]);

    await pressEnter();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toMatchObject({
      text: "Make sure to merge #14843 and #99 and foo bar",
    });
  });

  it("asks nothing for a draft with no references", async () => {
    const { type, settle } = await mount();
    await type("# Heading with color: #fff and #include <x>");
    await settle();
    expect(getReferencesByNumbers).not.toHaveBeenCalled();
  });
});
