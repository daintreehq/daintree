import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetHostSwitchRequestsForTesting,
  currentHostSwitchRequest,
  dismissHostSwitchRequest,
  registerHostSwitchDialogHost,
  requestHostSwitch,
  subscribeHostSwitchRequests,
} from "../hostSwitchRequests";

beforeEach(() => _resetHostSwitchRequestsForTesting());

describe("host switch requests", () => {
  it("refuses a request no dialog host can show", () => {
    expect(requestHostSwitch({ toHostId: "studio-01", projectId: "p", worktreePath: null })).toBe(
      false
    );
    expect(currentHostSwitchRequest()).toBeNull();
  });

  it("publishes a request to the mounted host and clears it on dismiss or unmount", () => {
    const release = registerHostSwitchDialogHost();
    const listener = vi.fn();
    subscribeHostSwitchRequests(listener);
    expect(requestHostSwitch({ toHostId: "studio-01", projectId: "p", worktreePath: "/w" })).toBe(
      true
    );
    const request = currentHostSwitchRequest()!;
    expect(request).toMatchObject({ toHostId: "studio-01", worktreePath: "/w" });
    dismissHostSwitchRequest(request.id + 1);
    expect(currentHostSwitchRequest()).toBe(request);
    dismissHostSwitchRequest(request.id);
    expect(currentHostSwitchRequest()).toBeNull();
    requestHostSwitch({ toHostId: "studio-01", projectId: "p", worktreePath: null });
    release();
    expect(currentHostSwitchRequest()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
