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
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import type { ActionContext, ActionDefinition } from "@shared/types/actions";

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
  toggle: ActionDefinition;
  pick: ActionDefinition;
} {
  const registry = new Map<string, () => ActionDefinition>();
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
    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", message: "Theme: Light A" })
    );
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
    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", message: "Theme: Dark A" })
    );
  });

  it("is a no-op when target equals current scheme", async () => {
    // Degenerate but valid: light preference points to the currently-selected dark scheme.
    // toggle should detect target === selected and bail out without persisting or notifying.
    mockGetThemeState.mockReturnValue({
      selectedSchemeId: "dark-a",
      customSchemes: [darkA, lightA],
      preferredDarkSchemeId: "dark-b",
      preferredLightSchemeId: "dark-a",
      setSelectedSchemeId: mockSetSelectedSchemeId,
    });

    const { toggle } = getActions();
    await toggle.run(undefined, stubCtx);

    expect(mockSetSelectedSchemeId).not.toHaveBeenCalled();
    expect(mockSetColorScheme).not.toHaveBeenCalled();
    expect(mockAddNotification).not.toHaveBeenCalled();
  });
});

describe("app.theme.pick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "window", {
      value: { dispatchEvent: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  it("dispatches canopy:open-theme-palette event", async () => {
    const { pick } = getActions();
    await pick.run(undefined, stubCtx);
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
    const event = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as Event;
    expect(event.type).toBe("canopy:open-theme-palette");
  });

  it("has correct metadata", () => {
    const { pick, toggle } = getActions();
    expect(pick.id).toBe("app.theme.pick");
    expect(pick.category).toBe("app");
    expect(pick.danger).toBe("safe");
    expect(toggle.id).toBe("app.theme.toggle");
    expect(toggle.category).toBe("app");
    expect(toggle.danger).toBe("safe");
  });
});
