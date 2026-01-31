import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage, stepCountIs, type JSONValue } from "ai";
import { store } from "../store.js";
import type { StreamChunk, AssistantMessage } from "../../shared/types/assistant.js";
import type { ActionManifestEntry, ActionContext } from "../../shared/types/actions.js";
import { createActionTools, sanitizeToolName } from "./assistant/actionTools.js";
import { SYSTEM_PROMPT, buildContextBlock } from "./assistant/index.js";
import { listenerManager } from "./assistant/ListenerManager.js";
import { createListenerTools } from "./assistant/listenerTools.js";

// Actions that require a focused terminal and cannot accept an explicit terminalId
// These actions operate on "the current terminal" without a way to specify which one
const TERMINAL_FOCUS_REQUIRED_ACTIONS = new Set([
  "terminal.close", // No ID parameter - always uses focused terminal
  "terminal.toggleMaximize",
  "terminal.toggleInputLock",
  "terminal.duplicate",
  "terminal.rename",
  "terminal.viewInfo",
]);

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const MAX_STEPS = 10;

export class AssistantService {
  private fireworks: ReturnType<typeof createOpenAI> | null = null;
  private activeStreams = new Map<string, AbortController>();
  private chunkCallbacks = new Map<string, (chunk: StreamChunk) => void>();

  constructor() {
    this.initializeProvider();
  }

  private initializeProvider(): void {
    const config = store.get("appAgentConfig");
    if (config.apiKey) {
      const baseUrl = config.baseUrl || FIREWORKS_BASE_URL;
      this.fireworks = createOpenAI({
        apiKey: config.apiKey,
        baseURL: baseUrl,
      });
    } else {
      this.fireworks = null;
    }
  }

  hasApiKey(): boolean {
    const config = store.get("appAgentConfig");
    return !!config.apiKey;
  }

  updateApiKey(): void {
    this.initializeProvider();
  }

  async streamMessage(
    sessionId: string,
    messages: AssistantMessage[],
    onChunk: (chunk: StreamChunk) => void,
    actions?: ActionManifestEntry[],
    context?: ActionContext
  ): Promise<void> {
    const config = store.get("appAgentConfig");

    if (!config.apiKey) {
      onChunk({
        type: "error",
        error: "API key not configured. Please add your Fireworks API key in Settings.",
      });
      onChunk({ type: "done" });
      return;
    }

    if (!this.fireworks) {
      this.initializeProvider();
    }

    if (!this.fireworks) {
      onChunk({
        type: "error",
        error: "Failed to initialize AI provider.",
      });
      onChunk({ type: "done" });
      return;
    }

    // Cancel any existing stream for this session to prevent leaks
    const existingController = this.activeStreams.get(sessionId);
    if (existingController) {
      existingController.abort();
      this.activeStreams.delete(sessionId);
    }

    const controller = new AbortController();
    this.activeStreams.set(sessionId, controller);
    this.chunkCallbacks.set(sessionId, onChunk);

    try {
      // Build context block for the system prompt
      const activeListenerCount = listenerManager.countForSession(sessionId);
      const contextBlock = context
        ? buildContextBlock({ ...context, activeListenerCount })
        : activeListenerCount > 0
          ? buildContextBlock({ activeListenerCount })
          : "";
      const systemPromptWithContext = contextBlock
        ? `${SYSTEM_PROMPT}\n\n${contextBlock}`
        : SYSTEM_PROMPT;

      // Convert messages to ModelMessage format with proper tool call/result interleaving
      // AI SDK requires that every tool call has a corresponding tool result.
      // If tool results are missing for any tool call, we exclude those tool calls
      // from the history to prevent AI_MissingToolResultsError.
      const modelMessages: ModelMessage[] = [];

      for (const msg of messages) {
        if (msg.role === "user") {
          modelMessages.push({ role: "user", content: msg.content });
        } else {
          // Assistant message - may have tool calls
          const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
          const hasToolResults = msg.toolResults && msg.toolResults.length > 0;

          if (hasToolCalls && hasToolResults) {
            // TypeScript needs explicit narrowing - these are guaranteed non-null by the boolean checks
            const toolCalls = msg.toolCalls!;
            const toolResults = msg.toolResults!;

            // Build a set of tool call IDs that have results
            const resultIds = new Set(toolResults.map((tr) => tr.toolCallId));

            // Only include tool calls that have corresponding results
            const pairedToolCalls = toolCalls.filter((tc) => resultIds.has(tc.id));

            if (pairedToolCalls.length > 0) {
              // Build a set of paired call IDs for efficient filtering
              const pairedCallIds = new Set(pairedToolCalls.map((tc) => tc.id));

              // Add assistant message with only the paired tool calls
              modelMessages.push({
                role: "assistant",
                content: [
                  ...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
                  ...pairedToolCalls.map((tc) => ({
                    type: "tool-call" as const,
                    toolCallId: tc.id,
                    toolName: sanitizeToolName(tc.name),
                    input: tc.args,
                  })),
                ],
              });

              // Add tool results for the paired tool calls (filter efficiently using Set)
              const pairedResults = toolResults.filter((tr) => pairedCallIds.has(tr.toolCallId));
              modelMessages.push({
                role: "tool",
                content: pairedResults.map((tr) => ({
                  type: "tool-result" as const,
                  toolCallId: tr.toolCallId,
                  toolName: sanitizeToolName(tr.toolName),
                  // Normalize result to JSON-safe value (null if undefined)
                  output: {
                    type: "json" as const,
                    value: (tr.result ?? null) as JSONValue,
                  },
                })),
              });
            } else if (msg.content) {
              // No paired tool calls, but have content - add as text-only message
              modelMessages.push({ role: "assistant", content: msg.content });
            }
          } else if (hasToolCalls && !hasToolResults) {
            // Tool calls without results - this indicates incomplete tool execution
            // Include only the text content to avoid AI_MissingToolResultsError
            if (msg.content) {
              modelMessages.push({ role: "assistant", content: msg.content });
            }
            // Note: Tool calls are intentionally omitted to prevent validation errors
          } else {
            // No tool calls - just add the text content
            modelMessages.push({ role: "assistant", content: msg.content });
          }
        }
      }

      // Filter actions based on context
      let filteredActions = actions;
      if (actions && context) {
        // Remove terminal-focus-required actions when no terminal is focused
        if (!context.focusedTerminalId) {
          filteredActions = actions.filter(
            (action) => !TERMINAL_FOCUS_REQUIRED_ACTIONS.has(action.id)
          );
        }
      }

      // Build tools from filtered actions and listener management
      const actionTools = filteredActions && context ? createActionTools(filteredActions, context) : {};
      const listenerTools = createListenerTools({ sessionId });
      const tools = { ...actionTools, ...listenerTools };
      const hasTools = Object.keys(tools).length > 0;

      const result = streamText({
        model: this.fireworks(config.model),
        system: systemPromptWithContext,
        messages: modelMessages,
        tools: hasTools ? tools : undefined,
        stopWhen: hasTools ? stepCountIs(MAX_STEPS) : undefined,
        abortSignal: controller.signal,
      });

      // Use fullStream to get tool call and result events
      for await (const part of result.fullStream) {
        if (controller.signal.aborted) {
          onChunk({ type: "done", finishReason: "cancelled" });
          return;
        }

        switch (part.type) {
          case "text-delta":
            onChunk({ type: "text", content: part.text });
            break;

          case "tool-call":
            onChunk({
              type: "tool_call",
              toolCall: {
                id: part.toolCallId,
                name: part.toolName,
                args: part.input as Record<string, unknown>,
              },
            });
            break;

          case "tool-result":
            onChunk({
              type: "tool_result",
              toolResult: {
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                result: part.output,
              },
            });
            break;

          case "error":
            console.error("[AssistantService] Stream part error:", part.error);
            onChunk({
              type: "error",
              error: part.error ? String(part.error) : "Stream error occurred",
            });
            break;
        }
      }

      // Only get finish reason if not aborted
      if (!controller.signal.aborted) {
        const finalResult = await result;
        const finishReason = await finalResult.finishReason;
        onChunk({
          type: "done",
          finishReason: finishReason ?? undefined,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        onChunk({ type: "done", finishReason: "cancelled" });
        return;
      }

      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      console.error("[AssistantService] Stream error:", errorMessage);
      onChunk({
        type: "error",
        error: errorMessage,
      });
      onChunk({ type: "done" });
    } finally {
      // Only delete if this controller is still the active one
      if (this.activeStreams.get(sessionId) === controller) {
        this.activeStreams.delete(sessionId);
        this.chunkCallbacks.delete(sessionId);
      }
    }
  }

  emitChunk(sessionId: string, chunk: StreamChunk): void {
    const callback = this.chunkCallbacks.get(sessionId);
    if (callback) {
      callback(chunk);
    }
  }

  cancel(sessionId: string): void {
    const controller = this.activeStreams.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(sessionId);
      this.chunkCallbacks.delete(sessionId);
    }
  }

  clearSession(sessionId: string): void {
    this.cancel(sessionId);
    listenerManager.clearSession(sessionId);
  }

  cancelAll(): void {
    for (const [sessionId, controller] of this.activeStreams) {
      controller.abort();
      this.activeStreams.delete(sessionId);
      listenerManager.clearSession(sessionId);
    }
  }
}

export const assistantService = new AssistantService();
