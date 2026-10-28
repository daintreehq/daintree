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
  formatPressureSleptProjects,
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

describe("formatPressureSleptProjects", () => {
  it("names every project with its estimate, however many there are", () => {
    const projects = ["A", "B", "C", "D"].map((name, index) => ({
      projectId: name,
      projectName: name,
      estimatedMemoryKb: (index + 1) * 1024,
    }));
    expect(formatPressureSleptProjects(projects)).toBe(
      '"A" (about 1 MB), "B" (about 2 MB), "C" (about 3 MB) and "D" (about 4 MB)'
    );
  });

  it.each([
    [undefined, '"A"'],
    [0, '"A"'],
    [Number.NaN, '"A"'],
    [200, '"A" (about 1 MB)'],
    [1.5 * 1024 * 1024, '"A" (about 1.5 GB)'],
  ])("reads an estimate of %s KB as %s", (estimatedMemoryKb, expected) => {
    expect(
      formatPressureSleptProjects([{ projectId: "a", projectName: "A", estimatedMemoryKb }])
    ).toBe(expected);
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

  it("keeps the regular copy for an idle sweep that carries estimates", () => {
    deliver({
      projects: [{ projectId: "p1", projectName: "Alpha", estimatedMemoryKb: 98_304 }],
      timestamp: 1,
      trigger: "idle",
    });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxMessage: '"Alpha" was put to sleep to free memory. Reopen it any time.',
      })
    );
  });

  it("says memory ran low and what each project held after a pressure sweep", () => {
    deliver({
      projects: [
        { projectId: "p1", projectName: "Alpha", estimatedMemoryKb: 98_304 },
        { projectId: "p2", projectName: "Beta", estimatedMemoryKb: 24_576 },
      ],
      timestamp: 1,
      trigger: "memory-pressure",
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Projects slept",
        priority: "low",
        inboxMessage:
          'Memory ran low, so "Alpha" (about 96 MB) and "Beta" (about 24 MB) were put to sleep. Reopen them any time.',
        context: { eventKind: "host", projectId: undefined },
      })
    );
  });

  it("scopes a single-project pressure row to that project", () => {
    deliver({
      projects: [{ projectId: "p1", projectName: "Alpha", estimatedMemoryKb: 98_304 }],
      timestamp: 1,
      trigger: "memory-pressure",
    });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Project slept",
        inboxMessage:
          'Memory ran low, so "Alpha" (about 96 MB) was put to sleep. Reopen it any time.',
        context: { eventKind: "host", projectId: "p1" },
      })
    );
  });
});
