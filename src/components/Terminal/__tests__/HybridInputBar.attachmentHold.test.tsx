// @vitest-environment jsdom
/**
 * An attachment still being prepared holds the composer's send, and one whose
 * draft is gone by the time it is ready never lands in the next draft
 * unannounced (#15599).
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
import { HybridInputBar, type HybridInputBarProps } from "../HybridInputBar";
import { _resetPendingUploadsForTests } from "../uploads/pendingUploads";

const WT_ID = "/repo/wt";
const SHOT = "/tmp/shot.png";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let pickAttachments: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
let thumbnailFromPath: ReturnType<
  typeof vi.fn<(filePath: string) => Promise<{ thumbnailDataUrl: string }>>
>;

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
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  pickAttachments = vi.fn<() => Promise<string[]>>(async () => [SHOT]);
  thumbnailFromPath = vi.fn<(filePath: string) => Promise<{ thumbnailDataUrl: string }>>(
    async () => ({ thumbnailDataUrl: "data:image/png;base64,x" })
  );
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      clipboard: { pickAttachments, thumbnailFromPath },
      notification: { playUiEvent: vi.fn().mockResolvedValue(undefined) },
      runHistory: { append: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetPendingUploadsForTests();
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  document.body.innerHTML = "";
});

async function mount() {
  const onSend = vi.fn<HybridInputBarProps["onSend"]>(() => Promise.resolve(true));
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.contentDOM.focus();

  const type = async (text: string) => {
    await act(async () => {
      const end = view.state.doc.length;
      view.dispatch({
        changes: { from: end, insert: text },
        selection: { anchor: end + text.length },
        userEvent: "input.type",
      });
    });
  };
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
  };
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const attach = async () => {
    const button = result.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Attach files"]'
    )!;
    await act(async () => {
      button.click();
    });
    await settle();
  };
  return { view, onSend, type, pressEnter, settle, attach, container: result.container };
}

describe("HybridInputBar while an attachment is being prepared (#15599)", () => {
  it("refuses to send until the image chip is in the draft", async () => {
    const thumbnail = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValue(thumbnail.promise);
    const { view, onSend, type, pressEnter, settle, attach } = await mount();
    await type("look at this ");
    await attach();
    expect(thumbnailFromPath).toHaveBeenCalledWith(SHOT);

    await pressEnter();
    await settle();

    expect(onSend).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("look at this ");

    await act(async () => thumbnail.resolve({ thumbnailDataUrl: "data:image/png;base64,x" }));
    await settle();
    expect(view.state.doc.toString()).toBe(`look at this ${SHOT} `);

    await pressEnter();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].text).toContain(SHOT);
    expect(onSend.mock.calls[0]![0].imagePaths).toEqual([SHOT]);
  });
});
