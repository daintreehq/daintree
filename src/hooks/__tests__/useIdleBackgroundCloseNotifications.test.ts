// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { IdleBackgroundClosedPayload } from "@shared/types";

const onClosedMock = vi.hoisted(() =>
  vi.fn<(callback: (payload: IdleBackgroundClosedPayload) => void) => () => void>(() => () => {})
);
const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients/idleBackgroundAutoCloseClient", () => ({
  idleBackgroundAutoCloseClient: { onClosed: onClosedMock },
}));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("../useElectron", () => ({ isElectronAvailable: () => true }));

import {
  formatProjectNames,
  useIdleBackgroundCloseNotifications,
} from "../useIdleBackgroundCloseNotifications";

describe("formatProjectNames", () => {
  it.each([
    [["Alpha"], '"Alpha"'],
    [["Alpha", "Beta"], '"Alpha" and "Beta"'],
    [["Alpha", "Beta", "Gamma"], '"Alpha", "Beta" and "Gamma"'],
    [["A", "B", "C", "D"], '"A", "B", "C" and 1 other project'],
    [["A", "B", "C", "D", "E"], '"A", "B", "C" and 2 other projects'],
  ])("names %j as %s", (names, expected) => {
    expect(formatProjectNames(names)).toBe(expected);
  });
});

describe("useIdleBackgroundCloseNotifications", () => {
  // The listener is an app-lifetime singleton, so it is subscribed once for
  // the whole file and every case drives that one callback.
  let deliver: (payload: IdleBackgroundClosedPayload) => void;

  beforeEach(() => {
    if (onClosedMock.mock.calls.length === 0) {
      renderHook(() => useIdleBackgroundCloseNotifications());
    }
    deliver = onClosedMock.mock.calls[0]![0];
    notifyMock.mockClear();
  });

  it("subscribes once however often it mounts", () => {
    renderHook(() => useIdleBackgroundCloseNotifications());
    expect(onClosedMock).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for an empty sweep", () => {
    deliver({ projects: [], timestamp: 1 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("files one inbox-only row for a project, scoped to it", () => {
    deliver({ projects: [{ projectId: "p1", projectName: "Alpha" }], timestamp: 1 });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Project slept",
        priority: "low",
        inboxMessage: '"Alpha" was put to sleep to free memory. Reopen it any time.',
        context: { eventKind: "host", projectId: "p1" },
      })
    );
  });

  it("files one row naming every project a sweep slept", () => {
    deliver({
      projects: [
        { projectId: "p1", projectName: "Alpha" },
        { projectId: "p2", projectName: "Beta" },
      ],
      timestamp: 1,
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Projects slept",
        inboxMessage: '"Alpha" and "Beta" were put to sleep to free memory. Reopen them any time.',
        context: { eventKind: "host", projectId: undefined },
      })
    );
  });
});
