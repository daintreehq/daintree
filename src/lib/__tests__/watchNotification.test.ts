import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/Notifications/notificationNavigation", () => ({
  navigateToNotificationSource: navigateMock,
}));

import { setPanelStoreAccessor, type PanelStoreSnapshot } from "@/store/storeAccessors";
import { usePanelStore } from "@/store/panelStore";
import { fireWatchNotification } from "../watchNotification";

beforeEach(() => {
  notifyMock.mockReset();
  navigateMock.mockReset().mockResolvedValue(true);
  usePanelStore.setState({ pingedId: null } as never);
  setPanelStoreAccessor(
    () =>
      ({
        panelsById: { "term-1": { worktreeId: "/repo/wt-a" } },
        panelIds: ["term-1"],
        tabGroups: new Map(),
      }) as unknown as PanelStoreSnapshot
  );
});

describe("fireWatchNotification", () => {
  it.each([
    ["exited", "agent"],
    ["waiting", "agent"],
    ["completed", "completed"],
  ])(
    "addresses the %s notice to the panel and its worktree and opts into suppression",
    (state, kind) => {
      fireWatchNotification("term-1", "Claude", state);
      const payload = notifyMock.mock.calls[0]![0];
      expect(payload.context).toEqual({
        eventKind: kind,
        panelId: "term-1",
        worktreeId: "/repo/wt-a",
      });
      expect(payload.suppressWhenOriginVisible).toBe(true);
    }
  );

  describe.each(["exited", "waiting", "completed"])("Go to terminal on the %s notice", (state) => {
    const goToTerminal = () => {
      fireWatchNotification("term-1", "Claude", state);
      return notifyMock.mock.calls[0]![0].action.onClick() as Promise<void>;
    };

    it("goes to the panel the way the inbox does, worktree first (#16937)", async () => {
      await goToTerminal();
      expect(navigateMock).toHaveBeenCalledWith({ panelId: "term-1" });
      expect(usePanelStore.getState().pingedId).toBe("term-1");
    });

    it("rejects when the panel is gone, so the toast doesn't say it opened", async () => {
      navigateMock.mockResolvedValueOnce(false);
      await expect(goToTerminal()).rejects.toThrow();
      expect(usePanelStore.getState().pingedId).toBeNull();
    });
  });
});
