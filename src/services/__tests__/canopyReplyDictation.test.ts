import { describe, expect, it } from "vitest";
import { isolatedComposerScope, makeDraftKey } from "@/lib/draftKey";
import {
  NO_CANOPY_REPLY,
  canopyReplyVoiceId,
  registerCanopyReplyDictation,
  resolveCanopyReplyDictation,
  voiceContext,
} from "../canopyReplyDictation";

describe("canopyReplyVoiceId", () => {
  it.each([
    ["this host's", undefined],
    ["another host's", "host-2"],
  ])("addresses %s reply draft with no project", (_where, hostId) => {
    expect(makeDraftKey(canopyReplyVoiceId("run-1", hostId))).toBe(
      makeDraftKey("run-1", isolatedComposerScope(hostId))
    );
  });

  it("keeps the same run's reply apart from the pane's own and from another host's", () => {
    const ids = new Set([
      "run-1",
      canopyReplyVoiceId("run-1"),
      canopyReplyVoiceId("run-1", "host-2"),
      canopyReplyVoiceId("run-1", "host-3"),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe("voiceContext", () => {
  it("reads a pane's context from its own terminal", () => {
    expect(voiceContext({ panelId: "term-1" })).toEqual({ terminalId: "term-1" });
  });

  it("reads a reply's from the terminal it types to, never its own id", () => {
    expect(
      voiceContext({
        panelId: canopyReplyVoiceId("run-1"),
        surface: "canopy-reply",
        terminalId: "run-1",
      })
    ).toEqual({ terminalId: "run-1" });
  });

  it("names no terminal for a reply main can't read context from, and says it is outside the view", () => {
    expect(
      voiceContext({
        panelId: canopyReplyVoiceId("run-1", "host-2"),
        surface: "canopy-reply",
        otherHostId: "host-2",
      })
    ).toEqual({ outsideView: true });
  });
});

describe("registerCanopyReplyDictation", () => {
  it("refuses with nothing registered", () => {
    expect(resolveCanopyReplyDictation()).toBe(NO_CANOPY_REPLY);
  });

  it("answers from the latest view, and an older view's cleanup can't remove it", () => {
    const first = { ok: false as const, message: "first" };
    const second = { ok: false as const, message: "second" };
    const unregisterFirst = registerCanopyReplyDictation(() => first);
    const unregisterSecond = registerCanopyReplyDictation(() => second);

    unregisterFirst();
    expect(resolveCanopyReplyDictation()).toBe(second);

    unregisterSecond();
    expect(resolveCanopyReplyDictation()).toBe(NO_CANOPY_REPLY);
  });
});
