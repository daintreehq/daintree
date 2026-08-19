// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTokenResolution } from "../useTokenResolution";

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: () => undefined,
    getCachedSelection: () => null,
    clearDirectingState: () => {},
    notifyUserInput: () => {},
  },
}));

vi.mock("@/store/commandHistoryStore", () => ({
  useCommandHistoryStore: { getState: () => ({ recordPrompt: vi.fn() }) },
}));

// learnFromCorrections=false short-circuits the dictionary-learning side effect.
vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: {
    getState: () => ({ learnFromCorrections: false, panelBuffers: {} }),
  },
}));

type Params = Parameters<typeof useTokenResolution>[0];
type Latest = NonNullable<Params["latestRef"]["current"]>;

function setup(overrides: Partial<Latest> = {}) {
  const onSend = vi.fn<Latest["onSend"]>();
  const addToHistory = vi.fn<Latest["addToHistory"]>();
  const latest: Latest = {
    terminalId: "t1",
    projectId: undefined,
    disabled: false,
    value: "",
    onSend,
    addToHistory,
    resetHistoryIndex: vi.fn(),
    clearDraftInput: vi.fn(),
    ...overrides,
  };
  const params: Params = {
    latestRef: { current: latest },
    applyEditorValue: vi.fn(),
    setIsExpanded: vi.fn(),
    setActiveCompletionContext: vi.fn(),
    terminalId: "t1",
    cwd: "/repo",
    agentId: undefined,
  };
  const { result } = renderHook(() => useTokenResolution(params));
  return {
    sendText: result.current.sendText,
    onSend,
    addToHistory,
    applyEditorValue: params.applyEditorValue as ReturnType<typeof vi.fn>,
    clearDraftInput: latest.clearDraftInput as ReturnType<typeof vi.fn>,
  };
}

describe("useTokenResolution.sendText", () => {
  beforeEach(() => {
    (window as unknown as { electron: unknown }).electron = {
      git: { getWorkingDiff: vi.fn().mockResolvedValue("BODY") },
    };
  });

  it("resolves @diff to fenced diff content while keeping literals and history token", async () => {
    const getWorkingDiff = (
      window as unknown as {
        electron: { git: { getWorkingDiff: ReturnType<typeof vi.fn> } };
      }
    ).electron.git.getWorkingDiff;

    const { sendText, onSend, addToHistory } = setup();
    const text = 'review @diff and @"My File.txt" and $neo';

    await act(async () => {
      await sendText(text);
    });

    // The Git call fires at send time with the working-tree diff type.
    expect(getWorkingDiff).toHaveBeenCalledWith("/repo", "unstaged");

    const sent = onSend.mock.calls[0]![0].text;
    // @diff is expanded to fenced diff content...
    expect(sent).toContain("```diff\nBODY\n```");
    expect(sent).not.toContain("@diff");
    // ...while @file and $ capabilities pass through literally.
    expect(sent).toContain('@"My File.txt"');
    expect(sent).toContain("$neo");

    // History keeps the original human token, never the expanded content.
    expect(addToHistory).toHaveBeenCalledWith("t1", text, undefined);
  });

  it("does not call git when there is no @diff token (pure literal send)", async () => {
    const getWorkingDiff = (
      window as unknown as {
        electron: { git: { getWorkingDiff: ReturnType<typeof vi.fn> } };
      }
    ).electron.git.getWorkingDiff;

    const { sendText, onSend } = setup();
    await act(async () => {
      await sendText("just $neo and @file.ts");
    });

    expect(getWorkingDiff).not.toHaveBeenCalled();
    expect(onSend.mock.calls[0]![0].text).toBe("just $neo and @file.ts");
  });
});

/**
 * #11867's contract for a targeted submit: the editor, the draft store and the
 * history are a single transaction that commits only once the terminal has
 * actually taken the text.
 */
describe("useTokenResolution.sendText — targeted submit", () => {
  beforeEach(() => {
    (window as unknown as { electron: unknown }).electron = {
      git: { getWorkingDiff: vi.fn().mockResolvedValue("BODY") },
    };
  });

  it("reports acceptance instead of returning silently", async () => {
    const { sendText } = setup();
    let accepted: boolean | undefined;
    let refused: boolean | undefined;

    await act(async () => {
      accepted = await sendText("hi", { submit: async () => true });
      refused = await sendText("hi", { submit: async () => false });
    });

    expect(accepted).toBe(true);
    expect(refused).toBe(false);
  });

  it("leaves the draft alone when the submit is refused", async () => {
    const { sendText, applyEditorValue, clearDraftInput, addToHistory, onSend } = setup();

    await act(async () => {
      await sendText("keep me", { submit: async () => false });
    });

    expect(applyEditorValue).not.toHaveBeenCalled();
    expect(clearDraftInput).not.toHaveBeenCalled();
    expect(addToHistory).not.toHaveBeenCalled();
    // The pane's fire-and-forget path must not run alongside the targeted one.
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears the draft exactly once when the submit is accepted", async () => {
    const { sendText, applyEditorValue, clearDraftInput, onSend } = setup();

    await act(async () => {
      await sendText("send me", { submit: async () => true });
    });

    expect(applyEditorValue).toHaveBeenCalledTimes(1);
    expect(applyEditorValue.mock.calls[0]![0]).toBe("");
    expect(clearDraftInput).toHaveBeenCalledTimes(1);
    // Exactly one delivery: the targeted submit replaces the pane's own send
    // rather than joining it, or the agent would get the text twice.
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps a draft the user changed while the submit was in flight", async () => {
    // The snapshot went out; whatever is on screen now is newer than it and is
    // not ours to delete.
    const { sendText, applyEditorValue, clearDraftInput } = setup();

    await act(async () => {
      await sendText("snapshot", { submit: async () => true, isDraftUnchanged: () => false });
    });

    expect(applyEditorValue).not.toHaveBeenCalled();
    expect(clearDraftInput).not.toHaveBeenCalled();
  });

  it("resolves tokens in the draft but never in the composed suffix", async () => {
    // The appended sentence carries a directory path verbatim; a path that
    // happens to look like an @-token must not be rewritten into a diff.
    const submit = vi.fn().mockResolvedValue(true);
    const { sendText } = setup();

    await act(async () => {
      await sendText("check @diff", {
        compose: (draft) => `${draft}\n\ncontinue in /repo/@diff`,
        submit,
      });
    });

    const sent = submit.mock.calls[0]![0] as string;
    expect(sent).toContain("```diff\nBODY\n```");
    expect(sent).toContain("continue in /repo/@diff");
  });

  it("records the authored composition in history, not the expansion", async () => {
    const { sendText, addToHistory } = setup();

    await act(async () => {
      await sendText("check @diff", {
        compose: (draft) => `${draft}\n\nAND THIS`,
        submit: async () => true,
      });
    });

    expect(addToHistory).toHaveBeenCalledWith("t1", "check @diff\n\nAND THIS", undefined);
  });

  it("sends a composed instruction even when the draft is empty", async () => {
    const submit = vi.fn().mockResolvedValue(true);
    const { sendText } = setup();

    await act(async () => {
      await sendText("", { compose: () => "INSTRUCTION", submit });
    });

    expect(submit).toHaveBeenCalledWith("INSTRUCTION");
  });

  it("refuses a second send while the first is still awaiting its submit", async () => {
    let release!: (v: boolean) => void;
    const submit = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      })
    );
    const { sendText } = setup();

    let first!: Promise<boolean>;
    let second!: boolean;
    await act(async () => {
      first = sendText("one", { submit });
      second = await sendText("two", { submit });
      release(true);
      await first;
    });

    expect(second).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("refuses while disabled without consulting the submit", async () => {
    const submit = vi.fn().mockResolvedValue(true);
    const { sendText } = setup({ disabled: true });
    let sent: boolean | undefined;

    await act(async () => {
      sent = await sendText("hi", { submit });
    });

    expect(sent).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
