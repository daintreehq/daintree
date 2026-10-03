// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetRunningPluginActionsForTest,
  applyRunningPluginActions,
  authoredRunningActions,
  getRunningPluginActionsSnapshot,
  installRunningPluginActions,
  isPluginActionRunning,
  subscribeToRunningPluginActions,
} from "../runningPluginActions";
import { makeProjectPluginInstanceKey } from "@shared/types/plugin";

afterEach(() => _resetRunningPluginActionsForTest());

describe("runningPluginActions", () => {
  it("replaces one plugin's set at a time and drops it when empty", () => {
    applyRunningPluginActions("acme.ledger", ["acme.ledger.refresh"]);
    applyRunningPluginActions("acme.board", ["acme.board.sync"]);
    applyRunningPluginActions("acme.ledger", []);

    const running = getRunningPluginActionsSnapshot();
    expect(isPluginActionRunning(running, "acme.ledger.refresh")).toBe(false);
    expect(isPluginActionRunning(running, "acme.board.sync")).toBe(true);
    expect([...running.keys()]).toEqual(["acme.board"]);
  });

  it("notifies only when a plugin's set actually changes", () => {
    const listener = vi.fn();
    subscribeToRunningPluginActions(listener);
    applyRunningPluginActions("acme.ledger", ["acme.ledger.refresh"]);
    applyRunningPluginActions("acme.ledger", ["acme.ledger.refresh"]);
    applyRunningPluginActions("acme.board", []);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("subscribes to main on the first listener", () => {
    let push: ((payload: { pluginId: string; actionIds: string[] }) => void) | undefined;
    const onActionsRunningChanged = vi.fn((callback: typeof push) => {
      push = callback;
      return () => {};
    });
    const win = window as unknown as { electron?: unknown };
    const previous = win.electron;
    win.electron = { plugin: { onActionsRunningChanged } };
    try {
      subscribeToRunningPluginActions(() => {});
      subscribeToRunningPluginActions(() => {});
      expect(onActionsRunningChanged).toHaveBeenCalledTimes(1);
      push?.({ pluginId: "acme.ledger", actionIds: ["acme.ledger.refresh"] });
      expect(isPluginActionRunning(getRunningPluginActionsSnapshot(), "acme.ledger.refresh")).toBe(
        true
      );
    } finally {
      win.electron = previous;
    }
  });

  it("keeps a run main reported before any toolbar or view subscribed", () => {
    let push: ((payload: { pluginId: string; actionIds: string[] }) => void) | undefined;
    const win = window as unknown as { electron?: unknown };
    const previous = win.electron;
    win.electron = {
      plugin: {
        onActionsRunningChanged: (callback: typeof push) => {
          push = callback;
          return () => {};
        },
      },
    };
    try {
      installRunningPluginActions();
      push?.({ pluginId: "acme.ledger", actionIds: ["acme.ledger.refresh"] });

      const listener = vi.fn();
      subscribeToRunningPluginActions(listener);
      expect(isPluginActionRunning(getRunningPluginActionsSnapshot(), "acme.ledger.refresh")).toBe(
        true
      );
    } finally {
      win.electron = previous;
    }
  });

  it("names a project instance's actions as its manifest writes them", () => {
    const instance = makeProjectPluginInstanceKey("a".repeat(64), "acme.ledger");
    applyRunningPluginActions(instance, [`${instance}.refresh-quotes`]);
    applyRunningPluginActions("acme.board", ["acme.board.sync"]);
    const running = getRunningPluginActionsSnapshot();

    expect(authoredRunningActions(running, instance)).toEqual(["acme.ledger.refresh-quotes"]);
    expect(authoredRunningActions(running, "acme.board")).toEqual(["acme.board.sync"]);
    expect(authoredRunningActions(running, "acme.idle")).toEqual([]);
  });
});
