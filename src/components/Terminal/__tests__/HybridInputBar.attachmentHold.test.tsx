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
import { setRemoteMaterializer } from "@/services/materialize";
import { HybridInputBar, type HybridInputBarProps } from "../HybridInputBar";
import {
  _resetPendingUploadsForTests,
  composerUploadSurface,
  hasPendingUploads,
} from "../uploads/pendingUploads";
import { routePaneDrop } from "../uploads/paneDropRouting";

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
  setRemoteMaterializer(null);
  delete window.__DAINTREE_HOST_ID__;
  _resetPendingUploadsForTests();
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  document.body.innerHTML = "";
});

async function mount(props: Partial<HybridInputBarProps> = {}) {
  const onSend = vi.fn<HybridInputBarProps["onSend"]>(() => Promise.resolve(true));
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId="term-1"
          cwd={WT_ID}
          agentId="claude"
          onSend={onSend}
          {...props}
        />
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
  const heldBack = () =>
    result.container.querySelector<HTMLElement>('[data-testid="held-back-attachments"]');
  return { view, onSend, type, pressEnter, settle, attach, heldBack };
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

  it("refuses to send in a remote window after the upload settles, until the thumbnail is back", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    const uploaded = "/srv/inbox/shot.png";
    const upload = deferred<void>();
    setRemoteMaterializer(async () => {
      await upload.promise;
      return { hostPath: uploaded, displayName: "shot.png", bytes: 3 };
    });
    const thumbnail = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValue(thumbnail.promise);
    const { view, onSend, type, pressEnter, settle } = await mount();
    await type("look at this ");

    await act(async () => {
      routePaneDrop("term-1", "hybridInput", [
        { kind: "local", path: SHOT, name: "shot.png", size: 3 },
      ]);
    });
    expect(hasPendingUploads(composerUploadSurface("term-1"))).toBe(true);
    await act(async () => upload.resolve());
    await settle();
    expect(hasPendingUploads(composerUploadSurface("term-1"))).toBe(false);
    expect(thumbnailFromPath).toHaveBeenCalledWith(uploaded);

    await pressEnter();
    await settle();
    expect(onSend).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("look at this ");

    await act(async () => thumbnail.resolve({ thumbnailDataUrl: "data:image/png;base64,x" }));
    await settle();
    expect(view.state.doc.toString()).toBe(`look at this ${uploaded} `);

    await pressEnter();
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].imagePaths).toEqual([uploaded]);
  });

  it("keeps the order of a multi-file attach, and falls back to a file chip for a failed thumbnail", async () => {
    pickAttachments.mockResolvedValue(["/tmp/a.png", `${WT_ID}/notes.md`, "/tmp/b.png"]);
    const first = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValueOnce(first.promise);
    thumbnailFromPath.mockRejectedValueOnce(new Error("outside allowed roots"));
    const { view, onSend, pressEnter, settle, attach } = await mount();
    await attach();

    await pressEnter();
    await settle();
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => first.resolve({ thumbnailDataUrl: "data:image/png;base64,x" }));
    await settle();
    expect(view.state.doc.toString()).toBe("/tmp/a.png @notes.md @/tmp/b.png ");
  });
});

describe("HybridInputBar when an attachment outlives its draft (#15599)", () => {
  it("holds it back with a note instead of adding it to the next draft, and adds it on request", async () => {
    const submit = deferred<boolean>();
    const submitText = vi.fn<NonNullable<HybridInputBarProps["submitText"]>>(() => submit.promise);
    const thumbnail = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValue(thumbnail.promise);
    const { view, type, pressEnter, settle, attach, heldBack } = await mount({ submitText });

    // A send already on its way when the image is attached: nothing held the
    // composer then, so nothing can stop the send clearing the draft.
    await type("first message");
    await pressEnter();
    await settle();
    expect(submitText).toHaveBeenCalledTimes(1);
    await attach();
    await act(async () => submit.resolve(true));
    await settle();
    expect(view.state.doc.toString()).toBe("");

    await type("the next one");
    await act(async () => thumbnail.resolve({ thumbnailDataUrl: "data:image/png;base64,x" }));
    await settle();

    expect(view.state.doc.toString()).toBe("the next one");
    const note = heldBack();
    expect(note?.textContent).toContain("shot.png wasn't added");

    const add = Array.from(note!.querySelectorAll("button")).find(
      (button) => button.textContent === "Add to draft"
    )!;
    await act(async () => add.click());
    await settle();

    expect(view.state.doc.toString()).toBe(`the next one ${SHOT} `);
    expect(heldBack()).toBeNull();
  });

  it("drops the held-back attachment when dismissed", async () => {
    const submit = deferred<boolean>();
    const thumbnail = deferred<{ thumbnailDataUrl: string }>();
    thumbnailFromPath.mockReturnValue(thumbnail.promise);
    const { view, type, pressEnter, settle, attach, heldBack } = await mount({
      submitText: () => submit.promise,
    });
    await type("first message");
    await pressEnter();
    await settle();
    await attach();
    await act(async () => submit.resolve(true));
    await settle();
    await act(async () => thumbnail.resolve({ thumbnailDataUrl: "data:image/png;base64,x" }));
    await settle();

    const discard = heldBack()!.querySelector<HTMLButtonElement>(
      'button[aria-label="Discard shot.png"]'
    )!;
    await act(async () => discard.click());
    await settle();

    expect(heldBack()).toBeNull();
    expect(view.state.doc.toString()).toBe("");
  });
});
