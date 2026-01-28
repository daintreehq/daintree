import { randomUUID } from "crypto";
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

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

const SYSTEM_PROMPT = `You are Canopy's app-wide assistant. You help users control the Canopy IDE by selecting and executing actions.

You have access to tools that represent available actions in the application. When a user asks you to do something, analyze their request and either:
1. Call the appropriate tool with the correct arguments
2. Ask a clarifying question if you need more information
3. Reply with a helpful message if you cannot fulfill the request

Guidelines:
- Only use the tools that are provided to you
- If the user's request is ambiguous, ask a clarifying question with specific choices
- Be concise in your responses
- If an action cannot be performed, explain why briefly`;

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

  async runOneShot(
    request: OneShotRunRequest,
    actions: ActionManifestEntry[],
    context: ActionContext
  ): Promise<OneShotRunResult> {
    const config = store.get("appAgentConfig");

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

    try {
      const agentActions = actions.filter(
        (action) =>
          AGENT_ACCESSIBLE_ACTIONS.includes(
            action.id as (typeof AGENT_ACCESSIBLE_ACTIONS)[number]
          ) && action.enabled
      );

      const tools = this.buildTools(agentActions);
      const messages = this.buildMessages(request, context);

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

      const timeoutId = setTimeout(() => abortController.abort(), 60000);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.1,
        }),
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
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
        };
      }

      const data = (await response.json()) as OpenAIResponse;
      const choice = data.choices[0];

      if (!choice) {
        return {
          success: false,
          error: "No response from model",
          traceId,
        };
      }

      const decision = this.parseDecision(choice.message, agentActions);

      return {
        success: true,
        decision,
        traceId,
        rawModelOutput: JSON.stringify(choice.message, null, 2),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          error: "Request cancelled",
          traceId,
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
      };
    } finally {
      this.inFlightRequest = null;
    }
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
        name: action.name,
        description: action.description,
        parameters: action.inputSchema || { type: "object", properties: {} },
      },
    }));
  }

  private buildMessages(request: OneShotRunRequest, context: ActionContext): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
    ];

    const contextInfo: string[] = [];
    if (context.projectId) {
      contextInfo.push(`Current project: ${context.projectId}`);
    }
    if (context.activeWorktreeId) {
      contextInfo.push(`Active worktree: ${context.activeWorktreeId}`);
    }
    if (context.focusedTerminalId) {
      contextInfo.push(`Focused terminal: ${context.focusedTerminalId}`);
    }

    let userContent = request.prompt;
    if (contextInfo.length > 0) {
      userContent = `Context:\n${contextInfo.join("\n")}\n\nRequest: ${request.prompt}`;
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

      const action = actions.find((a) => a.name === toolName);
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
    const questionPatterns = [
      /which\s+(\w+)\s+would\s+you\s+like/i,
      /do\s+you\s+want\s+to/i,
      /should\s+i/i,
      /would\s+you\s+prefer/i,
    ];

    const hasQuestion = questionPatterns.some((pattern) => pattern.test(content));
    if (!hasQuestion) {
      return null;
    }

    const choicePatterns = [
      /(?:^|\n)\s*[-*•]\s*(.+?)(?=\n|$)/gm,
      /(?:^|\n)\s*\d+[.)]\s*(.+?)(?=\n|$)/gm,
      /["']([^"']+)["']/g,
    ];

    const choices: Array<{ label: string; value: string }> = [];
    for (const pattern of choicePatterns) {
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
