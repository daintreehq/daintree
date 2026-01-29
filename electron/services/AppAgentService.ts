import { randomUUID } from "crypto";
import { BrowserWindow, ipcMain } from "electron";
import { store } from "../store.js";
import { events } from "./events.js";
import {
  AGENT_ACCESSIBLE_ACTIONS,
  type AppAgentConfig,
  type OneShotRunRequest,
  type OneShotRunResult,
  type AgentDecision,
} from "../../shared/types/appAgent.js";
import type { ActionManifestEntry, ActionContext } from "../../shared/types/actions.js";
import {
  SYSTEM_PROMPT,
  buildContextBlock,
  CLARIFICATION_PATTERNS,
  getChoicePatterns,
} from "./assistant/systemPrompt.js";

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

const DEFAULT_MAX_TURNS = 10;

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIResponse {
  id: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class AppAgentService {
  private inFlightRequest: AbortController | null = null;

  getConfig(): Omit<AppAgentConfig, "apiKey"> {
    const config = store.get("appAgentConfig");
    const { apiKey: _, ...safeConfig } = config;
    return safeConfig;
  }

  setConfig(config: Partial<AppAgentConfig>): void {
    const currentConfig = store.get("appAgentConfig");
    store.set("appAgentConfig", { ...currentConfig, ...config });
  }

  hasApiKey(): boolean {
    const config = store.get("appAgentConfig");
    return !!config.apiKey;
  }

  async testApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const config = store.get("appAgentConfig");
    const baseUrl = config.baseUrl || FIREWORKS_BASE_URL;

    let url: URL;
    try {
      url = new URL(`${baseUrl}/chat/completions`);
    } catch {
      return { valid: false, error: "Invalid base URL configured" };
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 15000);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }),
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return { valid: true };
      }

      if (response.status === 401) {
        return { valid: false, error: "Invalid API key" };
      }

      if (response.status === 403) {
        return { valid: false, error: "API key does not have access to this model" };
      }

      if (response.status === 429) {
        // Rate limited but key is valid
        return { valid: true };
      }

      const errorText = await response.text().catch(() => "");
      return { valid: false, error: `API error: ${response.status} ${errorText}`.trim() };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return { valid: false, error: "Request timed out" };
      }

      return {
        valid: false,
        error: error instanceof Error ? error.message : "Failed to connect to API",
      };
    }
  }

  async testModel(model: string): Promise<{ valid: boolean; error?: string }> {
    console.log("\n========================================");
    console.log("[AppAgent] testModel called with:", model);
    console.log("========================================\n");

    const config = store.get("appAgentConfig");

    if (!config.apiKey) {
      console.log("[AppAgent] testModel: No API key configured");
      return { valid: false, error: "API key not configured" };
    }

    const baseUrl = config.baseUrl || FIREWORKS_BASE_URL;

    let url: URL;
    try {
      url = new URL(`${baseUrl}/chat/completions`);
    } catch {
      return { valid: false, error: "Invalid base URL configured" };
    }

    const requestBody = {
      model,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
    };

    console.log("[AppAgent] testModel request:", {
      url: url.toString(),
      model,
      body: requestBody,
    });

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 15000);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      console.log("[AppAgent] testModel response status:", response.status);

      if (response.ok) {
        console.log("[AppAgent] testModel: Success");
        return { valid: true };
      }

      if (response.status === 401) {
        return { valid: false, error: "API key is invalid" };
      }

      if (response.status === 404) {
        return { valid: false, error: "Model not found" };
      }

      if (response.status === 429) {
        // Rate limited but model is valid
        return { valid: true };
      }

      const errorText = await response.text().catch(() => "");
      console.log("[AppAgent] testModel error response:", errorText);
      return { valid: false, error: `API error: ${response.status} ${errorText}`.trim() };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return { valid: false, error: "Request timed out" };
      }

      return {
        valid: false,
        error: error instanceof Error ? error.message : "Failed to connect to API",
      };
    }
  }

  async runOneShot(
    request: OneShotRunRequest,
    actions: ActionManifestEntry[],
    context: ActionContext
  ): Promise<OneShotRunResult> {
    const config = store.get("appAgentConfig");
    const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;

    if (!config.apiKey) {
      return {
        success: false,
        error: "API key not configured. Please add your Fireworks API key in Settings.",
      };
    }

    if (this.inFlightRequest) {
      this.inFlightRequest.abort();
    }

    const traceId = randomUUID();
    const abortController = new AbortController();
    this.inFlightRequest = abortController;

    events.emit("agent:spawned", {
      agentId: `app-agent-${traceId}`,
      terminalId: "app-agent",
      type: "terminal",
      traceId,
      timestamp: Date.now(),
    });

    let turnsUsed = 0;
    let totalToolCalls = 0;

    try {
      console.log("\n========================================");
      console.log("[AppAgent] runOneShot called");
      console.log("[AppAgent] Request prompt:", request.prompt);
      console.log("[AppAgent] Total actions passed:", actions.length);
      console.log("[AppAgent] Max turns:", maxTurns);
      console.log("========================================\n");

      const agentActions = actions.filter(
        (action) =>
          AGENT_ACCESSIBLE_ACTIONS.includes(
            action.id as (typeof AGENT_ACCESSIBLE_ACTIONS)[number]
          ) && action.enabled
      );

      console.log("[AppAgent] Filtered agentActions:", agentActions.length);
      console.log(
        "[AppAgent] Agent action IDs:",
        agentActions.map((a) => a.id)
      );

      const tools = this.buildTools(agentActions);
      const messages = this.buildMessages(request, context);

      console.log("[AppAgent] Built tools count:", tools.length);

      const baseUrl = config.baseUrl || FIREWORKS_BASE_URL;
      let url: URL;
      try {
        url = new URL(`${baseUrl}/chat/completions`);
      } catch {
        return {
          success: false,
          error: "Invalid base URL configured. Please check your settings.",
          traceId,
        };
      }

      // Multi-step execution loop
      while (turnsUsed < maxTurns) {
        if (abortController.signal.aborted) {
          return {
            success: false,
            error: "Request cancelled",
            traceId,
            turnsUsed,
            totalToolCalls,
          };
        }

        turnsUsed++;
        console.log(`[AppAgent] Turn ${turnsUsed}/${maxTurns}`);

        const requestBody = {
          model: config.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? "auto" : undefined,
          temperature: 0.1,
        };

        const timeoutId = setTimeout(() => abortController.abort(), 60000);

        const response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        });

        clearTimeout(timeoutId);

        console.log("[AppAgent] Response status:", response.status);

        if (!response.ok) {
          const errorText = await response.text();
          console.log("[AppAgent] Error response:", errorText);
          let errorMessage = `API request failed: ${response.status}`;

          if (response.status === 401) {
            errorMessage = "Invalid API key. Please check your Fireworks API key in Settings.";
          } else if (response.status === 429) {
            errorMessage = "Rate limit exceeded. Please try again in a moment.";
          } else if (response.status >= 500) {
            errorMessage = "Service temporarily unavailable. Please try again later.";
          }

          return {
            success: false,
            error: errorMessage,
            traceId,
            rawModelOutput: errorText,
            turnsUsed,
            totalToolCalls,
          };
        }

        const data = (await response.json()) as OpenAIResponse;
        const choice = data.choices[0];

        if (!choice) {
          return {
            success: false,
            error: "No response from model",
            traceId,
            turnsUsed,
            totalToolCalls,
          };
        }

        const assistantMessage = choice.message;

        // If no tool calls, this is a final response
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          console.log("[AppAgent] Final response (no tool calls)");

          const decision = this.parseDecision(assistantMessage, agentActions);

          return {
            success: true,
            decision,
            traceId,
            rawModelOutput: JSON.stringify(assistantMessage, null, 2),
            turnsUsed,
            totalToolCalls,
          };
        }

        // Process tool calls
        console.log(`[AppAgent] Processing ${assistantMessage.tool_calls.length} tool call(s)`);

        // Add assistant message with tool calls to history
        messages.push({
          role: "assistant",
          content: assistantMessage.content,
          tool_calls: assistantMessage.tool_calls,
        });

        // Execute each tool call and collect results
        for (const toolCall of assistantMessage.tool_calls) {
          totalToolCalls++;
          const toolName = toolCall.function.name;

          // Find the action (convert sanitized name back)
          const action = agentActions.find(
            (a) =>
              this.sanitizeToolName(a.name) === toolName || a.name === toolName || a.id === toolName
          );

          if (!action) {
            console.log(`[AppAgent] Tool not found: ${toolName}`);
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: `Unknown action: ${toolName}` }),
            });
            continue;
          }

          let args: Record<string, unknown> | undefined;
          const argsString = toolCall.function.arguments.trim();
          if (argsString && argsString !== "{}") {
            try {
              const parsedArgs = JSON.parse(argsString);
              if (
                parsedArgs &&
                typeof parsedArgs === "object" &&
                Object.keys(parsedArgs).length > 0
              ) {
                args = parsedArgs;
              }
            } catch {
              console.log(`[AppAgent] Failed to parse args for ${toolName}:`, argsString);
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: "Invalid arguments format" }),
              });
              continue;
            }
          }

          console.log(
            `[AppAgent] Executing: ${action.id}`,
            args ? JSON.stringify(args) : "(no args)"
          );

          // Execute the action via IPC to renderer
          const result = await this.dispatchAction(action.id, args, context);

          console.log(`[AppAgent] Result for ${action.id}:`, JSON.stringify(result).slice(0, 200));

          // Add tool result to messages
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      }

      // Max turns reached
      console.log(`[AppAgent] Max turns (${maxTurns}) reached`);
      return {
        success: true,
        decision: {
          type: "reply",
          text: "I completed the available operations. Let me know if you need anything else.",
        },
        traceId,
        turnsUsed,
        totalToolCalls,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          error: "Request cancelled",
          traceId,
          turnsUsed,
          totalToolCalls,
        };
      }

      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

      events.emit("agent:failed", {
        agentId: `app-agent-${traceId}`,
        error: errorMessage,
        traceId,
        timestamp: Date.now(),
      });

      return {
        success: false,
        error: errorMessage,
        traceId,
        turnsUsed,
        totalToolCalls,
      };
    } finally {
      this.inFlightRequest = null;
    }
  }

  /**
   * Dispatch an action to the renderer via IPC and wait for the result.
   */
  private async dispatchAction(
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

  cancel(): void {
    if (this.inFlightRequest) {
      this.inFlightRequest.abort();
      this.inFlightRequest = null;
    }
  }

  private buildTools(actions: ActionManifestEntry[]): OpenAITool[] {
    return actions.map((action) => ({
      type: "function" as const,
      function: {
        name: this.sanitizeToolName(action.name),
        description: action.description,
        parameters: this.sanitizeSchema(action.inputSchema),
      },
    }));
  }

  private sanitizeToolName(name: string): string {
    // OpenAI/Fireworks strips dots from tool names, so replace with underscores
    return name.replace(/\./g, "_");
  }

  private sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
    const defaultSchema = { type: "object", properties: {} };

    if (!schema) {
      return defaultSchema;
    }

    // Clone to avoid mutating original
    const sanitized = { ...schema };

    // Remove $schema - Fireworks/OpenAI doesn't support it
    delete sanitized["$schema"];

    // Handle anyOf from .optional() - unwrap if it contains an object type
    if (sanitized["anyOf"] && Array.isArray(sanitized["anyOf"])) {
      const objectSchema = (sanitized["anyOf"] as Array<Record<string, unknown>>).find(
        (s) => s.type === "object"
      );
      if (objectSchema) {
        // Merge the object schema properties into sanitized
        Object.assign(sanitized, objectSchema);
        delete sanitized["anyOf"];
      }
    }

    // Only add defaults if we don't have real structure
    if (!sanitized["type"]) {
      sanitized["type"] = "object";
    }
    if (sanitized["type"] === "object" && !sanitized["properties"]) {
      sanitized["properties"] = {};
    }

    return sanitized;
  }

  private buildMessages(request: OneShotRunRequest, context: ActionContext): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
    ];

    const contextBlock = buildContextBlock(context);

    let userContent = request.prompt;
    if (contextBlock) {
      userContent = `${contextBlock}\n\nRequest: ${request.prompt}`;
    }

    if (request.clarificationChoice) {
      userContent += `\n\nUser selected: ${request.clarificationChoice}`;
    }

    messages.push({
      role: "user",
      content: userContent,
    });

    return messages;
  }

  private parseDecision(message: OpenAIMessage, actions: ActionManifestEntry[]): AgentDecision {
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      const toolName = toolCall.function.name;

      // Match by sanitized tool name, then fall back to exact name/id
      const action = actions.find(
        (a) =>
          this.sanitizeToolName(a.name) === toolName || a.name === toolName || a.id === toolName
      );
      if (!action) {
        return {
          type: "reply",
          text: `I tried to use an action (${toolName}) that isn't available. Please try a different request.`,
        };
      }

      let args: Record<string, unknown> | undefined;
      const argsString = toolCall.function.arguments.trim();
      if (argsString && argsString !== "{}") {
        try {
          const parsedArgs = JSON.parse(argsString);
          if (parsedArgs && typeof parsedArgs === "object" && Object.keys(parsedArgs).length > 0) {
            args = parsedArgs;
          }
        } catch {
          return {
            type: "reply",
            text: `I tried to call ${action.title} but the arguments were malformed. Please try again.`,
          };
        }
      }

      return {
        type: "dispatch",
        id: action.id,
        args,
      };
    }

    if (message.content) {
      const content = message.content.trim();

      const clarifyMatch = this.parseClarificationFromContent(content);
      if (clarifyMatch) {
        return clarifyMatch;
      }

      return {
        type: "reply",
        text: content,
      };
    }

    return {
      type: "reply",
      text: "I couldn't understand how to help with that request.",
    };
  }

  private parseClarificationFromContent(content: string): AgentDecision | null {
    const questionPatterns = Object.values(CLARIFICATION_PATTERNS);

    const hasQuestion = questionPatterns.some((pattern) => pattern.test(content));
    if (!hasQuestion) {
      return null;
    }

    // Get fresh regex instances to avoid lastIndex persistence issues
    const choicePatterns = getChoicePatterns();
    const allPatterns = [choicePatterns.BULLET, choicePatterns.NUMBERED, /["']([^"']+)["']/g];

    const choices: Array<{ label: string; value: string }> = [];
    for (const pattern of allPatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        const label = match[1]?.trim();
        if (label && label.length < 100) {
          choices.push({ label, value: label });
        }
      }
      if (choices.length >= 2) break;
    }

    if (choices.length >= 2 && choices.length <= 6) {
      const questionMatch = content.match(/^[^.!?\n]+[.!?]/);
      const question = questionMatch ? questionMatch[0] : content.split("\n")[0];

      return {
        type: "ask",
        question,
        choices,
      };
    }

    return null;
  }
}

export const appAgentService = new AppAgentService();
