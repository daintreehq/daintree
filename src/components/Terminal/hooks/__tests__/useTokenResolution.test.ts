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
  return { sendText: result.current.sendText, onSend, addToHistory };
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
