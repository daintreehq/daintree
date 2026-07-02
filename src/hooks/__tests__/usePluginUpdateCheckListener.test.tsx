/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import type { PluginBackgroundUpdateCheckResult } from "@shared/types/plugin";

const notifyMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { usePluginUpdateCheckListener } from "../usePluginUpdateCheckListener";

function Harness() {
  usePluginUpdateCheckListener();
  return null;
}

function result(
  updates: Array<{ pluginId: string; version: string }>,
  signature: string
): PluginBackgroundUpdateCheckResult {
  return {
    checkedAt: 1,
    signature,
    updates: updates.map((u) => ({
      pluginId: u.pluginId,
      displayName: u.pluginId,
      version: u.version,
      capabilities: [],
    })),
  };
}

type Listener = (payload: PluginBackgroundUpdateCheckResult) => void;

function installElectron(opts: {
  latest?: PluginBackgroundUpdateCheckResult | null;
  captureListener?: (fn: Listener) => void;
}) {
  const onBackgroundUpdateAvailable = vi.fn((cb: Listener) => {
    opts.captureListener?.(cb);
    return () => {};
  });
  (window as unknown as { electron: unknown }).electron = {
    plugin: {
      getLatestBackgroundUpdateCheck: vi.fn(async () => opts.latest ?? null),
      onBackgroundUpdateAvailable,
    },
  };
  return { onBackgroundUpdateAvailable };
}

describe("usePluginUpdateCheckListener", () => {
  beforeEach(() => {
    notifyMock.mockClear();
    dispatchMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("hydrates from the main-process cache into one low-priority inbox notification", async () => {
    installElectron({ latest: result([{ pluginId: "pub.a", version: "2.0.0" }], "pub.a@2.0.0") });
    render(<Harness />);

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.priority).toBe("low");
    expect(payload.supersedeKey).toBe("plugin-updates-available");
    expect(payload.action.actionId).toBe("app.pluginManager");
    expect(payload.message).toContain("1 plugin update");
  });

  it("pluralizes the message for multiple updates", async () => {
    installElectron({
      latest: result(
        [
          { pluginId: "pub.a", version: "2.0.0" },
          { pluginId: "pub.b", version: "3.0.0" },
        ],
        "pub.a@2.0.0,pub.b@3.0.0"
      ),
    });
    render(<Harness />);

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    expect(notifyMock.mock.calls[0]![0].message).toContain("2 plugin updates");
  });

  it("surfaces live events and dedupes a repeated signature in-session", async () => {
    let listener: Listener | undefined;
    installElectron({ latest: null, captureListener: (fn) => (listener = fn) });
    render(<Harness />);

    await waitFor(() => expect(listener).toBeDefined());
    const r = result([{ pluginId: "pub.a", version: "2.0.0" }], "pub.a@2.0.0");
    listener!(r);
    listener!(r); // same signature — ignored
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // A new signature re-notifies.
    listener!(result([{ pluginId: "pub.a", version: "3.0.0" }], "pub.a@3.0.0"));
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("does not notify when there are no updates", async () => {
    let listener: Listener | undefined;
    installElectron({ latest: null, captureListener: (fn) => (listener = fn) });
    render(<Harness />);
    await waitFor(() => expect(listener).toBeDefined());
    listener!(result([], ""));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("the notification action falls back to dispatching the plugin manager", async () => {
    installElectron({ latest: result([{ pluginId: "pub.a", version: "2.0.0" }], "pub.a@2.0.0") });
    render(<Harness />);
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    notifyMock.mock.calls[0]![0].action.onClick();
    expect(dispatchMock).toHaveBeenCalledWith("app.pluginManager", undefined, { source: "user" });
  });
});
