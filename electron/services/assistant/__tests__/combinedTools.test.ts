import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock electron modules
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

// Mock the listenerManager module
vi.mock("../ListenerManager.js", async () => {
  const { ListenerManager } =
    await vi.importActual<typeof import("../ListenerManager.js")>("../ListenerManager.js");
  const instance = new ListenerManager();
  return {
    ListenerManager,
    listenerManager: instance,
  };
});

import { createCombinedTools, type CombinedToolContext } from "../combinedTools.js";
import { listenerManager } from "../ListenerManager.js";
import { BrowserWindow, ipcMain } from "electron";

describe("combinedTools", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tools: any;
  let context: CombinedToolContext;

  beforeEach(() => {
    listenerManager.clear();
    context = {
      sessionId: "test-session-1",
      actionContext: {},
    };
    tools = createCombinedTools(context);
    vi.clearAllMocks();
  });

  afterEach(() => {
    listenerManager.clear();
  });

  describe("agent_launchWithAutoResume", () => {
    describe("tool metadata", () => {
      it("has description mentioning event type decision guidance", () => {
        const description = tools.agent_launchWithAutoResume.description as string;
        expect(description).toContain("terminal:state-changed");
        expect(description).toContain("agent:completed");
        expect(description).toContain("INTERACTIVE agents");
        expect(description).toContain("ONE-SHOT agents");
        expect(description).toContain("Claude");
        expect(description).toContain("Codex");
      });

      it("has description recommending terminal:state-changed as safer default", () => {
        const description = tools.agent_launchWithAutoResume.description as string;
        expect(description).toContain("safer default");
        expect(description).toContain("waiting");
      });

      it("schema includes correct eventType enum values", () => {
        const schema = (
          tools.agent_launchWithAutoResume as unknown as {
            inputSchema: {
              jsonSchema: {
                properties: { eventType: { enum: string[]; description: string } };
              };
            };
          }
        ).inputSchema.jsonSchema;
        expect(schema.properties.eventType.enum).toEqual([
          "agent:completed",
          "agent:failed",
          "agent:killed",
          "terminal:state-changed",
        ]);
      });

      it("eventType parameter description includes decision guidance", () => {
        const schema = (
          tools.agent_launchWithAutoResume as unknown as {
            inputSchema: {
              jsonSchema: {
                properties: { eventType: { enum: string[]; description: string } };
              };
            };
          }
        ).inputSchema.jsonSchema;
        const eventTypeDesc = schema.properties.eventType.description;
        expect(eventTypeDesc).toContain("INTERACTIVE agents");
        expect(eventTypeDesc).toContain("ONE-SHOT agents");
        expect(eventTypeDesc).toContain("Claude");
        expect(eventTypeDesc).toContain("Codex");
      });
    });

    describe("validation", () => {
      it("returns error when no window available", async () => {
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);

        const result = await tools.agent_launchWithAutoResume.execute!(
          {
            agentId: "claude",
            prompt: "Test prompt",
            autoResumePrompt: "Continue after completion",
          },
          { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
        );

        expect(result).toEqual({
          success: false,
          error: "Main window not available",
          code: "NO_WINDOW",
        });
      });

      it("requires stateFilter for terminal:state-changed event type", async () => {
        // Mock window available
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
          {
            isDestroyed: () => false,
            webContents: { send: vi.fn() },
          } as unknown as Electron.BrowserWindow,
        ]);

        const result = await tools.agent_launchWithAutoResume.execute!(
          {
            agentId: "claude",
            prompt: "Test prompt",
            autoResumePrompt: "Continue after completion",
            eventType: "terminal:state-changed",
            // stateFilter intentionally missing
          },
          { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
        );

        expect(result).toEqual({
          success: false,
          error:
            "stateFilter is required for terminal:state-changed events. Specify the target state (e.g., 'completed', 'waiting', 'failed').",
          code: "VALIDATION_ERROR",
        });
      });

      it("rejects invalid event type at runtime", async () => {
        // Mock window available
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
          {
            isDestroyed: () => false,
            webContents: { send: vi.fn() },
          } as unknown as Electron.BrowserWindow,
        ]);

        const result = await tools.agent_launchWithAutoResume.execute!(
          {
            agentId: "claude",
            prompt: "Test prompt",
            autoResumePrompt: "Continue after completion",
            eventType: "invalid:event",
          },
          { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
        );

        expect(result).toEqual({
          success: false,
          error: expect.stringContaining("Invalid event type"),
          code: "VALIDATION_ERROR",
        });
      });

      it("rejects empty stateFilter for terminal:state-changed", async () => {
        // Mock window available
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
          {
            isDestroyed: () => false,
            webContents: { send: vi.fn() },
          } as unknown as Electron.BrowserWindow,
        ]);

        const result = await tools.agent_launchWithAutoResume.execute!(
          {
            agentId: "claude",
            prompt: "Test prompt",
            autoResumePrompt: "Continue after completion",
            eventType: "terminal:state-changed",
            stateFilter: "  ",
          },
          { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
        );

        expect(result).toEqual({
          success: false,
          error: expect.stringContaining("stateFilter is required"),
          code: "VALIDATION_ERROR",
        });
      });

      it("rejects invalid stateFilter value", async () => {
        // Mock window available
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
          {
            isDestroyed: () => false,
            webContents: { send: vi.fn() },
          } as unknown as Electron.BrowserWindow,
        ]);

        const result = await tools.agent_launchWithAutoResume.execute!(
          {
            agentId: "claude",
            prompt: "Test prompt",
            autoResumePrompt: "Continue after completion",
            eventType: "terminal:state-changed",
            stateFilter: "invalid-state",
          },
          { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
        );

        expect(result).toEqual({
          success: false,
          error: expect.stringContaining("Invalid stateFilter"),
          code: "VALIDATION_ERROR",
        });
      });
    });

    describe("successful launch with terminal:state-changed", () => {
      it("accepts terminal:state-changed with stateFilter", async () => {
        // Mock window and IPC
        const mockSend = vi.fn();
        const mockWindow = {
          isDestroyed: () => false,
          webContents: { send: mockSend },
        } as unknown as Electron.BrowserWindow;
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow]);

        // Need to actually trigger the handler when on() is called
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handlers: { response?: any } = {};
        vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
          if (channel === "app-agent:dispatch-action-response") {
            handlers.response = handler;
          }
          return ipcMain;
        });

        const resultPromise = tools.agent_launchWithAutoResume.execute!(
          {
            agentId: "claude",
            prompt: "Analyze the project",
            autoResumePrompt: "Summarize the results",
            eventType: "terminal:state-changed",
            stateFilter: "waiting",
          },
          { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
        );

        // Wait for handler to be captured
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Simulate response
        const sendCall = mockSend.mock.calls[0];
        const requestId = sendCall?.[1]?.requestId;
        if (handlers.response && requestId) {
          handlers.response(
            {},
            {
              requestId,
              result: { ok: true, result: { terminalId: "term-123" } },
            }
          );
        }

        const result = await resultPromise;

        expect(result).toEqual({
          success: true,
          terminalId: "term-123",
          listenerId: expect.any(String),
          eventType: "terminal:state-changed",
          agentId: "claude",
          message: expect.stringContaining("END YOUR TURN NOW"),
        });

        // Verify listener was registered with correct filter
        const listeners = listenerManager.listForSession("test-session-1");
        expect(listeners.length).toBe(1);
        expect(listeners[0].eventType).toBe("terminal:state-changed");
        expect(listeners[0].filter).toEqual({
          terminalId: "term-123",
          toState: "waiting",
        });
      });
    });

    describe("successful launch with agent:completed", () => {
      it("accepts agent:completed without stateFilter", async () => {
        // Mock window and IPC
        const mockSend = vi.fn();
        const mockWindow = {
          isDestroyed: () => false,
          webContents: { send: mockSend },
        } as unknown as Electron.BrowserWindow;
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handlers: { response?: any } = {};
        vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
          if (channel === "app-agent:dispatch-action-response") {
            handlers.response = handler;
          }
          return ipcMain;
        });

        const resultPromise = tools.agent_launchWithAutoResume.execute!(
          {
            agentId: "codex",
            prompt: "Run the build script",
            autoResumePrompt: "Report the build results",
            eventType: "agent:completed",
          },
          { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
        );

        // Wait for handler to be captured
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Simulate response
        const sendCall = mockSend.mock.calls[0];
        const requestId = sendCall?.[1]?.requestId;
        if (handlers.response && requestId) {
          handlers.response(
            {},
            {
              requestId,
              result: { ok: true, result: { terminalId: "term-456" } },
            }
          );
        }

        const result = await resultPromise;

        expect(result).toEqual({
          success: true,
          terminalId: "term-456",
          listenerId: expect.any(String),
          eventType: "agent:completed",
          agentId: "codex",
          message: expect.stringContaining("END YOUR TURN NOW"),
        });

        // Verify listener was registered without toState filter
        const listeners = listenerManager.listForSession("test-session-1");
        expect(listeners.length).toBe(1);
        expect(listeners[0].eventType).toBe("agent:completed");
        expect(listeners[0].filter).toEqual({
          terminalId: "term-456",
        });
        expect(listeners[0].filter).not.toHaveProperty("toState");
      });

      it("defaults to agent:completed when eventType not specified", async () => {
        // Mock window and IPC
        const mockSend = vi.fn();
        const mockWindow = {
          isDestroyed: () => false,
          webContents: { send: mockSend },
        } as unknown as Electron.BrowserWindow;
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handlers: { response?: any } = {};
        vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
          if (channel === "app-agent:dispatch-action-response") {
            handlers.response = handler;
          }
          return ipcMain;
        });

        const resultPromise = tools.agent_launchWithAutoResume.execute!(
          {
            agentId: "codex",
            prompt: "Run tests",
            autoResumePrompt: "Report results",
            // eventType not specified - should default to agent:completed
          },
          { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
        );

        await new Promise((resolve) => setTimeout(resolve, 10));

        const sendCall = mockSend.mock.calls[0];
        const requestId = sendCall?.[1]?.requestId;
        if (handlers.response && requestId) {
          handlers.response(
            {},
            {
              requestId,
              result: { ok: true, result: { terminalId: "term-789" } },
            }
          );
        }

        const result = await resultPromise;

        expect((result as { success: boolean }).success).toBe(true);
        expect((result as { eventType: string }).eventType).toBe("agent:completed");
      });
    });
  });
});
