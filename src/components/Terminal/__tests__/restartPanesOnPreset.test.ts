import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const announceMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => notifyMock(...args) }));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import { restartPanesOnPreset } from "../restartPanesOnPreset";
import { usePanelStore } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";

const preset = { id: "work", name: "Work" };
const refused = (message: string) => ({
  ok: false,
  error: { code: "EXECUTION_ERROR", message },
});

// Open panes the toast may point at; tests close them by deleting entries.
function openPanes(...ids: string[]) {
  const pane = (id: string): PtyPanelData => ({
    id,
    kind: "terminal",
    title: id,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    worktreeId: `wt-${id}`,
  });
  usePanelStore.setState({
    panelsById: Object.fromEntries(ids.map((id) => [id, pane(id)])),
    panelIds: ids,
  });
}

beforeEach(() => {
  openPanes("t1", "a", "b", "c", "d", "busy");
  dispatchMock.mockReset();
  notifyMock.mockReset();
  announceMock.mockReset();
});

describe("restartPanesOnPreset", () => {
  it("announces a restart that started and raises nothing else", async () => {
    dispatchMock.mockResolvedValue({ ok: true, result: {} });

    await restartPanesOnPreset([{ id: "t1", title: "Review" }], preset, "user", () => "Restarted");

    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnPreset",
      { terminalId: "t1", presetId: "work", confirmed: true },
      { source: "user" }
    );
    expect(announceMock).toHaveBeenCalledWith("Restarted");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("names a refused pane and announces nothing for it (#15233)", async () => {
    dispatchMock.mockResolvedValue(refused("already restarting"));

    await restartPanesOnPreset([{ id: "t1", title: "Review" }], preset, "user", () => "Restarted");

    expect(announceMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("Couldn't restart 'Review' on Work");
    expect(toast.message).toBe("'Review' is already restarting.");
    expect(toast.action.actionArgs).toEqual({ panelId: "t1" });
    toast.action.onClick();
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "panel.focus",
      { panelId: "t1" },
      { source: "user" }
    );
  });

  it("counts only the panes that restarted and names each one that didn't", async () => {
    dispatchMock.mockImplementation(async (_id: string, args: { terminalId: string }) => {
      if (args.terminalId === "b") return refused("panel is held for recovery");
      if (args.terminalId === "c") return refused("already restarting");
      return { ok: true, result: {} };
    });

    await restartPanesOnPreset(
      [
        { id: "a", title: "One" },
        { id: "b", title: "Two" },
        { id: "c", title: "Three" },
        { id: "d", title: "Four" },
      ],
      preset,
      "user",
      (count) => `Restarting ${count} panes`
    );

    expect(announceMock).toHaveBeenCalledWith("Restarting 2 panes");
    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.title).toBe("Couldn't restart 2 panes on Work");
    expect(toast.message).toBe("'Two' is waiting to be restored. 'Three' is already restarting.");
    expect(toast.action.actionArgs).toEqual({ panelId: "b" });
  });

  it("treats a rejected dispatch as a refusal rather than losing it", async () => {
    dispatchMock.mockRejectedValue(new Error("boom"));

    await restartPanesOnPreset([{ id: "t1", title: undefined }], preset, "user", () => "Restarted");

    expect(announceMock).not.toHaveBeenCalled();
    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.title).toBe("Couldn't restart the terminal on Work");
    expect(toast.message).toBe("The terminal didn't restart.");
  });

  it("says a missing preset once, rather than blaming each pane", async () => {
    dispatchMock.mockResolvedValue(refused('preset "work" not found'));

    await restartPanesOnPreset(
      [
        { id: "a", title: "One" },
        { id: "b", title: "Two" },
      ],
      preset,
      "user",
      () => "Restarted"
    );

    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.message).toBe("The Work preset is no longer available.");
    expect(toast.message).not.toContain("no longer open");
  });

  it("points Go to terminal at a refused pane that is still open", async () => {
    dispatchMock.mockImplementation(async (_id: string, args: { terminalId: string }) =>
      args.terminalId === "gone" ? refused("terminal not found") : refused("already restarting")
    );

    await restartPanesOnPreset(
      [
        { id: "gone", title: "Closed" },
        { id: "busy", title: "Busy" },
      ],
      preset,
      "user",
      () => "Restarted"
    );

    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.message).toBe("'Closed' is no longer open. 'Busy' is already restarting.");
    expect(toast.action.actionArgs).toEqual({ panelId: "busy" });
  });

  it("offers no way to a pane when every refused one has closed, but keeps its worktree", async () => {
    openPanes("gone");
    dispatchMock.mockImplementation(async () => {
      // Closed while its restart was being refused.
      usePanelStore.setState({ panelsById: {}, panelIds: [] });
      return refused("terminal not found");
    });

    await restartPanesOnPreset([{ id: "gone", title: "Closed" }], preset, "user", () => "x");

    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.action).toBeUndefined();
    expect(toast.message).toBe("'Closed' is no longer open.");
    expect(toast.context).toMatchObject({ worktreeId: "wt-gone" });
  });

  it("skips a refused pane that closed while another restart was still settling", async () => {
    let settle: () => void = () => {};
    dispatchMock.mockImplementation((_id: string, args: { terminalId: string }) => {
      if (args.terminalId === "a") return Promise.resolve(refused("already restarting"));
      return new Promise((resolve) => (settle = () => resolve(refused("already restarting"))));
    });

    const done = restartPanesOnPreset(
      [
        { id: "a", title: "One" },
        { id: "b", title: "Two" },
      ],
      preset,
      "user",
      () => "x"
    );
    openPanes("b");
    settle();
    await done;

    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.action.actionArgs).toEqual({ panelId: "b" });
    expect(toast.context).toMatchObject({ panelId: "b", worktreeId: "wt-b" });
  });
});
