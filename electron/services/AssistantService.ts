import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage, stepCountIs, type JSONValue, APICallError } from "ai";
import { store } from "../store.js";
import type { StreamChunk, AssistantMessage } from "../../shared/types/assistant.js";
import type { ActionManifestEntry, ActionContext } from "../../shared/types/actions.js";
import { createActionTools, sanitizeToolName } from "./assistant/actionTools.js";
import { SYSTEM_PROMPT, buildContextBlock } from "./assistant/index.js";
import { listenerManager } from "./assistant/ListenerManager.js";
import { createListenerTools } from "./assistant/listenerTools.js";
import { createCombinedTools } from "./assistant/combinedTools.js";
import { pendingEventQueue, type PendingEvent } from "./assistant/PendingEventQueue.js";
import {
  logAssistantRequest,
  logAssistantStreamEvent,
  logAssistantComplete,
  logAssistantError,
  logAssistantCancelled,
  logAssistantStreamPart,
  logAssistantRetry,
} from "../utils/assistantLogger.js";

/**
 * Sanitizes error messages to remove sensitive information.
 * Removes API keys, bearer tokens, credentials, file paths, and control characters.
 */
function sanitizeErrorMessage(message: string): string {
  let sanitized = message;

  // Remove API keys (common patterns: sk-xxx, fw-xxx, api-key patterns)
  sanitized = sanitized.replace(/\b(sk|fw|api|key)[_-]?[a-zA-Z0-9]{16,}\b/gi, "[REDACTED_KEY]");

  // Remove JWTs (three base64 segments separated by dots)
  sanitized = sanitized.replace(
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[REDACTED_JWT]"
  );

  // Remove credentials from URLs (scheme://user:pass@host)
  sanitized = sanitized.replace(/(https?:\/\/)[^:@\s]+:[^@\s]+@/gi, "$1[REDACTED]@");

  // Remove API keys/tokens from query parameters and JSON
  sanitized = sanitized.replace(
    /\b(api_key|apikey|key|token|access_token|refresh_token|id_token|secret|password|session|auth|authorization)["']?\s*[:=]\s*["']?[a-zA-Z0-9\-._~+/]+(["']|\b)/gi,
    "$1=[REDACTED]"
  );

  // Remove all Authorization header values (any scheme)
  sanitized = sanitized.replace(
    /Authorization['":\s]+(Bearer|Basic|Token|Api-Key|Digest)\s+[^\s"']+/gi,
    "Authorization: [REDACTED]"
  );

  // Remove X-API-Key and similar headers
  sanitized = sanitized.replace(
    /(X-API-Key|Api-Key|X-Auth-Token)['":\s]+[^\s"']+/gi,
    "$1: [REDACTED]"
  );

  // Remove file paths (Unix and Windows)
  sanitized = sanitized.replace(/\/(Users|home|usr|var|tmp|opt)\/[^\s"']+/g, "[PATH]");
  sanitized = sanitized.replace(/[A-Z]:\\[^\s"']+/g, "[PATH]");
  sanitized = sanitized.replace(/file:\/\/[^\s"']+/g, "file://[PATH]");

  // Remove ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  // Remove other control characters (C0 and C1 control codes except newline/tab)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");

  // Remove bidirectional text override characters (security risk)
  sanitized = sanitized.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");

  // Enforce maximum display length (prevent UI overflow)
  const MAX_ERROR_LENGTH = 2000;
  if (sanitized.length > MAX_ERROR_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ERROR_LENGTH) + "\n... (truncated)";
  }

  return sanitized;
}

/**
 * Extracts a human-readable error message from various error types.
 * Handles Vercel AI SDK errors, Fireworks.ai API responses, and generic errors.
 */
function extractDetailedError(error: unknown): string {
  const details: string[] = [];

  // Handle APICallError from Vercel AI SDK
  if (APICallError.isInstance(error)) {
    // Start with the base error message
    let mainMessage = error.message;

    // Try to parse the response body for provider-specific error details
    if (error.responseBody) {
      // Limit response body size to prevent memory/CPU issues
      const MAX_RESPONSE_SIZE = 64 * 1024; // 64KB
      const responseBody = error.responseBody.slice(0, MAX_RESPONSE_SIZE);

      try {
        const body = JSON.parse(responseBody);

        // Guard against null or non-object JSON
        if (body && typeof body === "object") {
          // Fireworks.ai format: { error: { message, type, code } }
          if (body.error) {
            if (typeof body.error === "string") {
              // error is a string
              mainMessage = body.error;
            } else if (typeof body.error === "object" && body.error !== null) {
              // error is an object
              if (body.error.message) {
                mainMessage = body.error.message;
              }
              if (body.error.type) {
                details.push(`Type: ${body.error.type}`);
              }
              if (body.error.code) {
                details.push(`Code: ${body.error.code}`);
              }
            }
          }
          // Alternative format: { message, code } or { detail }
          else if (body.message) {
            mainMessage = body.message;
            if (body.code) {
              details.push(`Code: ${body.code}`);
            }
          } else if (body.detail) {
            mainMessage = body.detail;
          }
          // Handle errors array: { errors: [{ message }] }
          else if (Array.isArray(body.errors) && body.errors.length > 0 && body.errors[0].message) {
            mainMessage = body.errors[0].message;
          }
        }
      } catch {
        // Response body is not JSON, include truncated snippet
        const snippet = responseBody.slice(0, 200);
        details.push(`Response: ${snippet}${responseBody.length > 200 ? "..." : ""}`);
      }
    }

    // Add HTTP status code
    if (error.statusCode) {
      const statusText = getHttpStatusText(error.statusCode);
      details.unshift(`HTTP ${error.statusCode}${statusText ? ` (${statusText})` : ""}`);
    }

    // Add retryable hint for rate limits
    if (error.isRetryable && error.statusCode === 429) {
      details.push("Rate limited - please wait and try again");
    }

    // Build the full error message
    const fullError = [mainMessage, ...details].filter(Boolean).join("\n");
    return sanitizeErrorMessage(fullError);
  }

  // Handle generic Error objects
  if (error instanceof Error) {
    const mainMessage = error.message;

    // Check for nested cause (common in wrapped errors)
    if (error.cause && error.cause instanceof Error) {
      details.push(`Caused by: ${error.cause.message}`);
    }

    // Check for common error properties that might be present on custom error types
    const errorAny = error as unknown as Record<string, unknown>;

    // Handle statusCode (number or numeric string)
    if (typeof errorAny["statusCode"] === "number") {
      const statusText = getHttpStatusText(errorAny["statusCode"] as number);
      details.unshift(`HTTP ${errorAny["statusCode"]}${statusText ? ` (${statusText})` : ""}`);
    } else if (typeof errorAny["statusCode"] === "string") {
      const statusCode = parseInt(errorAny["statusCode"], 10);
      if (!isNaN(statusCode)) {
        const statusText = getHttpStatusText(statusCode);
        details.unshift(`HTTP ${statusCode}${statusText ? ` (${statusText})` : ""}`);
      }
    }

    if (typeof errorAny["code"] === "string") {
      details.push(`Code: ${errorAny["code"]}`);
    }

    const fullError = [mainMessage, ...details].filter(Boolean).join("\n");
    return sanitizeErrorMessage(fullError);
  }

  // Handle string errors
  if (typeof error === "string") {
    return sanitizeErrorMessage(error);
  }

  // Handle unknown error types
  if (error && typeof error === "object") {
    const errorObj = error as Record<string, unknown>;
    if (typeof errorObj["message"] === "string") {
      return sanitizeErrorMessage(errorObj["message"]);
    }
    // Extract safe fields instead of stringifying entire object
    const safeFields: string[] = [];
    if (typeof errorObj["code"] === "string" || typeof errorObj["code"] === "number") {
      safeFields.push(`Code: ${errorObj["code"]}`);
    }
    if (typeof errorObj["type"] === "string") {
      safeFields.push(`Type: ${errorObj["type"]}`);
    }
    if (typeof errorObj["statusCode"] === "number") {
      safeFields.push(`Status: ${errorObj["statusCode"]}`);
    }

    if (safeFields.length > 0) {
      return sanitizeErrorMessage(["Unknown error", ...safeFields].join("\n"));
    }

    // Last resort: try safe JSON stringify with circular reference handling
    try {
      const seen = new Set<unknown>();
      const json = JSON.stringify(
        error,
        (key, value) => {
          // Skip sensitive fields
          if (["headers", "config", "request", "response", "stack"].includes(key)) {
            return "[OMITTED]";
          }
          // Handle circular references
          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) {
              return "[Circular]";
            }
            seen.add(value);
          }
          return value;
        },
        2
      );
      if (json.length < 500) {
        return sanitizeErrorMessage(json);
      }
      return sanitizeErrorMessage(json.slice(0, 200) + "...");
    } catch {
      return "Unknown error occurred";
    }
  }

  return "Unknown error occurred";
}

/**
 * Returns a human-readable description for common HTTP status codes.
 */
function getHttpStatusText(statusCode: number): string {
  const statusTexts: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    408: "Request Timeout",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return statusTexts[statusCode] || "";
}

/**
 * Extracts a detailed error message from stream part errors.
 * Stream errors may come as strings, Error objects, or structured data.
 */
function extractStreamPartError(partError: unknown): string {
  if (!partError) {
    return "Stream error occurred";
  }

  if (typeof partError === "string") {
    return sanitizeErrorMessage(partError);
  }

  if (partError instanceof Error) {
    return extractDetailedError(partError);
  }

  // Handle structured error objects
  if (typeof partError === "object") {
    const errorObj = partError as Record<string, unknown>;

    // Try common error formats
    if (typeof errorObj["message"] === "string") {
      const details: string[] = [];
      const mainMessage = errorObj["message"];

      if (typeof errorObj["code"] === "string") {
        details.push(`Code: ${errorObj["code"]}`);
      }
      if (typeof errorObj["type"] === "string") {
        details.push(`Type: ${errorObj["type"]}`);
      }

      const fullError = [mainMessage, ...details].filter(Boolean).join("\n");
      return sanitizeErrorMessage(fullError);
    }

    // Fallback: safe stringify with circular reference handling
    try {
      const seen = new Set<unknown>();
      const json = JSON.stringify(
        partError,
        (key, value) => {
          // Skip sensitive fields
          if (["headers", "config", "request", "response", "stack"].includes(key)) {
            return "[OMITTED]";
          }
          // Handle circular references
          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) {
              return "[Circular]";
            }
            seen.add(value);
          }
          return value;
        },
        2
      );
      if (json.length < 500) {
        return sanitizeErrorMessage(json);
      }
      return sanitizeErrorMessage(json.slice(0, 200) + "...");
    } catch {
      return "Stream error occurred (unserializable)";
    }
  }

  return "Stream error occurred";
}

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

// Retry configuration
const MAX_AUTO_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 2000]; // Exponential backoff: 1s, 2s

/**
 * Determines if an error or response condition is retryable.
 * Empty responses, rate limits, and server errors are retryable.
 * Auth errors and client errors are not retryable.
 */
function isRetryableCondition(
  error: unknown,
  finishReason?: string,
  hasContent?: boolean
): boolean {
  // Empty responses (finishReason: "other" with no content) are retryable
  if (finishReason === "other" && !hasContent) {
    return true;
  }

  if (!error) {
    return false;
  }

  // Handle APICallError from Vercel AI SDK
  if (APICallError.isInstance(error)) {
    const statusCode = error.statusCode;

    // Rate limits are retryable
    if (statusCode === 429) {
      return true;
    }

    // Server errors (5xx) are retryable
    if (statusCode && statusCode >= 500) {
      return true;
    }

    // Auth errors (401, 403) are NOT retryable
    if (statusCode === 401 || statusCode === 403) {
      return false;
    }

    // Check the SDK's own retryable flag
    if (error.isRetryable) {
      return true;
    }
  }

  // Handle generic errors with status codes
  if (error instanceof Error) {
    const errorAny = error as unknown as Record<string, unknown>;
    const statusCode = errorAny["statusCode"];

    if (typeof statusCode === "number") {
      if (statusCode === 429 || statusCode >= 500) {
        return true;
      }
      if (statusCode === 401 || statusCode === 403) {
        return false;
      }
    }
  }

  return false;
}

/**
 * Delays execution for the specified number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AssistantService {
  private fireworks: ReturnType<typeof createOpenAI> | null = null;
  private activeStreams = new Map<string, AbortController>();
  private chunkCallbacks = new Map<string, (chunk: StreamChunk) => void>();

  constructor() {
    this.initializeProvider();
  }

  private initializeProvider(): void {
    const config = store.get("appAgentConfig");
    if (config?.apiKey) {
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
    return !!config?.apiKey;
  }

  updateApiKey(): void {
    this.initializeProvider();
  }

  private buildPendingEventsSection(events: PendingEvent[]): string {
    if (events.length === 0) {
      return "";
    }

    const lines = ["Pending listener events (unacknowledged):"];

    for (const event of events) {
      const dataStr = this.formatEventData(event.data);
      const time = new Date(event.timestamp).toISOString();
      lines.push(`- [${event.eventType}] ${dataStr} (id: ${event.id}, at: ${time})`);
    }

    lines.push("");
    lines.push(
      "Use list_pending_events to get full event details, or acknowledge_event to mark as seen."
    );

    return lines.join("\n");
  }

  private formatEventData(data: unknown): string {
    if (data === null || data === undefined) {
      return "{}";
    }
    if (typeof data !== "object") {
      return String(data);
    }

    const record = data as Record<string, unknown>;
    const parts: string[] = [];

    // Extract key fields for terminal state events
    if (record.terminalId) {
      parts.push(`terminal: ${record.terminalId}`);
    }
    if (record.newState) {
      parts.push(`state: ${record.newState}`);
    }
    if (record.oldState && record.newState) {
      parts.push(`(${record.oldState} → ${record.newState})`);
    }

    if (parts.length === 0) {
      // Fallback: show first 3 keys
      const keys = Object.keys(record).slice(0, 3);
      for (const key of keys) {
        const value = record[key];
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);
        parts.push(`${key}: ${valueStr}`);
      }
    }

    return parts.join(", ");
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
      const errorMsg = "API key not configured. Please add your Fireworks API key in Settings.";
      logAssistantError(sessionId, errorMsg);
      onChunk({
        type: "error",
        error: errorMsg,
      });
      onChunk({ type: "done" });
      return;
    }

    if (!this.fireworks) {
      this.initializeProvider();
    }

    if (!this.fireworks) {
      const errorMsg = "Failed to initialize AI provider.";
      logAssistantError(sessionId, errorMsg);
      onChunk({
        type: "error",
        error: errorMsg,
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

    const overallStartTime = Date.now();

    // Retry loop
    for (let attempt = 1; attempt <= MAX_AUTO_RETRIES + 1; attempt++) {
      let hasContent = false;
      let finishReason: string | undefined;
      let wasCancelled = false;

      try {
        // Build context block for the system prompt
        const activeListenerCount = listenerManager.countForSession(sessionId);
        const pendingEvents = pendingEventQueue.getPending(sessionId);
        const contextBlock = context
          ? buildContextBlock({ ...context, activeListenerCount })
          : activeListenerCount > 0
            ? buildContextBlock({ activeListenerCount })
            : "";

        // Build pending events section if there are unacknowledged events
        const pendingEventsSection = this.buildPendingEventsSection(pendingEvents);

        const systemPromptWithContext = [SYSTEM_PROMPT, contextBlock, pendingEventsSection]
          .filter(Boolean)
          .join("\n\n");

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

        // Build tools from filtered actions, listener management, and combined tools
        const actionTools =
          filteredActions && context ? createActionTools(filteredActions, context) : {};
        const listenerTools = createListenerTools({ sessionId });
        const combinedTools = context
          ? createCombinedTools({ sessionId, actionContext: context })
          : {};
        const tools = { ...actionTools, ...listenerTools, ...combinedTools };
        const hasTools = Object.keys(tools).length > 0;

        // Log request (include attempt number for retries)
        logAssistantRequest(
          sessionId,
          messages,
          filteredActions,
          Object.keys(listenerTools).length,
          context,
          config.model,
          systemPromptWithContext.length
        );

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
            wasCancelled = true;
            break;
          }

          switch (part.type) {
            case "text-delta": {
              hasContent = true;
              const chunk: StreamChunk = { type: "text", content: part.text };
              logAssistantStreamEvent(sessionId, chunk);
              onChunk(chunk);
              break;
            }

            case "tool-call": {
              hasContent = true;
              const chunk: StreamChunk = {
                type: "tool_call",
                toolCall: {
                  id: part.toolCallId,
                  name: part.toolName,
                  args: part.input as Record<string, unknown>,
                },
              };
              logAssistantStreamEvent(sessionId, chunk);
              onChunk(chunk);
              break;
            }

            case "tool-result": {
              hasContent = true;
              const chunk: StreamChunk = {
                type: "tool_result",
                toolResult: {
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  result: part.output,
                },
              };
              logAssistantStreamEvent(sessionId, chunk);
              onChunk(chunk);
              break;
            }

            case "error": {
              console.error("[AssistantService] Stream part error:", part.error);
              const chunk: StreamChunk = {
                type: "error",
                error: extractStreamPartError(part.error),
              };
              logAssistantStreamEvent(sessionId, chunk);
              onChunk(chunk);
              break;
            }

            default: {
              logAssistantStreamPart(sessionId, part.type, part);
              break;
            }
          }
        }

        // Handle cancellation
        if (wasCancelled) {
          logAssistantCancelled(sessionId, Date.now() - overallStartTime);
          onChunk({ type: "done", finishReason: "cancelled" });
          return;
        }

        // Get finish reason
        const finalResult = await result;
        finishReason = (await finalResult.finishReason) ?? undefined;

        // Check if we should retry (empty response)
        if (!hasContent && isRetryableCondition(null, finishReason, hasContent)) {
          const isLastAttempt = attempt > MAX_AUTO_RETRIES;

          if (!isLastAttempt) {
            // Check if cancelled before retry
            if (controller.signal.aborted) {
              logAssistantCancelled(sessionId, Date.now() - overallStartTime);
              onChunk({ type: "done", finishReason: "cancelled" });
              return;
            }

            // More retries available - notify client and wait
            const delayMs =
              RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
            const reason = "Empty response from model";

            logAssistantRetry(sessionId, attempt, MAX_AUTO_RETRIES + 1, reason, delayMs);

            onChunk({
              type: "retrying",
              retryInfo: {
                attempt,
                maxAttempts: MAX_AUTO_RETRIES + 1,
                reason,
              },
            });

            await delay(delayMs);

            // Check if cancelled during delay
            if (controller.signal.aborted) {
              logAssistantCancelled(sessionId, Date.now() - overallStartTime);
              onChunk({ type: "done", finishReason: "cancelled" });
              return;
            }

            continue; // Retry the request
          } else {
            // Last attempt failed with empty response - break to error path
            break;
          }
        }

        // Success or non-retryable completion
        logAssistantComplete(sessionId, finishReason, Date.now() - overallStartTime);
        onChunk({
          type: "done",
          finishReason,
        });

        // Cleanup
        if (this.activeStreams.get(sessionId) === controller) {
          this.activeStreams.delete(sessionId);
          this.chunkCallbacks.delete(sessionId);
        }
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          logAssistantCancelled(sessionId, Date.now() - overallStartTime);
          onChunk({ type: "done", finishReason: "cancelled" });
          return;
        }

        // Check if this error is retryable
        const isRetryable = isRetryableCondition(error, undefined, hasContent);
        const isLastAttempt = attempt > MAX_AUTO_RETRIES;

        if (isRetryable && !isLastAttempt) {
          // Check if cancelled before retry
          if (controller.signal.aborted) {
            logAssistantCancelled(sessionId, Date.now() - overallStartTime);
            onChunk({ type: "done", finishReason: "cancelled" });
            return;
          }

          // More retries available - notify client and wait
          const delayMs =
            RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
          const reason = extractDetailedError(error);

          logAssistantRetry(sessionId, attempt, MAX_AUTO_RETRIES + 1, reason, delayMs);

          onChunk({
            type: "retrying",
            retryInfo: {
              attempt,
              maxAttempts: MAX_AUTO_RETRIES + 1,
              reason,
            },
          });

          await delay(delayMs);

          // Check if cancelled during delay
          if (controller.signal.aborted) {
            logAssistantCancelled(sessionId, Date.now() - overallStartTime);
            onChunk({ type: "done", finishReason: "cancelled" });
            return;
          }

          continue; // Retry the request
        }

        // Non-retryable error or max retries exceeded
        const errorMessage = extractDetailedError(error);

        console.error("[AssistantService] Stream error:", error);
        if (error instanceof Error && error.stack) {
          console.error("[AssistantService] Stack trace:", error.stack);
        }

        logAssistantError(sessionId, errorMessage, Date.now() - overallStartTime);
        onChunk({
          type: "error",
          error: errorMessage,
        });
        onChunk({ type: "done" });

        // Cleanup
        if (this.activeStreams.get(sessionId) === controller) {
          this.activeStreams.delete(sessionId);
          this.chunkCallbacks.delete(sessionId);
        }
        return;
      }
    }

    // Max retries exceeded with empty response - show user-friendly message
    logAssistantError(
      sessionId,
      "The model did not respond after multiple retries",
      Date.now() - overallStartTime
    );
    onChunk({
      type: "error",
      error: "The model did not respond after multiple retries. Please try again.",
    });
    onChunk({ type: "done" });

    // Cleanup
    if (this.activeStreams.get(sessionId) === controller) {
      this.activeStreams.delete(sessionId);
      this.chunkCallbacks.delete(sessionId);
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
    pendingEventQueue.clearSession(sessionId);
  }

  cancelAll(): void {
    for (const [sessionId, controller] of this.activeStreams) {
      controller.abort();
      this.activeStreams.delete(sessionId);
      this.chunkCallbacks.delete(sessionId);
      listenerManager.clearSession(sessionId);
      pendingEventQueue.clearSession(sessionId);
    }
  }

  clearAllSessions(): void {
    for (const controller of this.activeStreams.values()) {
      controller.abort();
    }
    this.activeStreams.clear();
    this.chunkCallbacks.clear();
    listenerManager.clearAllSessions();
    pendingEventQueue.clearAll();
  }
}

export const assistantService = new AssistantService();
