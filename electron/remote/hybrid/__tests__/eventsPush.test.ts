import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import { acceptHostPush, acceptLocalPushForRemoteView } from "../eventsPush.js";

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
