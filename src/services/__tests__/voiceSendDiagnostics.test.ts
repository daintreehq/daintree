import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logInfo } from "@/utils/logger";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { VOICE_SEND_REFUSED_MESSAGE, logVoiceSendRefused } from "../voiceSendDiagnostics";

describe("logVoiceSendRefused (#15704)", () => {
  beforeEach(() => {
    vi.mocked(logInfo).mockClear();
    useVoiceRecordingStore.setState({ panelBuffers: {}, activeTarget: null, status: "idle" });
  });

  afterEach(() => {
    useVoiceRecordingStore.setState({ panelBuffers: {}, activeTarget: null, status: "idle" });
  });

  it("logs one line naming who asked, the panel, the dictation in it, and why", () => {
    useVoiceRecordingStore.getState().beginSession({ panelId: "panel-1" }, "session-9");

    logVoiceSendRefused({ asker: "enter", reason: "already_waiting", panelId: "panel-1" });

    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(VOICE_SEND_REFUSED_MESSAGE, {
      asker: "enter",
      reason: "already_waiting",
      panelId: "panel-1",
      sessionId: "session-9",
    });
  });

  it("names the session it was given, over the one now in the panel", () => {
    useVoiceRecordingStore.getState().beginSession({ panelId: "panel-1" }, "newer");

    logVoiceSendRefused({
      asker: "spoken_send",
      reason: "not_recording",
      panelId: "panel-1",
      sessionId: "older",
    });

    expect(vi.mocked(logInfo).mock.calls[0]![1]).toMatchObject({ sessionId: "older" });
  });

  it("leaves the session empty for a panel with no dictation, and for no panel", () => {
    logVoiceSendRefused({ asker: "enter", reason: "send_held", panelId: "panel-1" });
    logVoiceSendRefused({ asker: "stop_and_send_key", reason: "no_session", panelId: null });

    expect(vi.mocked(logInfo).mock.calls.map(([, context]) => context)).toEqual([
      { asker: "enter", reason: "send_held", panelId: "panel-1", sessionId: null },
      { asker: "stop_and_send_key", reason: "no_session", panelId: null, sessionId: null },
    ]);
  });

  it("logs only those four fields, none of whose names the logger would blank", () => {
    const request = {
      asker: "spoken_send" as const,
      reason: "draft_empty" as const,
      panelId: "panel-1",
      draft: "rotate the staging credentials",
    };

    logVoiceSendRefused(request);

    const context = vi.mocked(logInfo).mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual(["asker", "panelId", "reason", "sessionId"]);
    expect(Object.keys(context).filter((name) => /key/i.test(name))).toEqual([]);
    expect(JSON.stringify(context)).not.toContain("credentials");
  });
});
