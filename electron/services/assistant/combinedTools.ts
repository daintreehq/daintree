/**
 * Combined Tools for Assistant Service
 *
 * Provides convenience tools that combine multiple operations atomically.
 * These tools prevent race conditions and ensure correct data dependencies.
 */

import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import { BrowserWindow, ipcMain } from "electron";
import type { ActionContext } from "../../../shared/types/actions.js";
import type { AutoResumeOptions, AutoResumeContext } from "../../../shared/types/listener.js";
import { listenerManager } from "./ListenerManager.js";

/**
 * Context provided to combined tools.
 */
export interface CombinedToolContext {
  sessionId: string;
  actionContext: ActionContext;
}

/**
 * Dispatch an action to the renderer via IPC and wait for the result.
 */
async function dispatchAction(
  actionId: string,
  args: Record<string, unknown> | undefined,
  context: ActionContext
): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: { code: "NO_WINDOW", message: "Main window not available" } };
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener("app-agent:dispatch-action-response", handler);
      resolve({ ok: false, error: { code: "TIMEOUT", message: "Action dispatch timed out" } });
    }, 30000);

    const handler = (
      _event: Electron.IpcMainEvent,
      payload: {
        requestId: string;
        result: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
      }
    ) => {
      if (payload.requestId === requestId) {
        clearTimeout(timeout);
        ipcMain.removeListener("app-agent:dispatch-action-response", handler);
        resolve(payload.result);
      }
    };

    ipcMain.on("app-agent:dispatch-action-response", handler);

    mainWindow.webContents.send("app-agent:dispatch-action-request", {
      requestId,
      actionId,
      args,
      context,
    });
  });
}

/**
 * Create combined tools for the assistant.
 * These tools combine multiple operations to ensure correct execution order.
 */
export function createCombinedTools(context: CombinedToolContext): ToolSet {
  return {
    agent_launchWithAutoResume: tool({
      description:
        "Launch an agent AND register an autoResume listener in a single atomic operation. " +
        "This is the RECOMMENDED way to launch an agent and wait for completion, as it guarantees " +
        "the listener is registered with the correct terminal ID. " +
        "IMPORTANT: Choose eventType based on agent mode: " +
        "- Use 'terminal:state-changed' with stateFilter for INTERACTIVE agents (Claude, Gemini, terminals) that persist and handle multiple prompts. " +
        "- Use 'agent:completed' for ONE-SHOT agents (Codex, OpenCode) that run a task and exit. " +
        "When uncertain, prefer 'terminal:state-changed' with stateFilter='waiting' — it's the safer default. " +
        "Returns both the terminalId and listenerId. " +
        "After calling this tool, END YOUR TURN IMMEDIATELY - the conversation will automatically " +
        "continue when the agent completes.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          agentId: {
            type: "string",
            description: "The agent to launch: claude, codex, gemini, opencode, or terminal",
            enum: ["claude", "codex", "gemini", "opencode", "terminal"],
          },
          prompt: {
            type: "string",
            description: "The prompt/task to give the agent",
          },
          autoResumePrompt: {
            type: "string",
            description:
              "The message to inject when the agent completes (e.g., 'Summarize the results.')",
            minLength: 1,
          },
          autoResumeContext: {
            type: "object",
            description: "Optional context to preserve for the resumed conversation",
            properties: {
              plan: {
                type: "string",
                description: "A plan or checklist of steps to continue from",
              },
              metadata: {
                type: "object",
                description: "Any additional metadata to preserve",
                additionalProperties: true,
              },
            },
          },
          location: {
            type: "string",
            description: "Where to launch the agent: grid (default) or dock",
            enum: ["grid", "dock"],
          },
          cwd: {
            type: "string",
            description: "Working directory for the agent (optional)",
          },
          worktreeId: {
            type: "string",
            description: "Worktree to associate the agent with (optional)",
          },
          interactive: {
            type: "boolean",
            description: "Whether the agent should run in interactive mode (optional)",
          },
          eventType: {
            type: "string",
            description:
              "Event type to listen for. Choose based on agent mode: " +
              "Use 'terminal:state-changed' for INTERACTIVE agents (Claude, Gemini, terminals) — " +
              "agents that persist and may handle multiple prompts. " +
              "Use 'agent:completed' for ONE-SHOT agents (Codex, OpenCode) — " +
              "agents that run a single task and exit. " +
              "Default: 'agent:completed'",
            enum: ["agent:completed", "agent:failed", "agent:killed", "terminal:state-changed"],
          },
          stateFilter: {
            type: "string",
            description:
              "For terminal:state-changed events, the state to filter for (e.g., 'completed', 'waiting')",
          },
        },
        required: ["agentId", "prompt", "autoResumePrompt"],
      }),
      execute: async ({
        agentId,
        prompt,
        autoResumePrompt,
        autoResumeContext,
        location,
        cwd,
        worktreeId,
        interactive,
        eventType = "agent:completed",
        stateFilter,
      }: {
        agentId: string;
        prompt: string;
        autoResumePrompt: string;
        autoResumeContext?: AutoResumeContext;
        location?: "grid" | "dock";
        cwd?: string;
        worktreeId?: string;
        interactive?: boolean;
        eventType?: "agent:completed" | "agent:failed" | "agent:killed" | "terminal:state-changed";
        stateFilter?: string;
      }) => {
        try {
          // Validate eventType at runtime
          const validEventTypes = [
            "agent:completed",
            "agent:failed",
            "agent:killed",
            "terminal:state-changed",
          ];
          if (!validEventTypes.includes(eventType)) {
            return {
              success: false,
              error: `Invalid event type '${eventType}'. Must be one of: ${validEventTypes.join(", ")}`,
              code: "VALIDATION_ERROR",
            };
          }

          // For terminal:state-changed, require stateFilter to avoid premature resume
          if (eventType === "terminal:state-changed") {
            if (!stateFilter || stateFilter.trim() === "") {
              return {
                success: false,
                error:
                  "stateFilter is required for terminal:state-changed events. Specify the target state (e.g., 'completed', 'waiting', 'failed').",
                code: "VALIDATION_ERROR",
              };
            }
            // Validate against known states
            const validStates = ["idle", "working", "running", "waiting", "completed", "failed"];
            if (!validStates.includes(stateFilter)) {
              return {
                success: false,
                error: `Invalid stateFilter '${stateFilter}'. Must be one of: ${validStates.join(", ")}`,
                code: "VALIDATION_ERROR",
              };
            }
          }
          // Step 1: Launch the agent
          const launchResult = await dispatchAction(
            "agent.launch",
            {
              agentId,
              prompt,
              location,
              cwd,
              worktreeId,
              interactive,
            },
            context.actionContext
          );

          if (!launchResult.ok) {
            return {
              success: false,
              error: launchResult.error?.message || "Failed to launch agent",
              code: launchResult.error?.code,
            };
          }

          // Extract terminal ID from result
          const result = launchResult.result as { terminalId?: string } | undefined;
          const terminalId = result?.terminalId;

          if (!terminalId) {
            return {
              success: false,
              error: "Agent launched but no terminal ID returned",
              code: "NO_TERMINAL_ID",
            };
          }

          // Step 2: Register the listener with the correct terminal ID
          const autoResumeOptions: AutoResumeOptions = {
            prompt: autoResumePrompt,
            context: autoResumeContext,
          };

          // Build filter based on event type
          const filter: Record<string, string | number | boolean | null> = {
            terminalId,
          };

          // Add state filter for terminal:state-changed events
          if (eventType === "terminal:state-changed" && stateFilter) {
            filter.toState = stateFilter;
          }

          let listenerId: string;
          try {
            listenerId = listenerManager.register(
              context.sessionId,
              eventType,
              filter,
              true, // once: true for completion events
              autoResumeOptions
            );
          } catch (error) {
            // If listener registration fails after successful launch, return terminalId for recovery
            return {
              success: false,
              error: error instanceof Error ? error.message : "Failed to register listener",
              code: "LISTENER_REGISTRATION_ERROR",
              terminalId, // Include terminalId so assistant can retry listener registration
              eventType,
            };
          }

          // Build message based on event type
          const eventDescription =
            eventType === "terminal:state-changed" && stateFilter
              ? `reaches '${stateFilter}' state`
              : eventType === "agent:completed"
                ? "completes successfully"
                : eventType === "agent:failed"
                  ? "fails"
                  : "is killed";

          return {
            success: true,
            terminalId,
            listenerId,
            eventType,
            agentId,
            message:
              `Agent launched with auto-resume listener. END YOUR TURN NOW - ` +
              `the conversation will automatically continue when the agent ${eventDescription}. ` +
              "Do not poll, check status, or make additional tool calls. " +
              "Simply inform the user you're waiting.",
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to launch agent with listener",
            code: "EXECUTION_ERROR",
          };
        }
      },
    }),
  };
}
