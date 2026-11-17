// @vitest-environment jsdom
/**
 * `@notes` sent from a pane composer that holds the send for the agent's next
 * prompt (#16379): the notes go with the held send, so they clear only once
 * main says it was delivered, and stay pending if it is withdrawn or dropped
 * (#17181).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type {
  TerminalSubmissionLookup,
  TerminalSubmissionPhase,
} from "@shared/types/terminalSubmission";
import type {
  ComposerHoldOutcome,
  ComposerHoldResult,
  HeldComposerSend,
} from "@shared/types/ipc/composerHold";
import type { PtyPanelData } from "@shared/types/panel";

const terminalClient = vi.hoisted(() => ({
  submit: vi.fn<(id: string, text: string, token?: string) => Promise<void>>(),
  submitWithImages: vi.fn(),
  getSubmissions:
    vi.fn<(ids: string[], token: string) => Promise<Record<string, TerminalSubmissionLookup>>>(),
}));
vi.mock("@/clients", () => ({ terminalClient, projectClient: {} }));

const hold = vi.hoisted(() =>
  vi.fn<(id: string, text: string, imagePaths?: string[]) => Promise<ComposerHoldResult>>()
);
vi.mock("@/clients/composerHoldClient", () => ({ composerHoldClient: { hold } }));

vi.mock("@/store/commandHistoryStore", () => ({
  useCommandHistoryStore: { getState: () => ({ recordPrompt: vi.fn() }) },
}));
vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: {
    getState: () => ({ learnFromCorrections: false, panelBuffers: {} }),
  },
}));

import { usePanelStore } from "@/store/panelStore";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { setCurrentViewStore, type WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { DiffNote } from "@/components/Worktree/diffNotes";
import { useTokenResolution } from "../hooks/useTokenResolution";
import { submitPaneComposerText } from "../submitComposerText";
import { paneComposerHold } from "../paneComposerHold";

const workingAgent = {
  id: "t1",
  title: "t1",
  kind: "terminal",
  cwd: "/repo",
  detectedAgentId: "claude",
  agentState: "working",
  worktreeId: "wt-1",
  location: "grid",
  hasPty: true,
} as unknown as PtyPanelData;

const HOLD_TTL_MS = 60 * 60_000;

function heldSend(token: string, text: string, ttlMs = HOLD_TTL_MS): HeldComposerSend {
  return {
    terminalId: "t1",
    token,
    text,
    imagePaths: [],
    heldAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    status: "held",
  };
}

const absent: Record<string, TerminalSubmissionLookup> = { t1: { status: "absent" } };
const found = (token: string, phase: TerminalSubmissionPhase) => ({
  t1: { status: "found", record: { token, phase } } as TerminalSubmissionLookup,
});

function setupSendText() {
  const { result } = renderHook(() =>
    useTokenResolution({
      latestRef: {
        current: {
          terminalId: "t1",
          projectId: undefined,
          disabled: false,
          value: "",
          onSend: vi.fn(),
          addToHistory: vi.fn(),
          resetHistoryIndex: vi.fn(),
          clearDraftInput: vi.fn(),
        },
      },
      applyEditorValue: vi.fn(),
      setIsExpanded: vi.fn(),
      setActiveCompletionContext: vi.fn(),
      terminalId: "t1",
      cwd: "/repo",
      takesDiffNotes: true,
    })
  );
  return result.current.sendText;
}

/** The pane composer's `submitText`, as `TerminalPane` hands it to its composer. */
const paneSubmit = (text: string, submissionToken?: string) =>
  submitPaneComposerText(
    "t1",
    text,
    undefined,
    {
      canTakeInput: () => true,
      onSending: vi.fn(),
      onAccepted: vi.fn(),
      hold: paneComposerHold("t1"),
    },
    submissionToken
  );

function endHeld(token: string, outcome: ComposerHoldOutcome): void {
  useHeldComposerSendStore.getState().applyChange({
    terminalId: "t1",
    held: null,
    ended: { token, outcome },
  });
}

const pending = (note: DiffNote) => useDiffNotesStore.getState().notes[note.id] !== undefined;

describe("@notes in a held pane composer send", () => {
  let note: DiffNote;

  beforeEach(() => {
    vi.useFakeTimers();
    terminalClient.submit.mockReset().mockResolvedValue(undefined);
    terminalClient.getSubmissions.mockReset().mockResolvedValue(absent);
    hold.mockReset().mockImplementation(async (_id, text) => ({
      held: true,
      send: heldSend("hold-1", text),
    }));
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    useHeldComposerSendStore.setState({
      held: {},
      dropped: {},
      refused: {},
      endedTokens: [],
      deliveredTokens: [],
    });
    note = useDiffNotesStore.getState().addNote({
      worktreePath: "/repo",
      filePath: "src/a.ts",
      anchor: { kind: "file" },
      body: "Rename this",
    })!;
    setCurrentViewStore({
      getState: () => ({ worktrees: new Map([["wt-1", { path: "/repo" }]]) }),
    } as unknown as WorktreeViewStoreApi);
    usePanelStore.setState({ panelsById: { t1: workingAgent }, panelIds: ["t1"] });
    (window as unknown as { electron: unknown }).electron = {
      git: { getWorkingDiff: vi.fn().mockResolvedValue("") },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  async function sendHeld(sendText = setupSendText()): Promise<void> {
    await act(async () => {
      expect(await sendText("Fix @notes", { submit: paneSubmit })).toBe(true);
    });
    expect(hold).toHaveBeenLastCalledWith(
      "t1",
      expect.stringContaining('"Rename this"'),
      undefined
    );
    expect(terminalClient.submit).not.toHaveBeenCalled();
  }

  it("keeps the notes while the send is held, and clears them once it's delivered", async () => {
    await sendHeld();

    // Held well past any wait for the composer's own token to reach the terminal.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending(note)).toBe(true);

    // Another pane's held send being delivered says nothing of this one.
    useHeldComposerSendStore.getState().applyChange({
      terminalId: "t2",
      held: null,
      ended: { token: "other", outcome: { kind: "delivered" } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(true);

    endHeld("hold-1", { kind: "delivered" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(false);
    // The composer's own token never went anywhere, so nothing asks after it.
    expect(terminalClient.getSubmissions).not.toHaveBeenCalled();
  });

  it("clears the notes of a send held longer than a terminal submission is watched", async () => {
    await sendHeld();

    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(pending(note)).toBe(true);

    endHeld("hold-1", { kind: "delivered" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(false);
  });

  it("still counts a held send typed just before it expired and confirmed just after", async () => {
    await sendHeld();

    await vi.advanceTimersByTimeAsync(HOLD_TTL_MS + 60_000);
    endHeld("hold-1", { kind: "delivered" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(false);
  });

  it("stops following a held send it never hears end, by that send's own expiry", async () => {
    hold.mockImplementation(async (_id, text) => ({
      held: true,
      send: heldSend("hold-1", text, 2 * 60_000),
    }));
    await sendHeld();

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    endHeld("hold-1", { kind: "delivered" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(true);
  });

  it("refuses a second @notes send while the first is held, and clears on the first's delivery", async () => {
    const sendText = setupSendText();
    await sendHeld(sendText);

    await act(async () => {
      expect(await sendText("Again @notes", { submit: paneSubmit })).toBe(false);
    });
    expect(hold).toHaveBeenCalledTimes(1);
    expect(terminalClient.submit).not.toHaveBeenCalled();
    expect(pending(note)).toBe(true);

    endHeld("hold-1", { kind: "delivered" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(false);
  });

  it("follows the notes into a send held again after a drop", async () => {
    const sendText = setupSendText();
    await sendHeld(sendText);
    endHeld("hold-1", { kind: "dropped", reason: "typed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(true);

    hold.mockImplementation(async (_id, text) => ({
      held: true,
      send: heldSend("hold-2", text),
    }));
    await sendHeld(sendText);
    expect(hold).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending(note)).toBe(true);

    endHeld("hold-2", { kind: "delivered" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(false);
  });

  it.each<ComposerHoldOutcome>([
    { kind: "withdrawn" },
    { kind: "dropped", reason: "typed" },
    { kind: "dropped", reason: "unconfirmed" },
  ])("leaves the notes pending when the held send ends $kind", async (outcome) => {
    await sendHeld();

    endHeld("hold-1", outcome);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending(note)).toBe(true);

    // A later delivery of some other held send says nothing of this one.
    useHeldComposerSendStore.getState().noteHeld(heldSend("hold-2", "later"));
    endHeld("hold-2", { kind: "delivered" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(true);
  });

  it("clears the notes when main's delivery reaches this view before its answer to the hold", async () => {
    hold.mockImplementation(async (_id, text) => {
      endHeld("hold-1", { kind: "delivered" });
      return { held: true, send: heldSend("hold-1", text) };
    });

    await sendHeld();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending(note)).toBe(false);
  });

  it("still follows the composer's own token when the pane sends at once", async () => {
    usePanelStore.setState({
      panelsById: { t1: { ...workingAgent, agentState: "idle" } as PtyPanelData },
      panelIds: ["t1"],
    });
    const sendText = setupSendText();
    await act(async () => {
      expect(await sendText("Fix @notes", { submit: paneSubmit })).toBe(true);
    });
    expect(hold).not.toHaveBeenCalled();
    const token = terminalClient.submit.mock.calls[0]![2]!;
    terminalClient.getSubmissions.mockResolvedValue(found(token, "pty_written"));

    await vi.advanceTimersByTimeAsync(250);
    expect(terminalClient.getSubmissions).toHaveBeenCalledWith(["t1"], token);
    expect(pending(note)).toBe(false);
  });
});
