// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const onConfigReloadedMock = vi.hoisted(() => vi.fn<(cb: () => void | Promise<void>) => void>());
const userAgentRefreshMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const agentSettingsRefreshMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const loadOverridesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const reloadConfigMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/clients", () => ({
  appClient: { getState: vi.fn(), setState: vi.fn() },
}));
vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: { setColorScheme: vi.fn() },
}));
vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: { getState: () => ({ refresh: userAgentRefreshMock }) },
}));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => ({ refresh: agentSettingsRefreshMock }) },
}));
vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: { getState: () => ({}) },
}));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: { getState: () => ({ addNotification: vi.fn() }) },
}));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { loadOverrides: loadOverridesMock },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@shared/theme", () => ({
  getBuiltInAppSchemeForType: vi.fn(),
  resolveAppTheme: vi.fn(),
}));

import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const APP_CONFIG_RELOAD_LISTENER_STATE_KEY = "__canopyAppConfigReloadListenerState";

let registerAppActions: typeof import("../appActions").registerAppActions;

async function loadFreshModule() {
  vi.resetModules();
  const mod = await import("../appActions");
  registerAppActions = mod.registerAppActions;
}

beforeEach(async () => {
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, APP_CONFIG_RELOAD_LISTENER_STATE_KEY);
  Object.defineProperty(globalThis, "window", {
    value: {
      electron: {
        window: { openNew: vi.fn() },
        app: {
          reloadConfig: reloadConfigMock,
          onConfigReloaded: onConfigReloadedMock,
        },
      },
    },
    configurable: true,
    writable: true,
  });
  await loadFreshModule();
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  Reflect.deleteProperty(globalThis, APP_CONFIG_RELOAD_LISTENER_STATE_KEY);
});

function register() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    onOpenSettings: vi.fn(),
    onOpenSettingsTab: vi.fn(),
  } as unknown as ActionCallbacks;
  registerAppActions(actions, callbacks);
  return actions;
}

describe("appActions adversarial", () => {
  it("registering twice does not subscribe onConfigReloaded more than once", () => {
    register();
    register();

    expect(onConfigReloadedMock).toHaveBeenCalledTimes(1);
  });

  it("module reloads reuse a single onConfigReloaded subscription", async () => {
    register();
    const cb = onConfigReloadedMock.mock.calls[0][0];

    await loadFreshModule();
    register();

    expect(onConfigReloadedMock).toHaveBeenCalledTimes(1);

    await cb();

    expect(userAgentRefreshMock).toHaveBeenCalledTimes(1);
    expect(agentSettingsRefreshMock).toHaveBeenCalledTimes(1);
    expect(loadOverridesMock).toHaveBeenCalledTimes(1);
  });

  it("onConfigReloaded callback triggers the refresh fan-out", async () => {
    register();
    const cb = onConfigReloadedMock.mock.calls[0][0];
    await cb();

    expect(userAgentRefreshMock).toHaveBeenCalledTimes(1);
    expect(agentSettingsRefreshMock).toHaveBeenCalledTimes(1);
    expect(loadOverridesMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("cliAvailability.refresh", undefined, {
      source: "agent",
    });
  });

  it("refresh-fan-out failure is caught and does not escape the onConfigReloaded callback", async () => {
    register();
    userAgentRefreshMock.mockRejectedValueOnce(new Error("boom"));
    const cb = onConfigReloadedMock.mock.calls[0][0];

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(cb()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("app.reloadConfig dispatches the main-process reload via electron bridge", async () => {
    const actions = register();
    const factory = actions.get("app.reloadConfig");
    if (!factory) throw new Error("missing action");
    const def = factory();
    await (def.run as (a: unknown, c: unknown) => Promise<unknown>)(undefined, {});

    expect(reloadConfigMock).toHaveBeenCalledTimes(1);
  });

  it("subscription is skipped entirely when electron bridge is missing", () => {
    Object.defineProperty(globalThis, "window", {
      value: { electron: { window: { openNew: vi.fn() } } },
      configurable: true,
    });

    register();
    expect(onConfigReloadedMock).not.toHaveBeenCalled();
  });
});
