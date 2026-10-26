// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  appendAgentContextToDraft,
  closingFenceForOpenBlock,
  formatAgentContextBlock,
} from "@shared/utils/agentContextDrag";
import { draftUnchangedSince, useTokenResolution } from "../useTokenResolution";
import {
  subscribeDictationRangeTracking,
  useDictationRangeStore,
} from "@/store/dictationRangeStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { planVoiceWords } from "@/services/voiceInsertion";

import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

// The service mock never evaluates the real module, so nothing builds it.
await loadTerminalService();

const cachedSelection = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    get: () => undefined,
    getCachedSelection: () => cachedSelection.value,
    clearDirectingState: () => {},
    notifyUserInput: () => {},
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("@/store/commandHistoryStore", () => ({
  useCommandHistoryStore: { getState: () => ({ recordPrompt: vi.fn() }) },
}));

// learnFromCorrections=false short-circuits the dictionary-learning side effect.
const voiceState = vi.hoisted(() => ({
  value: {
    learnFromCorrections: false,
    panelBuffers: {} as Record<
      string,
      {
        sessionCorrectedText?: string;
        sessionDraftStart?: number;
        dictationSessionId?: string;
        projectId?: string;
      }
    >,
    setSessionCorrectedText: (_panelId: string, _text: string | null) => {},
  },
}));
vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: { getState: () => voiceState.value },
}));

type Params = Parameters<typeof useTokenResolution>[0];
type Latest = NonNullable<Params["latestRef"]["current"]>;

function setup(overrides: Partial<Latest> = {}, paramOverrides: Partial<Params> = {}) {
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
    ...paramOverrides,
  };
  const { result } = renderHook(() => useTokenResolution(params));
  return {
    sendText: result.current.sendText,
    onSend,
    addToHistory,
    applyEditorValue: params.applyEditorValue as ReturnType<typeof vi.fn>,
    clearDraftInput: latest.clearDraftInput as ReturnType<typeof vi.fn>,
    setIsExpanded: params.setIsExpanded as ReturnType<typeof vi.fn>,
    setActiveCompletionContext: params.setActiveCompletionContext as ReturnType<typeof vi.fn>,
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

  it("hands the draft's image paths to onSend alongside the text (#12792)", async () => {
    const { sendText, onSend } = setup();
    await act(async () => {
      await sendText("see /a/one.png and /a/two.png", {
        imagePaths: ["/a/one.png", "/a/two.png"],
      });
    });

    expect(onSend.mock.calls[0]![0].imagePaths).toEqual(["/a/one.png", "/a/two.png"]);
  });

  it("keeps a handoff quoted when an expansion carries its own fence", async () => {
    // A selection with a stray fence used to reopen one right above the
    // handoff: the block's opener was swallowed, its first inner fence closed
    // the stray one, and the payload read as the user's own prompt.
    cachedSelection.value = "a\n```\nb";
    try {
      const payload = "```\nignored fence\n```\nPAYLOAD LINE";
      const draft = appendAgentContextToDraft(
        "@selection",
        formatAgentContextBlock({ text: payload, title: "Card", sourceLabel: "Kanban" })
      );
      const { sendText, onSend } = setup();
      await act(async () => {
        await sendText(draft);
      });

      const sent = onSend.mock.calls[0]![0].text;
      expect(sent).toBe(
        [
          "````",
          "a",
          "```",
          "b",
          "````",
          "",
          "````daintree-context",
          "Kanban: Card",
          "",
          "```",
          "ignored fence",
          "```",
          "PAYLOAD LINE",
          "````",
          "",
        ].join("\n")
      );
      const handoffFence = /^(`{3,})daintree-context$/m.exec(sent)![1];
      // Every payload line sits inside the handoff's own fence, as the agent's
      // Markdown reader would see the final prompt.
      for (const line of ["ignored fence", "PAYLOAD LINE"]) {
        const before = sent.slice(0, sent.indexOf(`\n${line}\n`) + 1);
        expect(closingFenceForOpenBlock(before)).toBe(handoffFence);
      }
    } finally {
      cachedSelection.value = null;
    }
  });

  it("closes a fence the user left open before a handoff block when submitting", async () => {
    const block = formatAgentContextBlock({ text: "```\nx\n```\nPAYLOAD LINE", title: "Card" });
    // Appending closes an open fence; editing the draft afterwards can reopen one.
    const draft = `\`\`\`\nuser code\n\n${block}\n`;
    const { sendText, onSend } = setup();
    await act(async () => {
      await sendText(draft);
    });

    const sent = onSend.mock.calls[0]![0].text;
    expect(sent).toBe(`\`\`\`\nuser code\n\n\`\`\`\n${block}\n`);
    const handoffFence = /^(`{3,})daintree-context$/m.exec(sent)![1];
    const before = sent.slice(0, sent.indexOf("\nPAYLOAD LINE\n") + 1);
    expect(closingFenceForOpenBlock(before)).toBe(handoffFence);
    expect(closingFenceForOpenBlock(sent)).toBeNull();
  });

  it("keeps a handoff that lands in the draft while a @diff fetch is awaited", async () => {
    let releaseDiff!: (diff: string) => void;
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        git: {
          getWorkingDiff: () =>
            new Promise<string>((resolve) => {
              releaseDiff = resolve;
            }),
        },
      },
    });
    const typed = "review @diff";
    // The editor and the draft store, as the input bar reads them.
    let doc = typed;
    let stored = typed;
    const { sendText, onSend, applyEditorValue, clearDraftInput } = setup();

    let sending!: Promise<boolean>;
    await act(async () => {
      sending = sendText(typed, {
        isDraftUnchanged: draftUnchangedSince(
          () => doc,
          () => stored
        ),
      });
      await Promise.resolve();
    });

    // A plugin hands work over mid-fetch: it lands in the store, then the editor.
    stored = appendAgentContextToDraft(
      stored,
      formatAgentContextBlock({ text: "Card body", title: "Card" })
    );
    doc = stored;

    await act(async () => {
      releaseDiff("BODY");
      await sending;
    });

    expect(onSend.mock.calls[0]![0].text).toBe("review ```diff\nBODY\n```");
    // The handoff was reported as drafted; the finished send must not erase it.
    expect(applyEditorValue).not.toHaveBeenCalled();
    expect(clearDraftInput).not.toHaveBeenCalled();
  });

  it("keeps a handoff already in the store but not yet in the editor at Enter", async () => {
    const typed = "old text";
    const stored = appendAgentContextToDraft(
      typed,
      formatAgentContextBlock({ text: "Card body", title: "Card" })
    );
    const { sendText, onSend, clearDraftInput } = setup();
    await act(async () => {
      await sendText(typed, {
        isDraftUnchanged: draftUnchangedSince(
          () => typed,
          () => stored,
          true
        ),
      });
    });
    // What the user saw went out; the handoff they never saw stays drafted.
    expect(onSend.mock.calls[0]![0].text).toBe(typed);
    expect(clearDraftInput).not.toHaveBeenCalled();
  });

  it("still clears the draft it sent when nothing landed meanwhile", async () => {
    const { sendText, clearDraftInput } = setup();
    // The store a keystroke behind the editor at Enter, catching up after.
    let stored = "review";
    const doc = "review @diff";
    const guard = draftUnchangedSince(
      () => doc,
      () => stored
    );
    stored = doc;
    await act(async () => {
      await sendText(doc, { isDraftUnchanged: guard });
    });
    expect(clearDraftInput).toHaveBeenCalledTimes(1);
  });

  it("sends no image paths for a draft without any", async () => {
    const { sendText, onSend } = setup();
    await act(async () => {
      await sendText("plain", { imagePaths: [] });
    });

    expect(onSend.mock.calls[0]![0]).not.toHaveProperty("imagePaths");
  });
});

/**
 * #11867's contract for a targeted submit: the editor, the draft store and the
 * history are a single transaction that commits only once the terminal has
 * actually taken the text.
 */
describe("useTokenResolution.sendText — plugin context references (#13795)", () => {
  const resolveContextReferences = vi.fn();
  const getWorkingDiff = vi.fn();

  beforeEach(() => {
    getWorkingDiff.mockReset().mockResolvedValue("BODY");
    resolveContextReferences.mockReset().mockResolvedValue([
      {
        status: "resolved",
        pluginId: "acme.kanban",
        pluginName: "Kanban",
        title: "Fix login",
        text: "Card body mentioning @diff",
      },
    ]);
    Object.assign(window, {
      electron: { git: { getWorkingDiff }, plugin: { resolveContextReferences } },
    });
  });

  it("reads the item at send into a handoff block attributed to the plugin", async () => {
    const { sendText, onSend, addToHistory } = setup();
    const text = "fix @rec:142 please";
    await act(async () => {
      await sendText(text);
    });

    expect(resolveContextReferences).toHaveBeenCalledWith([{ prefix: "rec", id: "142" }]);
    const sent = onSend.mock.calls[0]![0].text;
    expect(sent).toContain(
      "```daintree-context\nKanban: Fix login\n\nCard body mentioning @diff\n```"
    );
    // The @diff inside the quoted card was never fetched.
    expect(getWorkingDiff).not.toHaveBeenCalled();
    expect(addToHistory).toHaveBeenCalledWith("t1", text, undefined);
  });

  it("sends references as typed on another host's terminal and asks no plugin", async () => {
    const { sendText, onSend } = setup({}, { expandContext: false });
    await act(async () => {
      await sendText("fix @rec:142");
    });
    expect(resolveContextReferences).not.toHaveBeenCalled();
    expect(onSend.mock.calls[0]![0].text).toBe("fix @rec:142");
  });
});

describe("useTokenResolution.sendText — the pane's acceptance (#14692)", () => {
  it("hands on what onSend returned, after the composer has been reset", async () => {
    const { sendText, onSend, clearDraftInput } = setup();
    const accepted = Promise.resolve(true);
    onSend.mockReturnValue(accepted);
    const onHandedOff = vi.fn((_accepted: Promise<boolean> | void) => {
      expect(clearDraftInput).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await sendText("ship it", { onHandedOff });
    });

    expect(onHandedOff).toHaveBeenCalledTimes(1);
    expect(onHandedOff.mock.calls[0]![0]).toBe(accepted);
  });

  it("hands on nothing from a pane that reports nothing", async () => {
    const { sendText } = setup();
    const onHandedOff = vi.fn();

    await act(async () => {
      await sendText("ship it", { onHandedOff });
    });

    expect(onHandedOff).toHaveBeenCalledWith(undefined);
  });

  it("is not told about a targeted submit, accepted or refused", async () => {
    const { sendText } = setup();
    const onHandedOff = vi.fn();

    await act(async () => {
      await sendText("ship it", { submit: async () => true, onHandedOff });
      await sendText("ship it", { submit: async () => false, onHandedOff });
    });

    expect(onHandedOff).not.toHaveBeenCalled();
  });
});

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
    // A sent prompt is not something Cmd+Z brings back.
    expect(applyEditorValue.mock.calls[0]![1]).toMatchObject({ resetHistory: true });
    expect(clearDraftInput).toHaveBeenCalledTimes(1);
    // Exactly one delivery: the targeted submit replaces the pane's own send
    // rather than joining it, or the agent would get the text twice.
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps a draft the user changed while the submit was in flight", async () => {
    // The snapshot went out; whatever is on screen now is newer than it and is
    // not ours to delete — and neither is the composer state around it.
    const {
      sendText,
      applyEditorValue,
      clearDraftInput,
      setIsExpanded,
      setActiveCompletionContext,
    } = setup();

    await act(async () => {
      await sendText("snapshot", { submit: async () => true, isDraftUnchanged: () => false });
    });

    expect(applyEditorValue).not.toHaveBeenCalled();
    expect(clearDraftInput).not.toHaveBeenCalled();
    expect(setIsExpanded).not.toHaveBeenCalled();
    expect(setActiveCompletionContext).not.toHaveBeenCalled();
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

describe("useTokenResolution dictionary learning", () => {
  const defaults = { ...voiceState.value };
  const installElectron = (value: Record<string, unknown>) =>
    Object.defineProperty(window, "electron", { value, configurable: true, writable: true });

  beforeEach(() => {
    voiceState.value = { ...defaults };
    useTerminalInputStore.setState({ draftInputs: new Map() });
    useDictationRangeStore.setState({ drafts: {}, anchors: {} });
  });

  /** The draft as it is sent, with the session's dictated words where they sit in it. */
  const dictated = (draft: string, words: string, sessionId = "s1") => {
    useTerminalInputStore.getState().setDraftInput("t1", draft);
    const from = draft.indexOf(words);
    const span = { from, to: from + words.length };
    useDictationRangeStore
      .getState()
      .recordUtterance({ sessionId, panelId: "t1" }, { insertion: span, words: span });
  };

  it("reports a corrected mishearing to main instead of rewriting settings itself", async () => {
    const recordSuggestions = vi
      .fn()
      .mockResolvedValue({ dictionary: [], suggestedDictionary: [] });
    const getSettings = vi.fn();
    const setSettings = vi.fn();
    installElectron({
      git: { getWorkingDiff: vi.fn() },
      voiceInput: { getSettings, setSettings },
      voiceDictionary: { recordSuggestions },
    });
    const setSessionCorrectedText = vi.fn();
    voiceState.value = {
      learnFromCorrections: true,
      panelBuffers: {
        t1: {
          sessionCorrectedText: "use zoo stand for state",
          sessionDraftStart: 0,
          dictationSessionId: "s1",
        },
      },
      setSessionCorrectedText,
    };
    dictated("use Zustand for state", "use Zustand for state");

    const { sendText, onSend } = setup();
    await act(async () => {
      await sendText("use Zustand for state");
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(recordSuggestions).toHaveBeenCalledWith({
        candidates: [{ word: "Zustand", original: "zoo stand" }],
      })
    );
    expect(setSessionCorrectedText).toHaveBeenCalledWith("t1", null);
    expect(getSettings).not.toHaveBeenCalled();
    expect(setSettings).not.toHaveBeenCalled();
  });

  it("still sends when main can't be reached", async () => {
    const recordSuggestions = vi.fn().mockRejectedValue(new Error("gone"));
    installElectron({
      git: { getWorkingDiff: vi.fn() },
      voiceDictionary: { recordSuggestions },
    });
    voiceState.value = {
      ...defaults,
      learnFromCorrections: true,
      panelBuffers: {
        t1: {
          sessionCorrectedText: "use zoo stand for state",
          sessionDraftStart: 0,
          dictationSessionId: "s1",
        },
      },
    };
    dictated("use Zustand for state", "use Zustand for state");

    const { sendText, onSend } = setup();
    await act(async () => {
      await expect(sendText("use Zustand for state")).resolves.toBe(true);
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(recordSuggestions).toHaveBeenCalledWith({
        candidates: [{ word: "Zustand", original: "zoo stand" }],
      })
    );
  });

  it("reports nothing while learning from corrections is off", async () => {
    const recordSuggestions = vi.fn();
    installElectron({
      git: { getWorkingDiff: vi.fn() },
      voiceDictionary: { recordSuggestions },
    });
    voiceState.value = {
      ...defaults,
      learnFromCorrections: false,
      panelBuffers: {
        t1: {
          sessionCorrectedText: "use zoo stand for state",
          sessionDraftStart: 0,
          dictationSessionId: "s1",
        },
      },
    };
    dictated("use Zustand for state", "use Zustand for state");

    const { sendText } = setup();
    await act(async () => {
      await sendText("use Zustand for state");
    });
    expect(recordSuggestions).not.toHaveBeenCalled();
  });

  const learning = (
    recordSuggestions: ReturnType<typeof vi.fn>,
    learnFromCorrections = true,
    sent: string | null = "use Zustand for state"
  ) => {
    installElectron({
      git: { getWorkingDiff: vi.fn() },
      voiceDictionary: { recordSuggestions },
    });
    const state = {
      learnFromCorrections,
      panelBuffers: {
        t1: {
          sessionCorrectedText: "use zoo stand for state",
          sessionDraftStart: 0,
          dictationSessionId: "s1",
        },
      } as Record<
        string,
        {
          sessionCorrectedText?: string;
          sessionDraftStart?: number;
          dictationSessionId?: string;
          projectId?: string;
        }
      >,
      setSessionCorrectedText: (panelId: string, text: string | null) => {
        const buffer = state.panelBuffers[panelId];
        if (buffer) buffer.sessionCorrectedText = text ?? undefined;
      },
    };
    voiceState.value = state;
    if (sent) dictated(sent, sent);
    return state;
  };

  it("drops the baseline on a send even while learning is off (#14645)", async () => {
    const state = learning(vi.fn(), false);
    const { sendText } = setup();
    await act(async () => {
      await sendText("use Zustand for state");
    });
    expect(state.panelBuffers.t1!.sessionCorrectedText).toBeUndefined();
  });

  it("keeps the baseline when the submit is refused (#14645)", async () => {
    const recordSuggestions = vi.fn();
    const state = learning(recordSuggestions);
    const { sendText } = setup();
    await act(async () => {
      await sendText("use Zustand for state", { submit: async () => false });
    });
    expect(state.panelBuffers.t1!.sessionCorrectedText).toBe("use zoo stand for state");
    expect(recordSuggestions).not.toHaveBeenCalled();
  });

  it("diffs against the baseline the send began with, and leaves a newer one alone (#14645)", async () => {
    const recordSuggestions = vi.fn().mockResolvedValue(undefined);
    const state = learning(recordSuggestions);
    const { sendText } = setup();
    await act(async () => {
      await sendText("use Zustand for state", {
        submit: async () => {
          // A dictation finishing while the submit is on its way.
          state.panelBuffers.t1 = {
            sessionCorrectedText: "next passage",
            sessionDraftStart: 30,
            dictationSessionId: "s2",
          };
          return true;
        },
      });
    });

    await vi.waitFor(() =>
      expect(recordSuggestions).toHaveBeenCalledWith({
        candidates: [{ word: "Zustand", original: "zoo stand" }],
      })
    );
    expect(state.panelBuffers.t1!.sessionCorrectedText).toBe("next passage");
  });

  it("leaves a newer session's baseline that says the same words (#14645)", async () => {
    const state = learning(vi.fn().mockResolvedValue(undefined));
    const { sendText } = setup();
    await act(async () => {
      await sendText("use Zustand for state", {
        submit: async () => {
          state.panelBuffers.t1 = { ...state.panelBuffers.t1!, dictationSessionId: "s2" };
          return true;
        },
      });
    });
    expect(state.panelBuffers.t1!.sessionCorrectedText).toBe("use zoo stand for state");
  });

  it("leaves the baseline of a draft under another key alone (#14645)", async () => {
    const recordSuggestions = vi.fn();
    const state = learning(recordSuggestions);
    state.panelBuffers.t1!.projectId = "project-a";
    const { sendText } = setup({ projectId: "isolated-composer" });
    await act(async () => {
      await sendText("use Zustand for state");
    });
    expect(state.panelBuffers.t1!.sessionCorrectedText).toBe("use zoo stand for state");
    expect(recordSuggestions).not.toHaveBeenCalled();
  });

  it("compares only the dictated part of the draft, in its sentence (#14645)", async () => {
    const recordSuggestions = vi.fn().mockResolvedValue(undefined);
    const state = learning(recordSuggestions, true, null);
    state.panelBuffers.t1 = {
      ...state.panelBuffers.t1!,
      sessionCorrectedText: "daintree first",
      sessionDraftStart: 5,
    };
    dictated("open Daintree first", "Daintree first");
    const { sendText } = setup();
    await act(async () => {
      await sendText("open Daintree first");
    });
    await vi.waitFor(() =>
      expect(recordSuggestions).toHaveBeenCalledWith({
        candidates: [{ word: "Daintree", original: "daintree" }],
      })
    );
  });

  it("learns only from words dictated between the user's own text (#14634)", async () => {
    const recordSuggestions = vi.fn().mockResolvedValue(undefined);
    const state = learning(recordSuggestions, true, null);
    const unsubscribe = subscribeDictationRangeTracking();
    try {
      const inputs = useTerminalInputStore.getState();
      const typed = "Ask about state. Then ship it.";
      inputs.setDraftInput("t1", typed);
      // Dictated at the caret after the first sentence, written as the voice service writes it.
      const plan = planVoiceWords(typed, { from: 16, to: 16, edited: false }, "use zoo stand");
      inputs.setDraftInput("t1", plan.next);
      useDictationRangeStore
        .getState()
        .recordUtterance(
          { sessionId: "s1", panelId: "t1" },
          { insertion: plan.insertion, words: plan.words }
        );
      expect(inputs.getDraftInput("t1")).toBe("Ask about state. use zoo stand Then ship it.");
      state.panelBuffers.t1 = {
        ...state.panelBuffers.t1!,
        sessionCorrectedText: "use zoo stand",
        sessionDraftStart: plan.words.from,
      };

      // Typing ahead of the dictation moves it; the correction lands inside it.
      inputs.setDraftInput("t1", "Quick: Ask about state. use zoo stand Then ship it.");
      const sent = "Quick: Ask about state. use Zustand Then ship it.";
      inputs.setDraftInput("t1", sent);

      const { sendText } = setup();
      await act(async () => {
        await sendText(sent);
      });

      await vi.waitFor(() => expect(recordSuggestions).toHaveBeenCalledTimes(1));
      expect(recordSuggestions).toHaveBeenCalledWith({
        candidates: [{ word: "Zustand", original: "zoo stand" }],
      });
    } finally {
      unsubscribe();
    }
  });
});
