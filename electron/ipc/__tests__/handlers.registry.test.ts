import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const registerMocks = vi.hoisted(() => ({
  registerWorktreeHandlers: vi.fn(),
  registerTerminalHandlers: vi.fn(),
  registerFilesHandlers: vi.fn(),
  registerCopyTreeHandlers: vi.fn(),
  registerAiHandlers: vi.fn(),
  registerSlashCommandHandlers: vi.fn(),
  registerProjectHandlers: vi.fn(),
  registerGithubHandlers: vi.fn(),
  registerAppHandlers: vi.fn(),
  registerSidecarHandlers: vi.fn(),
  registerMenuHandlers: vi.fn(),
  registerHibernationHandlers: vi.fn(),
  registerSystemSleepHandlers: vi.fn(),
  registerKeybindingHandlers: vi.fn(),
  registerWorktreeConfigHandlers: vi.fn(),
  registerNotificationHandlers: vi.fn(),
  registerGeminiHandlers: vi.fn(),
  registerEventsHandlers: vi.fn(),
  registerNotesHandlers: vi.fn(),
  registerDevPreviewHandlers: vi.fn(),
  registerCommandHandlers: vi.fn(),
  registerAppAgentHandlers: vi.fn(),
  registerAssistantHandlers: vi.fn(),
  registerAgentCapabilitiesHandlers: vi.fn(),
}));

vi.mock("../handlers/worktree.js", () => ({
  registerWorktreeHandlers: registerMocks.registerWorktreeHandlers,
}));
vi.mock("../handlers/terminal.js", () => ({
  registerTerminalHandlers: registerMocks.registerTerminalHandlers,
}));
vi.mock("../handlers/files.js", () => ({
  registerFilesHandlers: registerMocks.registerFilesHandlers,
}));
vi.mock("../handlers/copyTree.js", () => ({
  registerCopyTreeHandlers: registerMocks.registerCopyTreeHandlers,
}));
vi.mock("../handlers/ai.js", () => ({
  registerAiHandlers: registerMocks.registerAiHandlers,
}));
vi.mock("../handlers/slashCommands.js", () => ({
  registerSlashCommandHandlers: registerMocks.registerSlashCommandHandlers,
}));
vi.mock("../handlers/project.js", () => ({
  registerProjectHandlers: registerMocks.registerProjectHandlers,
}));
vi.mock("../handlers/github.js", () => ({
  registerGithubHandlers: registerMocks.registerGithubHandlers,
}));
vi.mock("../handlers/app.js", () => ({
  registerAppHandlers: registerMocks.registerAppHandlers,
}));
vi.mock("../handlers/sidecar.js", () => ({
  registerSidecarHandlers: registerMocks.registerSidecarHandlers,
}));
vi.mock("../handlers/menu.js", () => ({
  registerMenuHandlers: registerMocks.registerMenuHandlers,
}));
vi.mock("../handlers/hibernation.js", () => ({
  registerHibernationHandlers: registerMocks.registerHibernationHandlers,
}));
vi.mock("../handlers/systemSleep.js", () => ({
  registerSystemSleepHandlers: registerMocks.registerSystemSleepHandlers,
}));
vi.mock("../handlers/keybinding.js", () => ({
  registerKeybindingHandlers: registerMocks.registerKeybindingHandlers,
}));
vi.mock("../handlers/worktreeConfig.js", () => ({
  registerWorktreeConfigHandlers: registerMocks.registerWorktreeConfigHandlers,
}));
vi.mock("../handlers/notifications.js", () => ({
  registerNotificationHandlers: registerMocks.registerNotificationHandlers,
}));
vi.mock("../handlers/gemini.js", () => ({
  registerGeminiHandlers: registerMocks.registerGeminiHandlers,
}));
vi.mock("../handlers/events.js", () => ({
  registerEventsHandlers: registerMocks.registerEventsHandlers,
}));
vi.mock("../handlers/notes.js", () => ({
  registerNotesHandlers: registerMocks.registerNotesHandlers,
}));
vi.mock("../handlers/devPreview.js", () => ({
  registerDevPreviewHandlers: registerMocks.registerDevPreviewHandlers,
}));
vi.mock("../handlers/commands.js", () => ({
  registerCommandHandlers: registerMocks.registerCommandHandlers,
}));
vi.mock("../handlers/appAgent.js", () => ({
  registerAppAgentHandlers: registerMocks.registerAppAgentHandlers,
}));
vi.mock("../handlers/assistant.js", () => ({
  registerAssistantHandlers: registerMocks.registerAssistantHandlers,
}));
vi.mock("../handlers/agentCapabilities.js", () => ({
  registerAgentCapabilitiesHandlers: registerMocks.registerAgentCapabilitiesHandlers,
}));
vi.mock("../../services/events.js", () => ({
  events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { registerIpcHandlers } from "../handlers.js";

const allRegisterMocks: Mock[] = Object.values(registerMocks) as Mock[];

describe("registerIpcHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const register of allRegisterMocks) {
      register.mockImplementation(() => vi.fn());
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function registerWithTrackedCleanups(): Mock[] {
    const cleanups: Mock[] = [];
    for (const register of allRegisterMocks) {
      register.mockImplementation(() => {
        const cleanup = vi.fn();
        cleanups.push(cleanup);
        return cleanup;
      });
    }
    return cleanups;
  }

  it("registers every handler module exactly once", () => {
    registerIpcHandlers({} as never, {} as never);

    for (const register of allRegisterMocks) {
      expect(register).toHaveBeenCalledTimes(1);
    }
  });

  it("cleans up already-registered handlers when registration fails mid-stream", () => {
    const cleanups = registerWithTrackedCleanups();
    registerMocks.registerGithubHandlers.mockImplementation(() => {
      throw new Error("github registration failed");
    });

    expect(() => registerIpcHandlers({} as never, {} as never)).toThrow(
      "github registration failed"
    );

    expect(cleanups.length).toBeGreaterThan(0);
    for (const cleanup of cleanups) {
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
  });

  it("attempts every cleanup even if one throws", () => {
    const cleanups = registerWithTrackedCleanups();
    const cleanupAll = registerIpcHandlers({} as never, {} as never);

    cleanups[0].mockImplementation(() => {
      throw new Error("cleanup failed");
    });

    expect(() => cleanupAll()).not.toThrow();
    for (const cleanup of cleanups) {
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
  });
});
