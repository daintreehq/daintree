import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { registerPreferencesActions } from "../preferencesActions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import type { ActionContext, ActionDefinition } from "@shared/types/actions";

const stubCtx: ActionContext = {};

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

  it("dispatches agent.launch with help folder path and default agent", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.getFolderPath).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude", cwd: "/mock/help" },
      { source: "user" }
    );
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("uses the user's preferred default agent", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "gemini" });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "gemini", cwd: "/mock/help" },
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
