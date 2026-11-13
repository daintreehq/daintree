// @vitest-environment jsdom
/**
 * A composer torn down and built again over the same draft (maximize, dock,
 * a tab switch, a worktree switch) keeps its image and file chips, its
 * selection and the uploads held back for it; closing the panel or clearing
 * the draft lets them go (#16883).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { EditorSelection } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { readComposerSelection } from "@/lib/composerCaret";
import { makeDraftKey } from "@/lib/draftKey";
import { _resetComposerSnapshotsForTesting } from "@/lib/composerRemount";
import { HybridInputBar, type HybridInputBarProps } from "../HybridInputBar";
import { insertPreparedAttachments } from "../fileAttachments";
import { fileDropChipField, imageChipField, readImageChipPaths } from "../inputEditorExtensions";
import {
  _resetPendingUploadsForTests,
  composerUploadSurface,
  getHeldBackAttachments,
  holdBackAttachments,
  isolatedComposerUploadSurface,
  type PreparedAttachment,
} from "../uploads/pendingUploads";

const WT_ID = "/repo/wt";
const SHOT = "/tmp/shot.png";
const NOTES = "/repo/wt/notes.md";
const OTHER = "/tmp/other.png";
const TODO = "/repo/wt/todo.md";
const PREVIEW = "data:image/png;base64,x";
const HELD: PreparedAttachment = {
  type: "image",
  filePath: "/tmp/held.png",
  thumbnailDataUrl: PREVIEW,
};
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

function agentPanel(id: string): PtyPanelData {
  return {
    id,
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
}

beforeEach(() => {
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  usePanelStore.setState({
    panelsById: { "term-1": agentPanel("term-1"), "term-2": agentPanel("term-2") },
    panelIds: ["term-1", "term-2"],
    panelIdsByWorktreeId: { [WT_ID]: ["term-1", "term-2"] },
    focusedId: "term-1",
  });
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  _resetPendingUploadsForTests();
  _resetComposerSnapshotsForTesting();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      clipboard: { thumbnailFromPath: vi.fn(async () => ({ thumbnailDataUrl: PREVIEW })) },
      notification: { playUiEvent: vi.fn().mockResolvedValue(undefined) },
      runHistory: { append: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  document.body.innerHTML = "";
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface BarOptions {
  isolated?: boolean;
  strict?: boolean;
}

function bar(
  terminalId: string,
  onSend: HybridInputBarProps["onSend"],
  { isolated = false, strict = false }: BarOptions = {}
) {
  const tree = (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId={terminalId}
          cwd={WT_ID}
          agentId="claude"
          onSend={onSend}
          isolated={isolated}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

async function mount(options: BarOptions = {}) {
  const onSend = vi.fn<HybridInputBarProps["onSend"]>(() => Promise.resolve(true));
  const result = render(bar("term-1", onSend, options));
  await settle();
  const editor = () =>
    EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const view = editor();
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(editor(), new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await settle();
  };
  /** Shows another terminal's draft in the same composer, as a tab switch does. */
  const show = async (terminalId: string) => {
    result.rerender(bar(terminalId, onSend, options));
    await settle();
    return editor();
  };
  return { ...result, view, editor, onSend, pressEnter, show };
}

// jsdom's DOM selection never follows a dispatched one, so focus is stubbed.
const focus = (view: EditorView) =>
  Object.defineProperty(view, "hasFocus", { configurable: true, get: () => true });

/** Types `look at ` and attaches an image and a file after it, as a drop does. */
async function attach(view: EditorView, image = SHOT, file = NOTES) {
  await act(async () => {
    focus(view);
    view.dispatch({ changes: { from: 0, insert: "look at " }, selection: { anchor: 8 } });
    insertPreparedAttachments(
      view,
      [
        { type: "image", filePath: image, thumbnailDataUrl: PREVIEW },
        { type: "file", filePath: file, fileName: "notes.md", fileSize: 12 },
      ],
      WT_ID
    );
  });
  await settle();
}

describe("HybridInputBar across a remount (#16883)", () => {
  it("keeps the image and file chips, and sends the image after the remount", async () => {
    const first = await mount();
    await attach(first.view);
    const draft = first.view.state.doc.toString();
    expect(readImageChipPaths(first.view)).toEqual([SHOT]);
    expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe(draft);

    first.unmount();
    const second = await mount();

    expect(second.view.state.doc.toString()).toBe(draft);
    expect(readImageChipPaths(second.view)).toEqual([SHOT]);
    expect(second.view.state.field(imageChipField)[0]?.thumbnailUrl).toBe(PREVIEW);
    expect(second.view.state.field(fileDropChipField).map((e) => e.filePath)).toEqual([NOTES]);
    expect(second.view.dom.querySelector(".cm-image-chip img")).not.toBeNull();
    expect(second.view.dom.querySelector(".cm-file-drop-chip")).not.toBeNull();

    await second.pressEnter();
    expect(second.onSend).toHaveBeenCalledTimes(1);
    expect(second.onSend.mock.calls[0]![0].imagePaths).toEqual([SHOT]);
  });

  it("keeps the selection, and its publication for dictation, across the remount", async () => {
    const first = await mount();
    await attach(first.view);
    await act(async () => {
      first.view.dispatch({ selection: EditorSelection.single(5, 2) });
    });
    const draft = first.view.state.doc.toString();
    expect(readComposerSelection(makeDraftKey("term-1"), draft)).toEqual({ from: 2, to: 5 });

    first.unmount();
    const second = await mount();

    expect(second.view.state.selection.main.anchor).toBe(5);
    expect(second.view.state.selection.main.head).toBe(2);
    expect(readComposerSelection(makeDraftKey("term-1"), draft)).toEqual({ from: 2, to: 5 });
  });

  it("publishes no caret after the remount for a composer that never had focus", async () => {
    useTerminalInputStore.getState().setDraftInput("term-1", "never clicked into");
    const first = await mount();
    await act(async () => {
      first.view.dispatch({ selection: EditorSelection.single(3, 6) });
    });
    expect(first.view.hasFocus).toBe(false);

    first.unmount();
    const second = await mount();

    expect(second.view.hasFocus).toBe(false);
    expect(second.view.state.selection.main.anchor).toBe(3);
    expect(second.view.state.selection.main.head).toBe(6);
    expect(readComposerSelection(makeDraftKey("term-1"), "never clicked into")).toBeNull();
  });

  it("keeps uploads held back for the draft across the remount", async () => {
    const first = await mount();
    holdBackAttachments(composerUploadSurface("term-1"), [HELD]);

    first.unmount();
    await mount();

    expect(getHeldBackAttachments(composerUploadSurface("term-1"))).toEqual([HELD]);
  });

  it("puts no chips back on a draft changed while the composer was gone", async () => {
    const first = await mount();
    await attach(first.view);
    const changed = "x".repeat(first.view.state.doc.length);
    first.unmount();

    useTerminalInputStore.getState().setDraftInput("term-1", changed);
    const second = await mount();

    expect(second.view.state.doc.toString()).toBe(changed);
    expect(second.view.state.field(imageChipField)).toEqual([]);
    expect(second.view.state.field(fileDropChipField)).toEqual([]);
  });

  it("keeps each tab's chips through switches between terminals, and sends its own", async () => {
    useTerminalInputStore.getState().setDraftInput("term-2", "the other draft");
    const first = await mount();
    await attach(first.view);
    const draft = first.view.state.doc.toString();

    const other = await first.show("term-2");
    expect(other).not.toBe(first.view);
    expect(other.state.doc.toString()).toBe("the other draft");
    expect(other.state.field(imageChipField)).toEqual([]);
    await attach(other, OTHER, TODO);
    const otherDraft = other.state.doc.toString();

    const back = await first.show("term-1");
    expect(back.state.doc.toString()).toBe(draft);
    expect(readImageChipPaths(back)).toEqual([SHOT]);
    expect(back.state.field(fileDropChipField).map((e) => e.filePath)).toEqual([NOTES]);

    const again = await first.show("term-2");
    expect(again.state.doc.toString()).toBe(otherDraft);
    expect(readImageChipPaths(again)).toEqual([OTHER]);
    expect(again.state.field(fileDropChipField).map((e) => e.filePath)).toEqual([TODO]);

    await first.show("term-1");
    await first.pressEnter();
    expect(first.onSend).toHaveBeenCalledTimes(1);
    expect(first.onSend.mock.calls[0]![0].imagePaths).toEqual([SHOT]);
  });

  it("puts each chip back once under StrictMode's effect replay", async () => {
    const first = await mount();
    await attach(first.view);
    first.unmount();

    const second = await mount({ strict: true });

    expect(
      second
        .editor()
        .state.field(imageChipField)
        .map((e) => e.filePath)
    ).toEqual([SHOT]);
    expect(
      second
        .editor()
        .state.field(fileDropChipField)
        .map((e) => e.filePath)
    ).toEqual([NOTES]);
  });

  it("lets the chips go when the panel is closed to the trash, keeping the draft", async () => {
    const first = await mount();
    await attach(first.view);
    const draft = first.view.state.doc.toString();
    const trashed = (location: "trash" | "grid") =>
      usePanelStore.setState((state) => ({
        panelsById: {
          ...state.panelsById,
          "term-1": { ...state.panelsById["term-1"]!, location },
        },
      }));

    // The close lands before the pane unmounts its composer.
    trashed("trash");
    first.unmount();
    trashed("grid");
    const second = await mount();

    expect(second.view.state.doc.toString()).toBe(draft);
    expect(second.view.state.field(imageChipField)).toEqual([]);
    expect(second.view.state.field(fileDropChipField)).toEqual([]);
  });

  it("lets uploads held back for an isolated composer go with it", async () => {
    const first = await mount({ isolated: true });
    holdBackAttachments(isolatedComposerUploadSurface("term-1"), [HELD]);

    first.unmount();

    expect(getHeldBackAttachments(isolatedComposerUploadSurface("term-1"))).toEqual([]);
  });

  it("lets the chips go when the panel's input state is cleared", async () => {
    const first = await mount();
    await attach(first.view);
    const draft = first.view.state.doc.toString();
    first.unmount();

    useTerminalInputStore.getState().clearTerminalState("term-1");

    // The same text written back later is a new draft, without the old chips.
    useTerminalInputStore.getState().setDraftInput("term-1", draft);
    const second = await mount();
    expect(second.view.state.field(imageChipField)).toEqual([]);
    expect(second.view.state.field(fileDropChipField)).toEqual([]);
  });

  it("lets the chips go when the draft is cleared", async () => {
    const first = await mount();
    await attach(first.view);
    const draft = first.view.state.doc.toString();
    first.unmount();

    useTerminalInputStore.getState().clearDraftInput("term-1");
    useTerminalInputStore.getState().setDraftInput("term-1", draft);
    const second = await mount();

    expect(second.view.state.field(imageChipField)).toEqual([]);
  });
});
