// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
const exportMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({ appClient: { getState: vi.fn(), setState: vi.fn() } }));
vi.mock("@/clients/appThemeClient", () => ({ appThemeClient: { setColorScheme: vi.fn() } }));
vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: { getState: () => ({ refresh: vi.fn() }) },
}));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => ({ refresh: vi.fn() }) },
}));
vi.mock("@/store/appThemeStore", () => ({ useAppThemeStore: { getState: () => ({}) } }));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: { getState: () => ({ addNotification: vi.fn() }) },
}));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { loadOverrides: vi.fn() },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@shared/theme", () => ({
  getBuiltInAppSchemeForType: vi.fn(),
  resolveAppTheme: vi.fn(),
}));

import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import { registerAppActions } from "../appActions";

async function runExport() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = Object.create(null);
  registerAppActions(actions, callbacks);
  const def = actions.get("app.exportConfig")!();
  await def.run(undefined, Object.create(null));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "window", {
    value: {
      electron: {
        app: { reloadConfig: vi.fn(), onConfigReloaded: vi.fn() },
        configBundle: { export: exportMock },
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
});

describe("app.exportConfig notifications", () => {
  it("raises nothing for a clean export to a destination the user chose", async () => {
    exportMock.mockResolvedValue({ outcome: "saved", omittedSecretPaths: [] });
    await runExport();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises nothing when the save dialog is canceled", async () => {
    exportMock.mockResolvedValue({ outcome: "canceled", omittedSecretPaths: [] });
    await runExport();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("still says when values that looked like secrets were left out", async () => {
    exportMock.mockResolvedValue({ outcome: "saved", omittedSecretPaths: ["a.token", "b.key"] });
    await runExport();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0].message).toContain("2 values that looked like secrets");
  });

  it("still reports a failed export", async () => {
    exportMock.mockRejectedValue(new Error("EACCES"));
    await runExport();
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});
