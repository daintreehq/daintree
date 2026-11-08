// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePanelStore } from "@/store/panelStore";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { setCurrentViewStore, type WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { PtyPanelData } from "@shared/types/panel";
import type { DiffNote } from "@/components/Worktree/diffNotes";
import { useTokenResolution } from "../useTokenResolution";

const clearDiffNotesOnceWritten = vi.hoisted(() =>
  vi.fn<(terminalId: string, token: string, notes: readonly DiffNote[]) => void>()
);
vi.mock("../../diffNotesDelivery", () => ({ clearDiffNotesOnceWritten }));

vi.mock("@/store/commandHistoryStore", () => ({
  useCommandHistoryStore: { getState: () => ({ recordPrompt: vi.fn() }) },
}));
vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: {
    getState: () => ({ learnFromCorrections: false, panelBuffers: {} }),
  },
}));

const agentPanel = {
  id: "t1",
  title: "t1",
  kind: "terminal",
  cwd: "/repo",
  detectedAgentId: "claude",
  worktreeId: "wt-1",
  location: "grid",
  hasPty: true,
} as unknown as PtyPanelData;

function seedAgent(overrides: Partial<PtyPanelData> = {}): void {
  usePanelStore.setState({
    panelsById: { t1: { ...agentPanel, ...overrides } as PtyPanelData },
    panelIds: ["t1"],
  });
}

function setup(paramOverrides: Partial<Parameters<typeof useTokenResolution>[0]> = {}) {
  const addToHistory = vi.fn();
  const onSend = vi.fn();
  const clearDraftInput = vi.fn();
  const { result } = renderHook(() =>
    useTokenResolution({
      latestRef: {
        current: {
          terminalId: "t1",
          projectId: undefined,
          disabled: false,
          value: "",
          onSend,
          addToHistory,
          resetHistoryIndex: vi.fn(),
          clearDraftInput,
        },
      },
      applyEditorValue: vi.fn(),
      setIsExpanded: vi.fn(),
      setActiveCompletionContext: vi.fn(),
      terminalId: "t1",
      cwd: "/repo",
      takesDiffNotes: true,
      ...paramOverrides,
    })
  );
  return { sendText: result.current.sendText, addToHistory, onSend, clearDraftInput };
}

const NOTE_INPUT = {
  worktreePath: "/repo",
  filePath: "src/a.ts",
  anchor: { kind: "file" as const },
  body: "Rename this",
};

describe("useTokenResolution with @notes", () => {
  let note: DiffNote;

  beforeEach(() => {
    clearDiffNotesOnceWritten.mockReset();
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    note = useDiffNotesStore.getState().addNote(NOTE_INPUT)!;
    setCurrentViewStore({
      getState: () => ({ worktrees: new Map([["wt-1", { path: "/repo" }]]) }),
    } as unknown as WorktreeViewStoreApi);
    seedAgent();
    (window as unknown as { electron: unknown }).electron = {
      git: { getWorkingDiff: vi.fn().mockResolvedValue("") },
    };
  });

  afterEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  it("tracks the send under a token and clears nothing until it's written", async () => {
    const submit = vi.fn<(text: string, token?: string) => Promise<boolean>>(async () => true);
    const { sendText, addToHistory } = setup();

    await act(async () => {
      await sendText("Fix @notes", { submit });
    });

    const [text, token] = submit.mock.calls[0]!;
    expect(text).toContain('File: src/a.ts\nLine(s): whole file\n"Rename this"');
    expect(token).toEqual(expect.any(String));
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("t1", token, [note]);
    // Clearing is the watcher's, once the terminal says it was written.
    expect(useDiffNotesStore.getState().notes[note.id]).toEqual(note);
    // History keeps the token, so a recall reads the notes pending then.
    expect(addToHistory).toHaveBeenCalledWith("t1", "Fix @notes", undefined);
  });

  it("watches nothing while a submit is held, and only starts once it's accepted", async () => {
    let accept!: (accepted: boolean) => void;
    const submit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        })
    );
    const { sendText } = setup();

    let sending!: Promise<boolean>;
    await act(async () => {
      sending = sendText("@notes", { submit });
      await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    });
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();

    await act(async () => {
      accept(true);
      await sending;
    });
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledTimes(1);
  });

  it("leaves the notes alone when the send is refused or withdrawn", async () => {
    const { sendText } = setup();

    await act(async () => {
      expect(await sendText("@notes", { submit: async () => false })).toBe(false);
    });

    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
    expect(useDiffNotesStore.getState().notes[note.id]).toEqual(note);
  });

  it("follows the token an adapter minted for itself", async () => {
    const { sendText } = setup();

    await act(async () => {
      await sendText("@notes", { submit: async () => ({ submissionToken: "minted" }) });
    });

    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("t1", "minted", [note]);
  });

  it("gives an ordinary send no token, and watches nothing", async () => {
    const submit = vi.fn(async () => true);
    const { sendText } = setup();

    await act(async () => {
      await sendText("Just a prompt", { submit });
    });

    expect(submit).toHaveBeenCalledWith("Just a prompt");
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
  });

  it("refuses the send when the agent quit to its shell during the expansion", async () => {
    let finishDiff!: (diff: string) => void;
    (window.electron.git.getWorkingDiff as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<string>((resolve) => {
        finishDiff = resolve;
      })
    );
    const submit = vi.fn(async () => true);
    const { sendText } = setup();

    let sent!: boolean;
    await act(async () => {
      const sending = sendText("@notes and @diff", { submit });
      seedAgent({ detectedAgentId: undefined, launchAgentId: undefined });
      finishDiff("");
      sent = await sending;
    });

    expect(sent).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(useDiffNotesStore.getState().notes[note.id]).toEqual(note);
  });

  it("keeps notes out of a composer that doesn't take them", async () => {
    const submit = vi.fn<(text: string, token?: string) => Promise<boolean>>(async () => true);
    const { sendText } = setup({ takesDiffNotes: false });

    await act(async () => {
      await sendText("Fix @notes", { submit });
    });

    expect(submit).toHaveBeenCalledWith("Fix [Diff notes aren't available here]");
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
  });

  it("won't send a draft that is only @notes with nothing behind it, and keeps the draft", async () => {
    useDiffNotesStore.setState({ notes: {} });
    const submit = vi.fn(async () => true);
    const onNothingToSend = vi.fn();
    const { sendText, addToHistory, clearDraftInput } = setup();

    let sent!: boolean;
    await act(async () => {
      sent = await sendText("@notes", { submit, onNothingToSend });
    });

    expect(sent).toBe(false);
    expect(onNothingToSend).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(addToHistory).not.toHaveBeenCalled();
    expect(clearDraftInput).not.toHaveBeenCalled();
  });

  it("still sends @notes with nothing behind it once there's something else to say", async () => {
    useDiffNotesStore.setState({ notes: {} });
    const submit = vi.fn(async () => true);
    const { sendText } = setup();

    await act(async () => {
      await sendText("@notes", { submit, compose: (draft) => `${draft}\n\nINSTRUCTION` });
      await sendText("Fix @notes", { submit });
    });

    expect(submit).toHaveBeenCalledWith("[No pending diff notes]\n\nINSTRUCTION");
    expect(submit).toHaveBeenCalledWith("Fix [No pending diff notes]");
  });

  it("sends the token as typed from a composer on another host", async () => {
    const submit = vi.fn(async () => true);
    const { sendText } = setup({ expandContext: false });

    await act(async () => {
      await sendText("@notes", { submit });
    });

    expect(submit).toHaveBeenCalledWith("@notes");
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
  });
});
