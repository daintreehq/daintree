/**
 * Integration Tests for AssistantService
 *
 * These tests validate the Fireworks AI API compatibility directly with raw REST calls.
 * They do NOT test AssistantService.streamMessage() - they focus on API-level compatibility
 * including tool schema validation, parameter handling, and error responses.
 *
 * For end-to-end tests of AssistantService streaming, context assembly, tool filtering,
 * and error sanitization, see unit tests in AssistantService.test.ts (if they exist) or
 * consider adding service-level integration tests that call assistantService.streamMessage().
 *
 * RUNNING THESE TESTS:
 *   npm run test:integration              # Run all integration tests
 *   npm run test:integration:watch        # Run in watch mode
 *
 * SETUP:
 *   1. Create a .env file in the project root
 *   2. Add: FIREWORKS_API_KEY=your_api_key_here
 *   3. Tests will be skipped if no API key is found
 *
 * WHEN TO USE:
 *   - Before releases to validate API compatibility
 *   - After adding new tools to verify schema compatibility
 *   - When debugging assistant API issues
 *   - NOT for testing AssistantService business logic (use unit tests for that)
 *
 * NOTE: These tests make real API calls and may incur costs.
 * Keep test scenarios minimal to reduce API usage.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../../..");

// ============================================================================
// ENVIRONMENT SETUP
// ============================================================================

interface EnvVars {
  FIREWORKS_API_KEY?: string;
  FIREWORKS_AI_KEY?: string;
}

function loadEnv(): EnvVars {
  const envPath = path.join(ROOT, ".env");
  const env: EnvVars = {};

  // First check process.env (vitest may have loaded it)
  if (process.env.FIREWORKS_API_KEY) {
    env.FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY;
  }
  if (process.env.FIREWORKS_AI_KEY) {
    env.FIREWORKS_AI_KEY = process.env.FIREWORKS_AI_KEY;
  }

  // If not found, try reading .env file directly
  if (!env.FIREWORKS_API_KEY && !env.FIREWORKS_AI_KEY) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const [key, ...valueParts] = trimmed.split("=");
          if (key && valueParts.length > 0) {
            const value = valueParts
              .join("=")
              .trim()
              .replace(/^["']|["']$/g, "");
            if (key.trim() === "FIREWORKS_API_KEY") {
              env.FIREWORKS_API_KEY = value;
            } else if (key.trim() === "FIREWORKS_AI_KEY") {
              env.FIREWORKS_AI_KEY = value;
            }
          }
        }
      }
    }
  }

  return env;
}

const env = loadEnv();
const API_KEY = env.FIREWORKS_API_KEY || env.FIREWORKS_AI_KEY;
const hasApiKey = !!API_KEY && API_KEY.length > 0;

// Skip reason for display
const SKIP_REASON = !hasApiKey
  ? "FIREWORKS_API_KEY or FIREWORKS_AI_KEY not found in .env file. " +
    "Create a .env file in the project root with your API key to run integration tests."
  : undefined;

// ============================================================================
// TEST FIXTURES
// ============================================================================

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const MODEL = "accounts/fireworks/models/llama4-maverick-instruct-basic";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface ApiResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// Minimal tool set for basic testing
function getMinimalTools() {
  return [
    {
      type: "function",
      function: {
        name: "terminal_list",
        description: "[query] Get list of all terminals with metadata",
        parameters: {
          type: "object",
          properties: {
            worktreeId: { type: "string", description: "Filter by worktree ID" },
            location: {
              type: "string",
              enum: ["grid", "dock", "trash"],
              description: "Filter by location",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "worktree_list",
        description: "[query] Get list of all worktrees",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
}

// Extended tool set for comprehensive testing
function getExtendedTools() {
  return [
    ...getMinimalTools(),
    {
      type: "function",
      function: {
        name: "terminal_getOutput",
        description: "[query] Get terminal output content",
        parameters: {
          type: "object",
          properties: {
            terminalId: { type: "string", description: "Terminal instance ID" },
            maxLines: { type: "integer", description: "Maximum lines to return" },
            stripAnsi: { type: "boolean", description: "Remove ANSI escape codes" },
          },
          required: ["terminalId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "register_listener",
        description: "Subscribe to Canopy events",
        parameters: {
          type: "object",
          properties: {
            eventType: { type: "string", description: "The event type to subscribe to" },
            filter: {
              type: "object",
              description: "Optional filter for events",
              additionalProperties: true,
            },
          },
          required: ["eventType"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "agent_launch",
        description: "[command] Launch an AI coding agent",
        parameters: {
          type: "object",
          properties: {
            agentType: {
              type: "string",
              enum: ["claude", "gemini", "codex", "opencode"],
              description: "Type of agent to launch",
            },
            task: { type: "string", description: "Task description for the agent" },
          },
          required: ["agentType"],
        },
      },
    },
  ];
}

async function makeApiCall(
  messages: ChatMessage[],
  tools?: unknown[],
  maxTokens: number = 1024
): Promise<ApiResponse> {
  if (!API_KEY) {
    throw new Error("API key not available");
  }

  const requestBody: Record<string, unknown> = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    // Use deterministic settings to reduce test flakiness
    temperature: 0,
  };

  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = "auto";
  }

  const response = await fetch(`${FIREWORKS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();

  if (!response.ok) {
    // Try to parse as JSON, but handle non-JSON error responses gracefully
    let errorMessage = responseText;
    try {
      const errorData = JSON.parse(responseText);
      errorMessage = errorData.error?.message || errorData.message || responseText;
    } catch {
      // Response is not JSON, use raw text
    }
    throw new Error(`API error ${response.status}: ${errorMessage}`);
  }

  return JSON.parse(responseText);
}

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe.skipIf(!hasApiKey)("AssistantService Integration", () => {
  beforeAll(() => {
    if (!hasApiKey) {
      console.warn("\n" + "=".repeat(70));
      console.warn("SKIPPING INTEGRATION TESTS");
      console.warn(SKIP_REASON);
      console.warn("=".repeat(70) + "\n");
    } else {
      console.log("\n" + "=".repeat(70));
      console.log("RUNNING INTEGRATION TESTS");
      console.log(`Using API key: [REDACTED]`);
      console.log(`Model: ${MODEL}`);
      console.log("=".repeat(70) + "\n");
    }
  });

  describe("Basic Chat Completions", () => {
    it("should complete a simple message without tools", async () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant. Respond briefly." },
        { role: "user", content: "Say hello in exactly 5 words." },
      ];

      const response = await makeApiCall(messages);

      expect(response.choices).toBeDefined();
      expect(response.choices?.length).toBeGreaterThan(0);
      expect(response.choices?.[0]?.message?.content).toBeDefined();
      expect(response.choices?.[0]?.message?.role).toBe("assistant");
      expect(response.choices?.[0]?.finish_reason).toBe("stop");
    });

    it("should complete a message with minimal tools", async () => {
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are Canopy's operator. You have access to tools for controlling an IDE. Respond briefly.",
        },
        { role: "user", content: "What tools do you have access to?" },
      ];

      const response = await makeApiCall(messages, getMinimalTools());

      expect(response.choices).toBeDefined();
      expect(response.choices?.length).toBeGreaterThan(0);

      const message = response.choices?.[0]?.message;
      expect(message).toBeDefined();
      // Should either describe tools or call one
      expect(message?.content || message?.tool_calls).toBeDefined();
    });
  });

  describe("Tool Schema Validation", () => {
    it("should accept minimal tool set without schema errors", async () => {
      const tools = getMinimalTools();
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant with tools." },
        { role: "user", content: "List the available worktrees." },
      ];

      // This should not throw a schema validation error
      const response = await makeApiCall(messages, tools);

      expect(response.error).toBeUndefined();
      expect(response.choices).toBeDefined();
    });

    it("should accept extended tool set without schema errors", async () => {
      const tools = getExtendedTools();
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant with tools." },
        { role: "user", content: "What commands can you run?" },
      ];

      const response = await makeApiCall(messages, tools);

      expect(response.error).toBeUndefined();
      expect(response.choices).toBeDefined();
    });

    it("should handle tools with complex parameter schemas", async () => {
      const tools = [
        {
          type: "function",
          function: {
            name: "terminal_inject",
            description: "[command] Inject text or commands into a terminal",
            parameters: {
              type: "object",
              properties: {
                terminalId: { type: "string", description: "Target terminal ID" },
                text: { type: "string", description: "Text to inject" },
                execute: {
                  type: "boolean",
                  description: "Whether to execute (press Enter) after injection",
                },
                delay: {
                  type: "number",
                  description: "Delay in milliseconds between characters",
                },
              },
              required: ["terminalId", "text"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "sidecar_openUrl",
            description: "[command] Open a URL in the sidecar browser",
            parameters: {
              type: "object",
              properties: {
                url: { type: "string", description: "URL to open" },
                newTab: { type: "boolean", description: "Open in new tab" },
              },
              required: ["url"],
            },
          },
        },
      ];

      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Describe the inject command." },
      ];

      const response = await makeApiCall(messages, tools);

      expect(response.error).toBeUndefined();
      expect(response.choices).toBeDefined();
    });
  });

  describe("Tool Invocation", () => {
    it("should invoke a tool when explicitly requested", async () => {
      const tools = getMinimalTools();
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are an IDE assistant. When asked to list terminals, call the terminal_list tool.",
        },
        { role: "user", content: "Call the terminal_list tool to show me all terminals." },
      ];

      const response = await makeApiCall(messages, tools);

      expect(response.choices).toBeDefined();
      const message = response.choices?.[0]?.message;

      // The model should call the tool - enforce this expectation
      expect(message?.tool_calls).toBeDefined();
      expect(message?.tool_calls?.length).toBeGreaterThan(0);
      expect(message?.tool_calls?.[0]?.function.name).toBe("terminal_list");
      expect(response.choices?.[0]?.finish_reason).toBe("tool_calls");
    });

    it("should handle tool invocation with arguments", async () => {
      const tools = getExtendedTools();
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: "You are an IDE assistant. Call tools as requested.",
        },
        {
          role: "user",
          content: "Get the output from terminal 'term-123', max 50 lines, strip ANSI codes.",
        },
      ];

      const response = await makeApiCall(messages, tools);

      expect(response.choices).toBeDefined();
      const message = response.choices?.[0]?.message;

      // Enforce tool call expectation
      expect(message?.tool_calls).toBeDefined();
      expect(message?.tool_calls?.length).toBeGreaterThan(0);

      const toolCall = message!.tool_calls![0];
      expect(toolCall.function.name).toBe("terminal_getOutput");

      const args = JSON.parse(toolCall.function.arguments);
      expect(args.terminalId).toBe("term-123");
      // Note: Model behavior may vary, so we don't enforce exact argument values
      // Just verify the structure is correct
      expect(args).toHaveProperty("terminalId");
    });
  });

  describe("Tool Result Handling", () => {
    it("should process tool results and continue conversation", async () => {
      const tools = getMinimalTools();

      // First message requesting tool call
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: "You are an IDE assistant. Call tools and summarize results briefly.",
        },
        { role: "user", content: "List all terminals." },
      ];

      const firstResponse = await makeApiCall(messages, tools);
      expect(firstResponse.choices).toBeDefined();

      const assistantMessage = firstResponse.choices?.[0]?.message;

      // If the model called a tool, provide a result
      if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolCall = assistantMessage.tool_calls[0];

        // Build the conversation with tool result
        const messagesWithResult: ChatMessage[] = [
          ...messages,
          {
            role: "assistant",
            content: assistantMessage.content || "",
            tool_calls: assistantMessage.tool_calls as ChatMessage["tool_calls"],
          },
          {
            role: "tool",
            content: JSON.stringify({
              success: true,
              result: [
                { id: "term-1", name: "Terminal 1", location: "grid" },
                { id: "term-2", name: "Claude Agent", location: "dock" },
              ],
            }),
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
          },
        ];

        const secondResponse = await makeApiCall(messagesWithResult, tools);

        expect(secondResponse.choices).toBeDefined();
        const finalMessage = secondResponse.choices?.[0]?.message;

        // Should have a text response summarizing the results
        expect(finalMessage?.content).toBeDefined();
        expect(finalMessage?.content?.length).toBeGreaterThan(0);
      }
    });

    it("should handle multiple tool calls in sequence", async () => {
      const tools = getMinimalTools();

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: "You are an IDE assistant. You can call multiple tools.",
        },
        { role: "user", content: "Show me terminals and worktrees." },
      ];

      const response = await makeApiCall(messages, tools);

      expect(response.choices).toBeDefined();
      const message = response.choices?.[0]?.message;

      // Model might call one or both tools
      if (message?.tool_calls && message.tool_calls.length > 0) {
        // Verify tool calls have valid structure
        for (const toolCall of message.tool_calls) {
          expect(toolCall.id).toBeDefined();
          expect(toolCall.type).toBe("function");
          expect(toolCall.function.name).toBeDefined();
          expect(["terminal_list", "worktree_list"]).toContain(toolCall.function.name);
        }
      }
    });
  });

  describe("Error Scenarios", () => {
    it("should handle rate limiting gracefully", async () => {
      // Make a simple request - if rate limited, should get a clear error
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello." },
      ];

      try {
        const response = await makeApiCall(messages);
        // If we get here, request succeeded
        expect(response.choices).toBeDefined();
      } catch (error) {
        // Rate limit errors should be identifiable
        if (error instanceof Error && error.message.includes("429")) {
          expect(error.message).toContain("429");
        } else {
          throw error;
        }
      }
    });

    it("should return error for invalid model", async () => {
      if (!API_KEY) {
        return;
      }

      const response = await fetch(`${FIREWORKS_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: "accounts/fireworks/models/nonexistent-model",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 10,
        }),
      });

      expect(response.ok).toBe(false);
      expect([400, 404]).toContain(response.status);
    });
  });

  describe("Message History", () => {
    it("should maintain conversation context across turns", async () => {
      const tools = getMinimalTools();

      // Turn 1: Ask something that sets context
      const turn1Messages: ChatMessage[] = [
        {
          role: "system",
          content: "You are a helpful assistant. Remember previous messages.",
        },
        { role: "user", content: "My favorite terminal is called 'dev-server'. Remember that." },
      ];

      const turn1Response = await makeApiCall(turn1Messages, tools);
      expect(turn1Response.choices).toBeDefined();

      // Turn 2: Reference previous context
      const turn2Messages: ChatMessage[] = [
        ...turn1Messages,
        {
          role: "assistant",
          content: turn1Response.choices?.[0]?.message?.content || "Understood.",
        },
        { role: "user", content: "What was my favorite terminal called?" },
      ];

      const turn2Response = await makeApiCall(turn2Messages, tools);
      expect(turn2Response.choices).toBeDefined();

      const content = turn2Response.choices?.[0]?.message?.content?.toLowerCase() || "";
      expect(content).toContain("dev-server");
    });

    it("should handle conversation with tool calls in history", async () => {
      const tools = getMinimalTools();

      // Simulate a conversation with prior tool call
      const messages: ChatMessage[] = [
        { role: "system", content: "You are an IDE assistant." },
        { role: "user", content: "List terminals." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "terminal_list", arguments: "{}" },
            },
          ],
        } as ChatMessage,
        {
          role: "tool",
          content: JSON.stringify({
            success: true,
            result: [{ id: "t1", name: "Main Terminal" }],
          }),
          tool_call_id: "call_123",
          name: "terminal_list",
        },
        { role: "assistant", content: "Found 1 terminal: Main Terminal" },
        { role: "user", content: "How many terminals did you find?" },
      ];

      const response = await makeApiCall(messages, tools);

      expect(response.choices).toBeDefined();
      const content = response.choices?.[0]?.message?.content?.toLowerCase() || "";
      expect(content).toMatch(/1|one|single/);
    });
  });

  describe("Large Tool Manifest", () => {
    it("should handle a large number of tools without errors", async () => {
      // Create a manifest with many tools (similar to full action manifest)
      const manyTools = [];
      const categories = ["terminal", "worktree", "project", "agent", "sidecar"];

      for (let i = 0; i < 50; i++) {
        const category = categories[i % categories.length];
        manyTools.push({
          type: "function",
          function: {
            name: `${category}_action_${i}`,
            description: `[command] Test action ${i} for ${category}`,
            parameters: {
              type: "object",
              properties: {
                param1: { type: "string" },
                param2: { type: "number" },
              },
            },
          },
        });
      }

      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant with many tools." },
        { role: "user", content: "How many tools are available?" },
      ];

      const response = await makeApiCall(messages, manyTools);

      expect(response.error).toBeUndefined();
      expect(response.choices).toBeDefined();
    });
  });

  describe("Streaming Simulation", () => {
    it("should handle a complete request/response cycle", async () => {
      const tools = getExtendedTools();

      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are Canopy's assistant. You help developers manage their IDE. " +
            "You have access to tools for terminal management, worktree operations, and more.",
        },
        {
          role: "user",
          content: "I want to see what terminals are running and which worktrees are active.",
        },
      ];

      const startTime = Date.now();
      const response = await makeApiCall(messages, tools);
      const duration = Date.now() - startTime;

      expect(response.choices).toBeDefined();
      expect(duration).toBeLessThan(30000); // Should complete within 30 seconds

      // Log for debugging
      console.log(`Request completed in ${duration}ms`);
      console.log(`Tokens used: ${response.usage?.total_tokens || "unknown"}`);
    });
  });
});

// ============================================================================
// SKIP MESSAGE WHEN NO API KEY
// ============================================================================

if (!hasApiKey) {
  describe("AssistantService Integration (SKIPPED)", () => {
    it("skips because API key is not configured", () => {
      console.log("\n" + "=".repeat(70));
      console.log("INTEGRATION TESTS SKIPPED");
      console.log(SKIP_REASON);
      console.log("=".repeat(70) + "\n");
      expect(true).toBe(true);
    });
  });
}
