import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CliAvailability } from "@shared/types";

const mockDispatch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: mockDispatch },
}));

const mockNotify = vi.fn().mockReturnValue("");
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

const mockGetAgentPrefsState = vi.fn();
vi.mock("@/store/agentPreferencesStore", () => ({
  useAgentPreferencesStore: { getState: () => mockGetAgentPrefsState() },
}));

const mockGetCliAvailabilityState = vi.fn();
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: { getState: () => mockGetCliAvailabilityState() },
}));

import { registerPreferencesActions } from "../preferencesActions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import type { ActionContext, ActionDefinition } from "@shared/types/actions";

const stubCtx: ActionContext = {};

function allAvailability(override?: Partial<CliAvailability>): CliAvailability {
  return {
    claude: true,
    gemini: true,
    codex: true,
    opencode: true,
    ...override,
  } as CliAvailability;
}

function extractHelpLaunchAgent(): ActionDefinition {
  const registry = new Map<string, () => ActionDefinition>();
  const callbacks = { onOpenShortcuts: vi.fn() } as unknown as ActionCallbacks;
  registerPreferencesActions(registry as unknown as ActionRegistry, callbacks);
  const factory = registry.get("help.launchAgent");
  if (!factory) throw new Error("help.launchAgent not registered");
  return factory();
}

describe("help.launchAgent", () => {
  let action: ActionDefinition;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          help: { getFolderPath: vi.fn() },
        },
      },
      writable: true,
      configurable: true,
    });
    action = extractHelpLaunchAgent();
  });

  it("dispatches agent.launch with first available agent when no default set", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.getFolderPath).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude", cwd: "/mock/help" },
      { source: "user" }
    );
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("uses the user's preferred default agent when available", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "gemini" });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "gemini", cwd: "/mock/help" },
      { source: "user" }
    );
  });

  it("falls back to first available agent when default is unavailable", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "gemini" });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability({ gemini: false }),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude", cwd: "/mock/help" },
      { source: "user" }
    );
  });

  it("resolves to codex when claude and gemini are unavailable", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability({ claude: false, gemini: false }),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "codex", cwd: "/mock/help" },
      { source: "user" }
    );
  });

  it("falls back to claude when CLI availability store is not initialized", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability({
        claude: false,
        gemini: false,
        codex: false,
        opencode: false,
      }),
      isInitialized: false,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude", cwd: "/mock/help" },
      { source: "user" }
    );
  });

  it("uses agentId from args when provided", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "claude" });

    await action.run({ agentId: "codex" }, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "codex", cwd: "/mock/help" },
      { source: "user" }
    );
  });

  it("shows notification and does not dispatch when help folder is null", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await action.run(undefined, stubCtx);

    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Help Agent",
      })
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("has correct metadata", () => {
    expect(action.id).toBe("help.launchAgent");
    expect(action.category).toBe("help");
    expect(action.kind).toBe("command");
    expect(action.danger).toBe("safe");
    expect(action.scope).toBe("renderer");
  });
});
