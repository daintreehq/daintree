// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi, UseBoundStore } from "zustand";
import { EditorView } from "@codemirror/view";

const { announceMock, dispatchMock } = vi.hoisted(() => ({
  announceMock: vi.fn(),
  dispatchMock: vi.fn(async () => ({ ok: true, result: undefined })),
}));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/hooks/useActiveAppScheme", () => ({ useActiveAppScheme: () => ({ type: "dark" }) }));
vi.mock("@/config/terminalFont", () => ({ DEFAULT_TERMINAL_FONT_FAMILY: "monospace" }));
vi.mock("@/components/Worktree/DiffViewer", () => ({
  DiffViewer: (props: { diff: string }) => (
    <div data-testid="diff-viewer-mock" data-diff={props.diff} />
  ),
}));
type PanelStoreShape = { panelsById: Record<string, { id: string }> };
const panelStoreHolder = vi.hoisted(() => ({
  store: null as UseBoundStore<StoreApi<PanelStoreShape>> | null,
}));
vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  const store = create<PanelStoreShape>(() => ({ panelsById: { "panel-1": { id: "panel-1" } } }));
  panelStoreHolder.store = store;
  return { usePanelStore: store };
});

import { MarkdownEditorView } from "../MarkdownEditorView";
import { __resetDocumentControllersForTests } from "../documentController";
import { useDocumentStateStore } from "../documentStateStore";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CHANNELS } from "../../shared/protocol";
import { createFakeMain, type FakeMain } from "./testHost";

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

beforeEach(() => {
  main = createFakeMain();
  uninstall = main.install();
  main.files.set(FILE, "# Plan\n\nBody\n");
  announceMock.mockClear();
  dispatchMock.mockClear();
  panelStoreHolder.store!.setState({ panelsById: { "panel-1": { id: "panel-1" } } });
  useFileDocumentStore.setState({ byPanelId: {} });
  useDocumentStateStore.setState({ records: {} });
});

afterEach(() => {
  cleanup();
  __resetDocumentControllersForTests();
  uninstall();
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
    expect(screen.getByTestId("markdown-editor-mixed-eol").textContent).toContain("CRLF");
    expect(screen.getByTestId("markdown-editor-status").textContent).toContain("with BOM");
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
    expect(await screen.findByText("Discard the draft of 'plan.md'?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
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
      cm.contentDOM.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true })
      );
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/docs/spec.md", rootPath: "/repo" },
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
  });

  it("unmounting the view keeps the draft — it is document state", async () => {
    const { unmount } = await renderReady();
    await type("\nkept");
    unmount();
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.draftText).toBe(
      "# Plan\n\nBody\n\nkept"
    );
    await renderReady();
    expect(editorView().state.doc.toString()).toBe("# Plan\n\nBody\n\nkept");
  });
});
