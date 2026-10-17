import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppColorScheme } from "@shared/types/appTheme";

const mockSetColorScheme = vi.fn().mockResolvedValue(undefined);
vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: (...args: unknown[]) => mockSetColorScheme(...args),
  },
}));

const mockSetSelectedSchemeId = vi.fn();
const mockGetThemeState = vi.fn();
vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: { getState: () => mockGetThemeState() },
}));

const mockAddNotification = vi.fn();
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: { getState: () => ({ addNotification: mockAddNotification }) },
}));

const mockNotify = vi.fn().mockReturnValue("test-id");
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

vi.mock("@/clients", () => ({ appClient: {} }));
vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: { getState: () => ({ refresh: vi.fn() }) },
}));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => ({ refresh: vi.fn() }) },
}));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { loadOverrides: vi.fn() },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import { registerAppActions } from "../appActions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

const stubCtx: ActionContext = {};

function makeScheme(id: string, type: "dark" | "light", name: string): AppColorScheme {
  return {
    id,
    name,
    type,
    builtin: true,
    tokens: {} as AppColorScheme["tokens"],
    palette: {} as AppColorScheme["palette"],
  };
}

const darkA = makeScheme("dark-a", "dark", "Dark A");
const lightA = makeScheme("light-a", "light", "Light A");
const darkB = makeScheme("dark-b", "dark", "Dark B");

function getActions(): {
  toggle: AnyActionDefinition;
  pick: AnyActionDefinition;
} {
  const registry = new Map<string, () => AnyActionDefinition>();
  const callbacks = {
    onOpenSettings: vi.fn(),
    onOpenSettingsTab: vi.fn(),
  } as unknown as ActionCallbacks;
  registerAppActions(registry as unknown as ActionRegistry, callbacks);
  const toggle = registry.get("app.theme.toggle")?.();
  const pick = registry.get("app.theme.pick")?.();
  if (!toggle || !pick) throw new Error("theme actions not registered");
  return { toggle, pick };
}

describe("app.theme.toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "window", {
      value: { dispatchEvent: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  it("switches from dark to preferred light scheme and persists", async () => {
    mockGetThemeState.mockReturnValue({
      selectedSchemeId: "dark-a",
      customSchemes: [darkA, darkB, lightA],
      preferredDarkSchemeId: "dark-b",
      preferredLightSchemeId: "light-a",
      setSelectedSchemeId: mockSetSelectedSchemeId,
    });

    const { toggle } = getActions();
    await toggle.run(undefined, stubCtx);

    expect(mockSetSelectedSchemeId).toHaveBeenCalledWith("light-a");
    expect(mockSetColorScheme).toHaveBeenCalledWith("light-a");
    // Success path is silent — the repainted UI is the confirmation.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("switches from light to preferred dark scheme and persists", async () => {
    mockGetThemeState.mockReturnValue({
      selectedSchemeId: "light-a",
      customSchemes: [darkA, lightA],
      preferredDarkSchemeId: "dark-a",
      preferredLightSchemeId: "light-a",
      setSelectedSchemeId: mockSetSelectedSchemeId,
    });

    const { toggle } = getActions();
    await toggle.run(undefined, stubCtx);

    expect(mockSetSelectedSchemeId).toHaveBeenCalledWith("dark-a");
    expect(mockSetColorScheme).toHaveBeenCalledWith("dark-a");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("falls back to built-in scheme of correct type when preferred ID points to wrong type", async () => {
    // preferredDarkSchemeId mis-points to a light scheme — fallback must yield a dark scheme.
    mockGetThemeState.mockReturnValue({
      selectedSchemeId: "light-a",
      customSchemes: [darkA, lightA],
      preferredDarkSchemeId: "light-a", // wrong type
      preferredLightSchemeId: "light-a",
      setSelectedSchemeId: mockSetSelectedSchemeId,
    });

    const { toggle } = getActions();
    await toggle.run(undefined, stubCtx);

    expect(mockSetSelectedSchemeId).toHaveBeenCalledTimes(1);
    const selectedId = mockSetSelectedSchemeId.mock.calls[0]![0] as string;
    // Must NOT be light-a (the wrong-type fallback). Must be some built-in dark scheme.
    expect(selectedId).not.toBe("light-a");
    expect(mockSetColorScheme).toHaveBeenCalledWith(selectedId);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("shows error toast when persistence fails, skips success toast", async () => {
    mockGetThemeState.mockReturnValue({
      selectedSchemeId: "dark-a",
      customSchemes: [darkA, lightA],
      preferredDarkSchemeId: "dark-a",
      preferredLightSchemeId: "light-a",
      setSelectedSchemeId: mockSetSelectedSchemeId,
    });
    mockSetColorScheme.mockRejectedValueOnce(new Error("disk full"));

    const { toggle } = getActions();
    await toggle.run(undefined, stubCtx);

    expect(mockSetSelectedSchemeId).toHaveBeenCalledWith("light-a");
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message:
          "Couldn't save theme preference — 'Light A' is applied but the choice will be lost on restart.",
      })
    );
    expect(mockNotify).not.toHaveBeenCalledWith(expect.objectContaining({ priority: "low" }));
    expect(mockAddNotification).not.toHaveBeenCalled();
  });
});
