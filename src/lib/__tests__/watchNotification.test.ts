import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { setPanelStoreAccessor, type PanelStoreSnapshot } from "@/store/storeAccessors";
import { fireWatchNotification } from "../watchNotification";

beforeEach(() => {
  notifyMock.mockReset();
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
});
