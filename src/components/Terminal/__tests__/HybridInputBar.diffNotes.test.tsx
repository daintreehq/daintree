// @vitest-environment jsdom
/**
 * `@notes` through the real composer: what it offers and draws for the agent's
 * own worktree, and that a send carries its token all the way to the host.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const clearDiffNotesOnceWritten = vi.hoisted(() => vi.fn());
vi.mock("../diffNotesDelivery", () => ({ clearDiffNotesOnceWritten }));

const fleetBroadcast = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/components/Fleet/fleetEnterBroadcast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/Fleet/fleetEnterBroadcast")>();
  return { ...actual, tryFleetBroadcastFromEditor: fleetBroadcast };
});

import { act, cleanup, render, screen } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import type { DiffNote } from "@/components/Worktree/diffNotes";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "wt-1";
const WT_PATH = "/repo/wt";

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

function seedPanel(overrides: Partial<PtyPanelData> = {}): void {
  const panel = {
    id: "term-1",
    title: "claude",
    kind: "terminal",
    cwd: WT_PATH,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    detectedAgentId: "claude",
    launchAgentId: "claude",
    agentState: "waiting",
    runtimeStatus: "running",
    ...overrides,
  } as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
    panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
    focusedId: panel.id,
  });
}

const addNote = (filePath = "src/a.ts", worktreePath = WT_PATH): DiffNote =>
  useDiffNotesStore
    .getState()
    .addNote({ worktreePath, filePath, anchor: { kind: "file" }, body: "Rename this" })!;

async function mount({
  isolated = false,
  withSubmit = true,
  otherHostId,
}: { isolated?: boolean; withSubmit?: boolean; otherHostId?: string } = {}) {
  const onSend = vi.fn();
  const settles: Array<(accepted: boolean) => void> = [];
  const submitText = vi.fn(
    (_text: string, _imagePaths: readonly string[], _token?: string) =>
      new Promise<boolean>((resolve) => settles.push(resolve))
  );
  const store = createWorktreeStore();
  store.setState({
    worktrees: new Map([[WT_ID, { id: WT_ID, path: WT_PATH } as WorktreeSnapshot]]),
  });
  setCurrentViewStore(store);
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={store}>
        <HybridInputBar
          terminalId="term-1"
          cwd={WT_PATH}
          agentId="claude"
          onSend={onSend}
          {...(withSubmit && { submitText })}
          isolated={isolated}
          {...(otherHostId !== undefined && { otherHostId })}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.contentDOM.focus();

  const type = async (text: string) => {
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        selection: { anchor: view.state.doc.length + text.length },
        userEvent: "input.type",
      });
    });
    await act(async () => {});
  };
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
  };
  const settle = async (accepted: boolean) => {
    await act(async () => {
      settles.shift()!(accepted);
    });
  };
  const chip = () => result.container.querySelector(".cm-notes-chip")?.textContent ?? null;
  const options = () => screen.queryAllByRole("option").map((option) => option.textContent ?? "");
  return { ...result, onSend, submitText, type, pressEnter, settle, chip, options };
}

const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

describe("HybridInputBar @notes", () => {
  beforeEach(() => {
    initBuiltInPanelKinds();
    // `@note` with nothing on offer is a file search.
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { files: { search: vi.fn(async () => ({ files: [] })) } },
    });
    clearDiffNotesOnceWritten.mockReset();
    fleetBroadcast.mockReset();
    fleetBroadcast.mockReturnValue(false);
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    useTerminalInputStore.setState({
      draftInputs: new Map(),
      commandHistory: new Map(),
      sentPrompts: new Map(),
      hybridInputAutoFocus: false,
    });
    seedPanel();
  });

  afterEach(() => {
    cleanup();
    usePanelStore.setState({ panelsById: {}, panelIds: [], panelIdsByWorktreeId: {} });
    if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
    else delete (window as { electron?: unknown }).electron;
  });

  it("hands the host the expanded notes and a token, and watches it once accepted", async () => {
    const note = addNote();
    const { submitText, type, pressEnter, settle } = await mount();

    await type("Fix @notes now");
    await pressEnter();

    expect(submitText).toHaveBeenCalledTimes(1);
    const [text, imagePaths, token] = submitText.mock.calls[0]!;
    expect(text).toBe('Fix\nFile: src/a.ts\nLine(s): whole file\n"Rename this"\nnow');
    expect(imagePaths).toEqual([]);
    expect(token).toEqual(expect.any(String));
    // Held by the host: nothing has been said to have gone yet.
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();

    await settle(true);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("term-1", token, [note]);
    expect(useDiffNotesStore.getState().notes[note.id]).toEqual(note);
  });

  it("watches nothing when the host refuses the send, and keeps the draft", async () => {
    addNote();
    const { type, pressEnter, settle } = await mount();

    await type("Fix @notes now");
    await pressEnter();
    await settle(false);

    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
    expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe("Fix @notes now");
  });

  it("says why a draft of only @notes with nothing pending didn't go, and keeps it", async () => {
    const { submitText, type, pressEnter, container } = await mount();

    await type("@notes ");
    await pressEnter();

    expect(submitText).not.toHaveBeenCalled();
    expect(container.querySelector("[data-send-refused-caption]")?.textContent).toBe(
      "Not sent · No notes to send"
    );
    expect(useTerminalInputStore.getState().getDraftInput("term-1")).toBe("@notes ");
  });

  it("gives an ordinary send no token", async () => {
    addNote();
    const { submitText, type, pressEnter } = await mount();

    await type("Just a prompt");
    await pressEnter();

    expect(submitText).toHaveBeenCalledWith("Just a prompt", []);
  });

  it("draws the chip's count and keeps it current without an edit", async () => {
    addNote();
    const { type, chip } = await mount();

    await type("Fix @notes now");
    expect(chip()).toContain("1 note · clears on send");

    await act(async () => {
      addNote("src/b.ts");
    });
    expect(chip()).toContain("2 notes · clears on send");

    await act(async () => {
      useDiffNotesStore.setState({ notes: {} });
    });
    expect(chip()).toContain("No notes");
  });

  it("offers a file search, not the rows, while its own worktree has no notes", async () => {
    addNote("src/other.ts", "/repo/other-worktree");
    const { type, options } = await mount();

    await type("@note");

    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("File autocomplete");
    expect(options().some((row) => row.includes("@notes"))).toBe(false);
  });

  it("offers @notes and each file's row while its own worktree has notes", async () => {
    addNote();
    const { type, options } = await mount();

    await type("@note");

    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Diff note autocomplete");
    expect(options().map((row) => row.match(/@notes(:\S*?\.ts)?/)?.[0])).toEqual([
      "@notes",
      "@notes:a.ts",
    ]);
  });

  it.each<[string, Parameters<typeof mount>[0], () => void]>([
    ["an isolated composer", { isolated: true }, () => {}],
    [
      "a plain shell",
      {},
      () => seedPanel({ detectedAgentId: undefined, launchAgentId: undefined }),
    ],
    ["an agent in no worktree", {}, () => seedPanel({ worktreeId: undefined })],
  ])(
    "keeps notes from %s: no offer, no chip, a placeholder at send",
    async (_l, props, arrange) => {
      const note = addNote();
      arrange();
      const { type, chip, options, pressEnter, submitText, settle } = await mount(props);

      await type("@note");
      expect(options().some((row) => row.includes("@notes"))).toBe(false);
      await type("s now");
      expect(chip()).toBeNull();

      await pressEnter();
      expect(submitText).toHaveBeenCalledWith("[Diff notes aren't available here] now", []);
      await settle(true);
      expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
      expect(useDiffNotesStore.getState().notes[note.id]).toEqual(note);
    }
  );

  it("keeps notes from a host that can't report delivery", async () => {
    addNote();
    const { type, chip, pressEnter, onSend } = await mount({ withSubmit: false });

    await type("Fix @notes now");
    expect(chip()).toBeNull();
    await pressEnter();

    expect(onSend.mock.calls[0]![0].text).toBe("Fix [Diff notes aren't available here] now");
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
  });

  it("sends the token as typed to a terminal on another host", async () => {
    addNote();
    const { type, chip, pressEnter, submitText } = await mount({ otherHostId: "host-2" });

    await type("Fix @notes now");
    expect(chip()).toBeNull();
    await pressEnter();

    expect(submitText).toHaveBeenCalledWith("Fix @notes now", []);
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
  });
});
