import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import {
  acceptHostPush,
  acceptLocalPushForRemoteView,
  systemMemoryEpisodeOf,
} from "../eventsPush.js";

const copiesToast = {
  type: "warning",
  title: "Multiple Claude installations found",
  message: "Launches /a/claude. Also found: /b/claude.",
  agentCliCopies: { agentId: "claude" },
};
const ordinaryToast = { type: "info", message: "Theme switched" };

describe("toast routing for a remote-bound view (#16409)", () => {
  it("takes a duplicate-install toast from the host, whose copies its settings show", () => {
    expect(acceptHostPush(CHANNELS.NOTIFICATION_SHOW_TOAST, [copiesToast])).toBe(true);
  });

  it("withholds this machine's duplicate-install toast, which would open the host's list", () => {
    expect(acceptLocalPushForRemoteView(CHANNELS.NOTIFICATION_SHOW_TOAST, [copiesToast])).toBe(
      false
    );
  });

  it("leaves every other toast as this machine's to raise", () => {
    expect(acceptHostPush(CHANNELS.NOTIFICATION_SHOW_TOAST, [ordinaryToast])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.NOTIFICATION_SHOW_TOAST, [ordinaryToast])).toBe(
      true
    );
  });

  it.each([
    ["pluginActions", { pluginActions: [{ label: "View copies", actionId: "app.forceQuit" }] }],
    ["action", { action: { label: "View copies", ipcChannel: "clipboard:write-text", data: "x" } }],
    ["hostSwitchFailure", { hostSwitchFailure: { hostId: "h", projectId: "p", code: null } }],
    ["urgent", { urgent: true }],
    ["context", { context: { projectId: "p" } }],
  ])("drops a host's duplicate-install toast that also carries %s", (_field, extra) => {
    expect(acceptHostPush(CHANNELS.NOTIFICATION_SHOW_TOAST, [{ ...copiesToast, ...extra }])).toBe(
      false
    );
  });

  it.each([
    [{ ...ordinaryToast, agentCliCopies: {} }],
    [{ ...ordinaryToast, agentCliCopies: { agentId: "" } }],
    [{ ...ordinaryToast, agentCliCopies: { agentId: 7 } }],
    [{ ...ordinaryToast, agentCliCopies: null }],
    [null],
  ])("won't let %j pass from a host as a duplicate-install toast", (payload) => {
    expect(acceptHostPush(CHANNELS.NOTIFICATION_SHOW_TOAST, [payload])).toBe(false);
  });
});

describe("memory episode routing for a remote-bound view (#18275)", () => {
  const episode = {
    name: "system:memory-pressure",
    payload: {
      status: "degraded",
      swapUsedPercent: 85,
      swapKind: "swap",
      fseventsdRssMb: null,
      kernelPressureLevel: null,
      escalated: false,
      workloads: null,
    },
  };

  // Carried on the same channel, and still this machine's to say.
  const wake = { name: "system:wake", payload: {} };

  const recovery = { ...episode, payload: { ...episode.payload, status: "normal" } };

  it("takes the host's episode, which describes the machine the view's project runs on", () => {
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, [episode])).toBe(true);
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, [recovery])).toBe(true);
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, [wake])).toBe(false);
  });

  it("withholds this machine's episode, which isn't the host's", () => {
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, [episode])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, [recovery])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, [wake])).toBe(true);
  });

  it("picks the episode out of the push that carries it, and nothing else", () => {
    const recovered = { ...episode.payload, status: "normal", episodeId: "ep-1", extra: 1 };
    expect(systemMemoryEpisodeOf(CHANNELS.EVENTS_PUSH, [episode])).toBe(episode.payload);
    expect(systemMemoryEpisodeOf(CHANNELS.EVENTS_PUSH, [{ ...episode, payload: recovered }])).toBe(
      recovered
    );
    expect(
      systemMemoryEpisodeOf(CHANNELS.EVENTS_PUSH, [{ name: "agent:detected", payload: {} }])
    ).toBeNull();
    expect(systemMemoryEpisodeOf(CHANNELS.NOTIFICATION_SHOW_TOAST, [episode])).toBeNull();
  });

  it("marks an episode it can't read, so none reaches a view unnamed", () => {
    for (const payload of [
      { status: "unknown" },
      null,
      "degraded",
      { ...episode.payload, workloads: {} },
      { ...episode.payload, swapUsedPercent: "85" },
    ]) {
      expect(
        systemMemoryEpisodeOf(CHANNELS.EVENTS_PUSH, [{ name: "system:memory-pressure", payload }])
      ).toBe("unsupported");
    }
  });
});
