// @vitest-environment jsdom
/**
 * A held or dropped send taken back for editing brings its images with its
 * text: the composer puts their chips back, so sending it again attaches them
 * (#16786).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const withdraw = vi.hoisted(() => vi.fn<(terminalId: string, token: string) => Promise<boolean>>());
vi.mock("@/clients/composerHoldClient", () => ({
  composerHoldClient: { withdraw, sendNow: vi.fn() },
}));

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import type { HeldComposerSend } from "@shared/types/ipc/composerHold";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import {
  _resetPendingComposerImagesForTesting,
  setPendingComposerImages,
} from "@/lib/composerPendingImages";
import { HybridInputBar, type HybridInputBarProps } from "../HybridInputBar";
import { HeldComposerSendRow } from "../HeldComposerSend";
import { addImageChip, imageChipField, readImageChipPaths } from "../inputEditorExtensions";

const WT_ID = "/repo/wt";
const SHOT = "/tmp/shot.png";
const OTHER = "/tmp/other.png";
const PREVIEW = "data:image/png;base64,x";
const EXISTING = "data:image/png;base64,existing";
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
  useHeldComposerSendStore.setState({ held: {}, dropped: {}, refused: {}, endedTokens: [] });
  _resetPendingComposerImagesForTesting();
  withdraw.mockReset().mockResolvedValue(true);
  thumbnailFromPath = vi.fn<(filePath: string) => Promise<{ thumbnailDataUrl: string }>>(
    async () => ({ thumbnailDataUrl: PREVIEW })
  );
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      clipboard: { thumbnailFromPath },
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

function dropSend(text: string, imagePaths: string[]): void {
  useHeldComposerSendStore.getState().applyChange({
    terminalId: "term-1",
    held: null,
    ended: {
      token: "token-1",
      outcome: { kind: "dropped", reason: "typed" },
      text,
      imagePaths,
    },
  });
}

function holdSend(text: string, imagePaths: string[]): void {
  const send: HeldComposerSend = {
    terminalId: "term-1",
    token: "token-1",
    text,
    imagePaths,
    heldAt: 1,
    expiresAt: 2,
    status: "held",
  };
  useHeldComposerSendStore.getState().noteHeld(send);
}

async function mount() {
  const onSend = vi.fn<HybridInputBarProps["onSend"]>(() => Promise.resolve(true));
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HeldComposerSendRow terminalId="term-1" agentId="claude" canEdit />
        <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await settle();
  };
  const edit = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });
    await settle();
  };
  const previews = () =>
    [...(view.state.field(imageChipField, false) ?? [])]
      .sort((a, b) => a.from - b.from)
      .map((entry) => entry.thumbnailUrl);
  const write = async (draft: string) => {
    await act(async () => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput("term-1", draft);
      inputs.bumpExternalDraftRevision();
    });
    await settle();
  };
  return { ...result, view, onSend, settle, pressEnter, edit, previews, write };
}

describe("HybridInputBar taking back a held send's images (#16786)", () => {
  it("puts a dropped send's images back on Edit, and sends them again", async () => {
    const text = `compare ${SHOT} with ${OTHER}`;
    dropSend(text, [SHOT, OTHER]);
    const { view, onSend, pressEnter, edit, previews } = await mount();

    await edit();

    expect(view.state.doc.toString()).toBe(text);
    expect(readImageChipPaths(view)).toEqual([SHOT, OTHER]);
    expect(previews()).toEqual([PREVIEW, PREVIEW]);
    expect(view.dom.querySelectorAll(".cm-image-chip img")).toHaveLength(2);

    await pressEnter();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].text).toBe(text);
    expect(onSend.mock.calls[0]![0].imagePaths).toEqual([SHOT, OTHER]);
  });

  it("puts a held send's images back once withdrawn for editing", async () => {
    holdSend(`look at ${SHOT}`, [SHOT]);
    const { view, edit } = await mount();

    await edit();

    expect(withdraw).toHaveBeenCalledWith("term-1", "token-1");
    expect(view.state.doc.toString()).toBe(`look at ${SHOT}`);
    expect(readImageChipPaths(view)).toEqual([SHOT]);
  });

  it("attaches the images when sent before their previews are back", async () => {
    const preview = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValue(preview.promise);
    dropSend(`look at ${SHOT}`, [SHOT]);
    const { view, onSend, pressEnter, edit, previews } = await mount();

    await edit();
    expect(previews()).toEqual([""]);
    expect(view.dom.querySelector(".cm-image-chip img")).toBeNull();

    await pressEnter();
    expect(onSend.mock.calls[0]![0].imagePaths).toEqual([SHOT]);

    // Too late for a draft that has gone out.
    await act(async () => preview.resolve({ thumbnailDataUrl: PREVIEW }));
    expect(view.state.field(imageChipField)).toEqual([]);
  });

  it("keeps a chip whose preview can't be read, still attaching its image", async () => {
    thumbnailFromPath.mockRejectedValue(new Error("outside allowed roots"));
    dropSend(`look at ${SHOT}`, [SHOT]);
    const { view, onSend, pressEnter, edit, previews } = await mount();

    await edit();
    expect(readImageChipPaths(view)).toEqual([SHOT]);
    expect(previews()).toEqual([""]);
    // The chip stands without a preview: its label and remove control, no broken image.
    const chip = view.dom.querySelector(".cm-image-chip");
    expect(chip?.querySelector(".cm-chip-label")).not.toBeNull();
    expect(chip?.querySelector("img")).toBeNull();

    await pressEnter();
    expect(onSend.mock.calls[0]![0].imagePaths).toEqual([SHOT]);
  });

  it("keeps the chips of the draft typed since, when the held text repeats its start", async () => {
    dropSend(SHOT, [SHOT]);
    const { view, edit, previews } = await mount();
    // The draft since names the same image, behind a chip of its own.
    await act(async () => {
      view.dispatch({
        changes: { from: 0, insert: SHOT },
        effects: addImageChip.of({
          from: 0,
          to: SHOT.length,
          filePath: SHOT,
          thumbnailUrl: EXISTING,
        }),
        userEvent: "input.paste",
      });
    });
    expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe(SHOT);

    await edit();

    expect(view.state.doc.toString()).toBe(`${SHOT}\n\n${SHOT}`);
    expect(readImageChipPaths(view)).toEqual([SHOT, SHOT]);
    // The restored chip is the held text's; the draft's own kept its preview on its own text.
    expect(previews()).toEqual([PREVIEW, EXISTING]);
  });

  it("puts no chip on text that doesn't spell the image's path", async () => {
    const { view, write } = await mount();
    const draft = "a different draft";
    setPendingComposerImages("term-1", {
      draft,
      before: "",
      change: { from: 0, to: 0, insert: draft },
      images: [{ from: 2, to: 11, filePath: "/tmp/x.png" }],
    });
    await write(draft);

    expect(view.state.doc.toString()).toBe(draft);
    expect(view.state.field(imageChipField)).toEqual([]);
    expect(thumbnailFromPath).not.toHaveBeenCalled();
  });

  it("keeps the images when the draft was added to before the composer showed it", async () => {
    const { view, write } = await mount();
    const restored = `look at ${SHOT}`;
    setPendingComposerImages("term-1", {
      draft: restored,
      before: "",
      change: { from: 0, to: 0, insert: restored },
      images: [{ from: 8, to: 8 + SHOT.length, filePath: SHOT }],
    });
    // Dictation or a handoff landing after the restore, before the composer caught up.
    await write(`${restored} and the logs`);

    expect(view.state.doc.toString()).toBe(`${restored} and the logs`);
    expect(readImageChipPaths(view)).toEqual([SHOT]);
  });

  it("brings the editor to the draft when it no longer shows the one the restore went over", async () => {
    const { view, write } = await mount();
    await write("abc");
    const restored = `look at ${SHOT}`;
    // Recorded over a draft this editor doesn't show: its change would run past the text here.
    setPendingComposerImages("term-1", {
      draft: restored,
      before: "a draft much longer than the one shown",
      change: { from: 0, to: 38, insert: restored },
      images: [{ from: 8, to: 8 + SHOT.length, filePath: SHOT }],
    });
    await write(restored);

    expect(view.state.doc.toString()).toBe(restored);
    expect(readImageChipPaths(view)).toEqual([SHOT]);
  });

  it("gives an old preview nothing once its draft has gone out", async () => {
    const first = deferred<{ thumbnailDataUrl: string }>();
    const second = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    dropSend(`look at ${SHOT}`, [SHOT]);
    const { view, edit, pressEnter, previews } = await mount();
    await edit();
    await pressEnter();
    expect(view.state.doc.toString()).toBe("");

    // The same image comes back in the next draft, its own preview still on its way.
    await act(async () => {
      useHeldComposerSendStore.getState().applyChange({
        terminalId: "term-1",
        held: null,
        ended: {
          token: "token-2",
          outcome: { kind: "dropped", reason: "typed" },
          text: `again ${SHOT}`,
          imagePaths: [SHOT],
        },
      });
    });
    await edit();
    expect(previews()).toEqual([""]);

    await act(async () => first.resolve({ thumbnailDataUrl: "data:image/png;base64,old" }));
    expect(previews()).toEqual([""]);
    await act(async () => second.resolve({ thumbnailDataUrl: PREVIEW }));
    expect(previews()).toEqual([PREVIEW]);
  });

  it("gives an editor that has gone nothing", async () => {
    const preview = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValue(preview.promise);
    dropSend(`look at ${SHOT}`, [SHOT]);
    const { view, edit, unmount } = await mount();
    await edit();
    const dispatch = vi.spyOn(view, "dispatch");

    unmount();
    await act(async () => preview.resolve({ thumbnailDataUrl: PREVIEW }));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves a chip removed before its preview arrived removed", async () => {
    const preview = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValue(preview.promise);
    dropSend(`look at ${SHOT}`, [SHOT]);
    const { view, edit } = await mount();

    await edit();
    await act(async () => {
      view.dispatch({ changes: { from: 8, to: 8 + SHOT.length }, userEvent: "delete" });
    });
    await act(async () => preview.resolve({ thumbnailDataUrl: PREVIEW }));

    expect(view.state.doc.toString()).toBe("look at ");
    expect(view.state.field(imageChipField)).toEqual([]);
  });
});
