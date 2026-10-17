import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetHostSwitchRequestsForTesting,
  currentHostSwitchRequest,
  dismissHostSwitchRequest,
  completeHostSwitchRequest,
  onHostSwitchSettled,
  registerHostSwitchDialogHost,
  requestHostSwitch,
  subscribeHostSwitchRequests,
} from "../hostSwitchRequests";

beforeEach(() => _resetHostSwitchRequestsForTesting());

describe("host switch requests", () => {
  it("refuses a request no dialog host can show", () => {
    expect(requestHostSwitch({ toHostId: "studio-01", projectId: "p", worktreePath: null })).toBe(
      null
    );
    expect(currentHostSwitchRequest()).toBeNull();
  });

  it("publishes a request to the mounted host and clears it on dismiss or unmount", () => {
    const release = registerHostSwitchDialogHost();
    const listener = vi.fn();
    subscribeHostSwitchRequests(listener);
    expect(requestHostSwitch({ toHostId: "studio-01", projectId: "p", worktreePath: "/w" })).toBe(
      1
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

  it("tells the requester whether the request completed or was dismissed", () => {
    registerHostSwitchDialogHost();
    const first = requestHostSwitch({ toHostId: "studio-01", projectId: "p", worktreePath: null })!;
    const firstSettled = vi.fn();
    onHostSwitchSettled(first, firstSettled);
    // A second request replaces the first: the first was dismissed.
    const second = requestHostSwitch({
      toHostId: "studio-02",
      projectId: "p",
      worktreePath: null,
    })!;
    expect(firstSettled).toHaveBeenCalledWith("dismissed");
    const secondSettled = vi.fn();
    onHostSwitchSettled(second, secondSettled);
    completeHostSwitchRequest(second);
    expect(secondSettled).toHaveBeenCalledExactlyOnceWith("completed");
    expect(currentHostSwitchRequest()).toBeNull();
    dismissHostSwitchRequest(second);
    expect(secondSettled).toHaveBeenCalledTimes(1);
    // Asking after the fact answers at once.
    const late = vi.fn();
    onHostSwitchSettled(first, late);
    expect(late).toHaveBeenCalledWith("dismissed");
  });
});
