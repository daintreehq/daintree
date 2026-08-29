import { describe, expect, it } from "vitest";
import type { DevPreviewSessionState, DevPreviewSessionStatus } from "@shared/types/ipc/devPreview";
import { devServerMenuState } from "../utils/devServerMenuState";

function session(status: DevPreviewSessionStatus): DevPreviewSessionState {
  return {
    panelId: "panel-1",
    projectId: "project-1",
    worktreeId: "wt-1",
    status,
    url: null,
    predictedUrl: null,
    error: null,
    terminalId: null,
    isRestarting: false,
    generation: 1,
    updatedAt: 1,
  };
}

describe("devServerMenuState", () => {
  it("offers nothing when the worktree has never had a dev server", () => {
    expect(devServerMenuState(undefined, false)).toBe("none");
  });

  it.each<DevPreviewSessionStatus>(["running", "starting", "installing", "stopping"])(
    "treats %s as live, so the menu offers restart and stop rather than a start",
    (status) => {
      expect(devServerMenuState(session(status), true)).toBe("running");
    }
  );

  it("treats an errored server as live, because a readiness timeout leaves the process running", () => {
    // The old menu's Stop was a no-op row; the new one must not swing the other
    // way and remove Stop from a process that is still there to be stopped.
    expect(devServerMenuState(session("error"), true)).toBe("running");
  });

  it("restores a session that was running when Daintree last closed", () => {
    // The service keeps a restore manifest for this one, so it revives without
    // needing the panel to still be around.
    expect(devServerMenuState(session("restored-stopped"), false)).toBe("restorable");
  });

  it("offers a start for a server stopped in place, whose panel is still open", () => {
    expect(devServerMenuState(session("stopped"), true)).toBe("restorable");
  });

  it("offers no start once the panel is gone, since the session went with it", () => {
    // Closing the panel broadcasts `stopped` and then deletes the session, but
    // the renderer keeps the snapshot — restarting it would find nothing to
    // revive and silently do nothing.
    expect(devServerMenuState(session("stopped"), false)).toBe("none");
  });
});
