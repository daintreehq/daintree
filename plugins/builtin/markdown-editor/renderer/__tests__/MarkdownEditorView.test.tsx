// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi, UseBoundStore } from "zustand";
import { EditorView } from "@codemirror/view";
import { Text, Transaction } from "@codemirror/state";

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(async () => ({ ok: true, result: undefined })),
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/components/Worktree/DiffViewer", () => ({
  DiffViewer: (props: { diff: string }) => (
    <div data-testid="diff-viewer-mock" data-diff={props.diff} />
  ),
}));
type PanelStoreShape = { panelsById: Record<string, { id: string }> };
const panelStoreHolder = vi.hoisted(() => ({
  store: null as UseBoundStore<StoreApi<PanelStoreShape>> | null,
}));
// Counted: the view calls the store hook once per render, and nothing else on
// screen does, so its calls are the editor shell's renders.
vi.mock("../documentStateStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../documentStateStore")>();
  const hook = Object.assign(
    vi.fn(actual.useDocumentStateStore),
    actual.useDocumentStateStore
  ) as unknown as typeof actual.useDocumentStateStore;
  return { ...actual, useDocumentStateStore: hook };
});
vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  const store = create<PanelStoreShape>(() => ({ panelsById: { "panel-1": { id: "panel-1" } } }));
  panelStoreHolder.store = store;
  return { usePanelStore: store };
});

import { MarkdownEditorView } from "../MarkdownEditorView";
import { DocumentController, __resetDocumentControllersForTests } from "../documentController";
import { useDocumentStateStore } from "../documentStateStore";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CHANNELS, PUSH_CHANNELS, identityKey } from "../../shared/protocol";
import { createFakeMain, type FakeMain } from "./testHost";
import { whenPluginUiReady } from "@daintreehq/plugin-ui";
import { installAppPluginKitHost } from "@/services/plugin/appPluginKitHost";
import { formatBytes } from "@/lib/formatBytes";
import {
  hasEditsSinceClose,
  nextCloseSeq,
  resetCloseUndoOrderForTests,
  subscribeCloseUndoEdits,
  undoFieldText,
} from "@/services/terminal/closeUndoOrder";

// The app's own kit host, so the kit reaches the app services mocked here.
installAppPluginKitHost();

const FILE = "/repo/docs/plan.md";

function view(props: Partial<Parameters<typeof MarkdownEditorView>[0]> = {}) {
  return (
    <TooltipProvider>
      <MarkdownEditorView
        panelId="panel-1"
        filePath={FILE}
        fileName="plan.md"
        rootPath="/repo"
        worktreePath="/repo"
        projectId="p1"
        wrapLines={false}
        isFocused={true}
        changeTick={undefined}
        onOpenExternalEditor={() => {}}
        {...props}
      />
    </TooltipProvider>
  );
}

function editorView(): EditorView {
  const content = document.querySelector<HTMLElement>(".cm-content");
  const found = content ? EditorView.findFromDOM(content) : null;
  if (!found) throw new Error("editor not mounted");
  return found;
}

async function type(text: string) {
  const cm = editorView();
  await act(async () => {
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: text } });
  });
}

let main: FakeMain;
let uninstall: () => void;
// The real store, spied: the dialogs render the app's announcer, which needs
// the hook itself, not a getState() stub.
let announceMock: ReturnType<typeof vi.spyOn>;

beforeAll(() => whenPluginUiReady(), 30_000);

beforeEach(() => {
  main = createFakeMain();
  uninstall = main.install();
  main.files.set(FILE, "# Plan\n\nBody\n");
  announceMock = vi.spyOn(useAnnouncerStore.getState(), "announce").mockImplementation(() => {});
  dispatchMock.mockClear();
  panelStoreHolder.store!.setState({ panelsById: { "panel-1": { id: "panel-1" } } });
  useFileDocumentStore.setState({ byPanelId: {} });
  useDocumentStateStore.setState({ records: {} });
});

afterEach(() => {
  cleanup();
  __resetDocumentControllersForTests();
  uninstall();
  announceMock.mockRestore();
});

async function renderReady(props: Partial<Parameters<typeof MarkdownEditorView>[0]> = {}) {
  const result = render(view(props));
  await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  return result;
}

describe("MarkdownEditorView (#12323)", () => {
  it("mounts the document in an editable buffer with the status line and a disabled Save", async () => {
    await renderReady();
    expect(editorView().state.doc.toString()).toBe("# Plan\n\nBody\n");
    expect(editorView().contentDOM.getAttribute("aria-label")).toBe("plan.md");
    expect(screen.getByTestId("markdown-editor-status").textContent).toContain("4 lines");
    expect(screen.getByTestId("markdown-editor-status").textContent).toContain("LF");
    expect(screen.getByTestId("markdown-editor-dirty-state").textContent).toBe("Saved");
    expect((screen.getByTestId("markdown-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("typing marks the document dirty and Save writes it through the plugin", async () => {
    await renderReady();
    await type("\nmore");
    expect(screen.getByTestId("markdown-editor-dirty-state").textContent).toBe("Unsaved changes");
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.dirty).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("markdown-editor-save"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("markdown-editor-dirty-state").textContent).toBe("Saved")
    );
    expect(main.files.get(FILE)).toBe("# Plan\n\nBody\n\nmore");
    expect(announceMock).toHaveBeenCalledWith("Saved");
  });

  it("a save from the button hands focus back to the buffer it disables itself over", async () => {
    // The button disables on a clean save, and a disabled control loses focus.
    // Without the hand-off a keyboard user is left on nothing.
    await renderReady();
    await type("\nmore");
    const button = screen.getByTestId("markdown-editor-save") as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => {
      fireEvent.click(button);
    });
    // Unavailable, Save moves into its tooltip's hover wrapper, so the
    // disabled button is a new node: read it afresh.
    await waitFor(() =>
      expect((screen.getByTestId("markdown-editor-save") as HTMLButtonElement).disabled).toBe(true)
    );
    expect(editorView().hasFocus).toBe(true);
  });

  it("a save started from the buffer leaves focus where it was", async () => {
    // The inverse rule: Cmd+S from inside the document must not be answered by
    // grabbing focus, and neither must a save the user has since walked away from.
    await renderReady();
    await type("\nmore");
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await act(async () => {
      fireEvent.click(screen.getByTestId("markdown-editor-save"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("markdown-editor-dirty-state").textContent).toBe("Saved")
    );
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("Mod-s inside the editor saves and never reaches the window", async () => {
    await renderReady();
    await type("!");
    const windowSpy = vi.fn();
    window.addEventListener("keydown", windowSpy);
    await act(async () => {
      editorView().contentDOM.dispatchEvent(
        // Mod is Ctrl under jsdom (CodeMirror reads the platform at module load).
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })
      );
    });
    window.removeEventListener("keydown", windowSpy);
    await waitFor(() => expect(main.files.get(FILE)).toBe("# Plan\n\nBody\n!"));
    expect(windowSpy).not.toHaveBeenCalled();
  });

  it("shows the mixed line-endings notice from the read result", async () => {
    main.overrides.set(CHANNELS.read, () => ({
      status: "ok",
      text: "a\nb\n",
      revision: "a".repeat(64),
      hasBom: true,
      eol: "\r\n",
      mixedEol: true,
      size: 6,
    }));
    await renderReady();
    const status = screen.getByTestId("markdown-editor-status");
    expect(status.querySelector('[data-fact="eol"]')?.textContent).toContain("Mixed line endings");
    expect(status.textContent).toContain("with BOM");
  });

  it("a refused document says why and offers the external editor", async () => {
    main.overrides.set(CHANNELS.read, () => ({ status: "refused", reason: "NOT_UTF8" }));
    const onOpenExternalEditor = vi.fn();
    render(view({ onOpenExternalEditor }));
    expect(await screen.findByText("Can't edit this file here")).toBeTruthy();
    expect(screen.getByText(/isn't valid UTF-8/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onOpenExternalEditor).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".cm-content")).toBeNull();
  });

  it("a missing file with a stored draft keeps the draft reachable", async () => {
    main.files.delete(FILE);
    main.drafts.set(identityKey({ projectId: "p1", worktreePath: "/repo", filePath: FILE }), {
      generation: 1,
      record: {
        stateVersion: 1,
        identity: { projectId: "p1", worktreePath: "/repo", filePath: FILE },
        baseRevision: "a".repeat(64),
        baseText: "# Plan\n",
        draftText: "# Plan\n\norphan\n",
        hasBom: false,
        eol: "\n",
        updatedAt: 1,
      },
    });
    render(view());
    expect(await screen.findByText("File isn't available")).toBeTruthy();
    expect(screen.getByTestId("markdown-editor-copy-draft")).toBeTruthy();
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toMatchObject({
      dirty: true,
      draftText: "# Plan\n\norphan\n",
    });
  });

  it("a conflict shows the banner, holds Save, and Compare renders a draft-versus-disk diff", async () => {
    await renderReady();
    await type("\nmine");
    main.files.set(FILE, "# Plan\n\nBody\n\ntheirs\n");
    await act(async () => {
      fireEvent.click(screen.getByTestId("markdown-editor-save"));
    });
    expect(await screen.findByText("File changed on disk")).toBeTruthy();
    expect((screen.getByTestId("markdown-editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.conflict).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    const diff = await screen.findByTestId("diff-viewer-mock");
    expect(diff.getAttribute("data-diff")).toContain("-theirs");
    expect(diff.getAttribute("data-diff")).toContain("+mine");
    // The editor keeps the draft while the comparison is up.
    expect(editorView().state.doc.toString()).toBe("# Plan\n\nBody\n\nmine");
  });

  it("a disk file grown past the ceiling holds Save and offers only Save draft as (#15608)", async () => {
    await renderReady();
    await type("\nmine");
    main.oversized.add(FILE);
    await act(async () => {
      fireEvent.click(screen.getByTestId("markdown-editor-save"));
    });
    expect(await screen.findByText("File on disk is over 2 MiB")).toBeTruthy();
    expect((screen.getByTestId("markdown-editor-save") as HTMLButtonElement).disabled).toBe(true);
    const compare = screen.getByRole("button", { name: "Compare" });
    const loadDisk = screen.getByRole("button", { name: "Load disk version" });
    expect(compare.getAttribute("aria-disabled")).toBe("true");
    expect(loadDisk.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(compare);
    fireEvent.click(loadDisk);
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
    expect(screen.queryByText("Discard changes to 'plan.md'?")).toBeNull();
    expect(editorView().state.doc.toString()).toBe("# Plan\n\nBody\n\nmine");

    fireEvent.click(screen.getByRole("button", { name: "Save draft as…" }));
    const path = (await screen.findByTestId("markdown-editor-save-as-path")) as HTMLInputElement;
    expect(path.value).toBe("/repo/docs/plan-draft.md");
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Save file" })
      );
    });
    await waitFor(() =>
      expect(main.files.get("/repo/docs/plan-draft.md")).toBe("# Plan\n\nBody\n\nmine")
    );
  });

  it("an open comparison closes when the disk file grows past the ceiling (#15608)", async () => {
    await renderReady();
    await type("\nmine");
    main.files.set(FILE, "# Plan\n\nBody\n\ntheirs\n");
    await act(async () => {
      fireEvent.click(screen.getByTestId("markdown-editor-save"));
    });
    await screen.findByText("File changed on disk");
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByTestId("diff-viewer-mock");

    main.oversized.add(FILE);
    act(() => {
      main.push(PUSH_CHANNELS.documentChanged, {
        identityKey: identityKey({ projectId: "p1", worktreePath: "/repo", filePath: FILE }),
      });
    });
    expect(await screen.findByText("File on disk is over 2 MiB")).toBeTruthy();
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
    expect(editorView().state.doc.toString()).toBe("# Plan\n\nBody\n\nmine");
  });

  it("Load disk version asks first, then replaces the buffer with a fresh history", async () => {
    await renderReady();
    await type("\nmine");
    main.files.set(FILE, "# Plan\n\nBody\n\ntheirs\n");
    await act(async () => {
      fireEvent.click(screen.getByTestId("markdown-editor-save"));
    });
    await screen.findByText("File changed on disk");
    const before = editorView();
    fireEvent.click(screen.getByRole("button", { name: "Load disk version" }));
    expect(await screen.findByText("Discard changes to 'plan.md'?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    });
    await waitFor(() => expect(editorView()).not.toBe(before));
    expect(editorView().state.doc.toString()).toBe("# Plan\n\nBody\n\ntheirs\n");
    expect(screen.queryByText("File changed on disk")).toBeNull();
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.dirty).toBe(false);
  });

  it("a Mod+click on a link goes through the host link policy with the draft intact", async () => {
    main.files.set(FILE, "[spec](./spec.md)\n");
    await renderReady();
    await type("draft");
    const cm = editorView();
    vi.spyOn(cm, "posAtCoords").mockReturnValue(2);
    await act(async () => {
      // Both modifiers: jsdom reports no platform, so Mod resolves to Ctrl
      // there and to Meta on a Mac.
      cm.contentDOM.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          metaKey: true,
          ctrlKey: true,
        })
      );
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/docs/spec.md", rootPath: "/repo", confineToRoot: true },
      { source: "user" }
    );
    expect(cm.state.doc.toString()).toBe("[spec](./spec.md)\ndraft");
  });

  it("toggling wrap reconfigures the live editor", async () => {
    const { rerender } = await renderReady();
    expect(document.querySelector(".cm-lineWrapping")).toBeNull();
    rerender(view({ wrapLines: true }));
    await waitFor(() => expect(document.querySelector(".cm-lineWrapping")).not.toBeNull());
  });

  it("Cmd+F from the panel opens the editor's find bar while focused", async () => {
    await renderReady();
    await act(async () => {
      window.dispatchEvent(new Event("daintree:find-in-panel"));
    });
    expect(document.querySelector(".cm-search")).not.toBeNull();
    // The shared search field, with replace controls since this editor is editable.
    const query = document.querySelector<HTMLInputElement>(
      ".cm-search .search-field > input.search-field-input[main-field]"
    );
    expect(query).not.toBeNull();
    expect(document.activeElement).toBe(query);
    expect(document.querySelector(".cm-search input.cm-textfield[name=replace]")).not.toBeNull();
  });

  it("pins the strip in a header outside the scrolled document, leaving find in the editor", async () => {
    await renderReady();
    await act(async () => {
      window.dispatchEvent(new Event("daintree:find-in-panel"));
    });
    const header = screen.getByTestId("markdown-editor-header");
    expect(header.contains(screen.getByTestId("markdown-editor-status"))).toBe(true);
    expect(header.contains(screen.getByTestId("markdown-editor-host"))).toBe(false);
    // Inside `.cm-editor` is where the find bar's horizontal-scroll follow and
    // the find-mode highlight rules (`:has(.cm-search)`) can reach it.
    const search = document.querySelector(".cm-search");
    expect(search).not.toBeNull();
    expect(editorView().dom.contains(search)).toBe(true);
    expect(header.contains(search)).toBe(false);
  });

  it("keeps the cursor from scrolling under the pinned strip or an open find bar", async () => {
    await renderReady();
    const header = screen.getByTestId("markdown-editor-header");
    Object.defineProperty(header, "offsetHeight", { configurable: true, get: () => 28 });
    const cm = editorView();
    const topMargin = () =>
      Math.max(0, ...cm.state.facet(EditorView.scrollMargins).map((f) => f(cm)?.top ?? 0));
    expect(topMargin()).toBe(28);
    await act(async () => {
      window.dispatchEvent(new Event("daintree:find-in-panel"));
    });
    const panels = cm.dom.querySelector<HTMLElement>(".cm-panels-top")!;
    Object.defineProperty(panels, "offsetHeight", { configurable: true, get: () => 36 });
    expect(topMargin()).toBe(64);
  });

  it("unmounting the view keeps the draft — it is document state", async () => {
    const { unmount } = await renderReady();
    await type("\nkept");
    // Still pending when the view goes: leaving Edit commits it at once. One
    // synchronous step, so the commit timer can't land in between.
    act(() => {
      const cm = editorView();
      cm.dispatch({ changes: { from: cm.state.doc.length, insert: " too" } });
      expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.draftText).toBe(
        "# Plan\n\nBody\n\nkept"
      );
      unmount();
    });
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.draftText).toBe(
      "# Plan\n\nBody\n\nkept too"
    );
    await renderReady();
    expect(editorView().state.doc.toString()).toBe("# Plan\n\nBody\n\nkept too");
  });

  it("typing after the first edit re-renders only the status line and never strings the buffer (#17071)", async () => {
    await renderReady();
    await type("\nfirst");
    const shellRenders = vi.mocked(useDocumentStateStore);
    shellRenders.mockClear();
    const toString = vi.spyOn(Text.prototype, "toString");
    try {
      for (const key of "abcde") await type(key);
      expect(toString).not.toHaveBeenCalled();
    } finally {
      toString.mockRestore();
    }
    const typed = "# Plan\n\nBody\n\nfirstabcde";
    expect(screen.getByTestId("markdown-editor-status").textContent).toContain(
      formatBytes(Buffer.byteLength(typed))
    );
    // The draft string follows within the commit interval, and its arrival
    // changes nothing the shell shows either.
    await waitFor(() =>
      expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.draftText).toBe(typed)
    );
    expect(shellRenders).not.toHaveBeenCalled();
  });

  it("a second panel on the document follows committed typing and catches up when focused", async () => {
    panelStoreHolder.store!.setState({
      panelsById: { "panel-1": { id: "panel-1" }, "panel-2": { id: "panel-2" } },
    });
    render(
      <>
        {view()}
        {view({ panelId: "panel-2" })}
      </>
    );
    await waitFor(() => expect(document.querySelectorAll(".cm-content")).toHaveLength(2));
    const [first, second] = [...document.querySelectorAll<HTMLElement>(".cm-content")].map(
      (content) => EditorView.findFromDOM(content)!
    );
    const insert = (cm: EditorView, text: string) =>
      act(async () => {
        cm.dispatch({ changes: { from: cm.state.doc.length, insert: text } });
      });
    // Catching up is not typing: the receiving panel never reports it back.
    const secondEdits = vi.spyOn(DocumentController.get("panel-2")!, "edit");
    await insert(first!, "\na");
    expect(second!.state.doc.toString()).toBe("# Plan\n\nBody\n\na");
    await insert(first!, "b");
    expect(second!.state.doc.toString()).toBe("# Plan\n\nBody\n\na");
    await act(async () => {
      second!.contentDOM.dispatchEvent(new FocusEvent("focus"));
    });
    expect(second!.state.doc.toString()).toBe("# Plan\n\nBody\n\nab");
    expect(secondEdits).not.toHaveBeenCalled();
    await insert(second!, "c");
    await waitFor(() => expect(first!.state.doc.toString()).toBe("# Plan\n\nBody\n\nabc"));
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.draftText).toBe(
      "# Plan\n\nBody\n\nabc"
    );
  });

  describe("Undo against a closed panel (#17180)", () => {
    // jsdom has no layout: undo scrolls the caret into view, and CodeMirror
    // measures it through Range rects jsdom lacks.
    const rangeStubs = { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() };
    const originals = new Map<string, PropertyDescriptor | undefined>();
    beforeAll(() => {
      for (const [name, value] of Object.entries(rangeStubs)) {
        originals.set(name, Object.getOwnPropertyDescriptor(Range.prototype, name));
        Object.defineProperty(Range.prototype, name, { configurable: true, value });
      }
    });
    afterAll(() => {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
      }
    });

    // Typing stamped a moment apart, well inside the delay that would merge it
    // into one undo step, however long the run actually pauses between.
    async function typeAt(text: string, time: number) {
      const cm = editorView();
      await act(async () => {
        cm.dispatch({
          changes: { from: cm.state.doc.length, insert: text },
          annotations: Transaction.time.of(time),
        });
      });
    }

    beforeEach(() => {
      resetCloseUndoOrderForTests();
    });

    it("undoes typing newer than a panel close before the close, and keeps older typing for after it", async () => {
      await renderReady();
      await typeAt("\nolder", 1000);
      const close = nextCloseSeq();
      expect(hasEditsSinceClose(editorView().contentDOM, close)).toBe(false);
      await typeAt(" newer", 1001);
      const cm = editorView();
      expect(hasEditsSinceClose(cm.contentDOM, close)).toBe(true);

      // What the undo-close key and Edit > Undo hand the press to.
      await act(async () => {
        undoFieldText(cm.contentDOM);
      });
      expect(cm.state.doc.toString()).toBe("# Plan\n\nBody\n\nolder");
      // Back at the close: the next Undo reopens the panel.
      expect(hasEditsSinceClose(cm.contentDOM, close)).toBe(false);

      // The typing from before the close is still the editor's to undo.
      await act(async () => {
        undoFieldText(cm.contentDOM);
      });
      expect(cm.state.doc.toString()).toBe("# Plan\n\nBody\n");
    });

    it("tells Edit > Undo when the editor's undo history moves", async () => {
      await renderReady();
      const close = nextCloseSeq();
      const changed = vi.fn();
      const unsubscribe = subscribeCloseUndoEdits(changed);
      try {
        await type("\nafter");
        expect(changed).toHaveBeenCalled();
        expect(hasEditsSinceClose(editorView().contentDOM, close)).toBe(true);
      } finally {
        unsubscribe();
      }
    });
  });

  describe("Cmd+F under an app modal (#17180)", () => {
    function appModal(): HTMLElement {
      const modal = document.createElement("div");
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      document.body.appendChild(modal);
      return modal;
    }

    it("leaves the editor's find bar closed while a modal above it holds the keyboard", async () => {
      await renderReady();
      const modal = appModal();
      try {
        const field = document.createElement("input");
        modal.appendChild(field);
        field.focus();
        await act(async () => {
          window.dispatchEvent(new Event("daintree:find-in-panel"));
        });
        expect(document.querySelector(".cm-search")).toBeNull();
        expect(document.activeElement).toBe(field);
      } finally {
        modal.remove();
      }
    });

    it("leaves it closed while the modal is open even if the editor still holds focus", async () => {
      await renderReady();
      await act(async () => {
        editorView().focus();
      });
      const modal = appModal();
      try {
        expect(document.activeElement).toBe(editorView().contentDOM);
        await act(async () => {
          window.dispatchEvent(new Event("daintree:find-in-panel"));
        });
        expect(document.querySelector(".cm-search")).toBeNull();
      } finally {
        modal.remove();
      }
    });

    it("still opens it for an editor inside the modal that holds the keyboard", async () => {
      const modal = appModal();
      try {
        render(view(), { container: modal });
        await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
        await act(async () => {
          editorView().focus();
        });
        await act(async () => {
          window.dispatchEvent(new Event("daintree:find-in-panel"));
        });
        expect(document.querySelector(".cm-search")).not.toBeNull();
      } finally {
        cleanup();
        modal.remove();
      }
    });
  });

  describe("Copy draft", () => {
    const KEY = identityKey({ projectId: "p1", worktreePath: "/repo", filePath: FILE });
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    });

    async function renderOrphan() {
      main.files.delete(FILE);
      main.drafts.set(KEY, {
        generation: 1,
        record: {
          stateVersion: 1,
          identity: { projectId: "p1", worktreePath: "/repo", filePath: FILE },
          baseRevision: "a".repeat(64),
          baseText: "# Plan\n",
          draftText: "# Plan\n\norphan\n",
          hasBom: false,
          eol: "\n",
          updatedAt: 1,
        },
      });
      render(view());
      return screen.findByTestId("markdown-editor-copy-draft");
    }

    async function renderUnbacked() {
      await renderReady();
      await type("\nmore");
      await act(async () => {
        useDocumentStateStore.getState().upsert(KEY, (record) => ({
          ...record,
          storageWarning: "Draft recovery storage is full",
        }));
      });
      return screen.getByTestId("markdown-editor-copy-draft");
    }

    it("confirms an orphaned draft on the button once it reaches the clipboard", async () => {
      const button = await renderOrphan();
      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenCalledWith("# Plan\n\norphan\n");
      expect(button.textContent).toContain("Copied");
      expect(announceMock).toHaveBeenCalledWith("Copied", "polite");
    });

    it("says so on the button, and announces, when the clipboard refuses an orphaned draft", async () => {
      writeText.mockRejectedValue(new Error("denied"));
      const button = await renderOrphan();
      await act(async () => {
        fireEvent.click(button);
      });
      expect(button.textContent).toContain("Couldn't copy");
      expect(button.textContent).not.toContain("Copied");
      expect(announceMock).toHaveBeenCalledWith("Couldn't copy", "assertive");
    });

    it("copies the live buffer from the backup warning and confirms it", async () => {
      const button = await renderUnbacked();
      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenCalledWith("# Plan\n\nBody\n\nmore");
      expect(button.textContent).toContain("Copied");
    });

    it("says so on the backup warning's button when the clipboard refuses", async () => {
      writeText.mockRejectedValue(new Error("denied"));
      const button = await renderUnbacked();
      await act(async () => {
        fireEvent.click(button);
      });
      expect(button.textContent).toContain("Couldn't copy");
      expect(announceMock).toHaveBeenCalledWith("Couldn't copy", "assertive");
    });
  });
});
