#!/usr/bin/env npx tsx
/**
 * Test Assistant API
 *
 * Makes a simple request to the Fireworks AI API with the same tool definitions
 * that the Canopy assistant would use. Helps debug schema/formatting issues.
 *
 * Usage:
 *   npm run assistant:test-api
 *
 * Requires a .env file in the project root with:
 *   FIREWORKS_API_KEY=your_api_key_here
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ============================================================================
// LOAD ENVIRONMENT
// ============================================================================

function loadEnv(): Record<string, string> {
  const envPath = path.join(ROOT, ".env");
  const env: Record<string, string> = {};

  if (!fs.existsSync(envPath)) {
    console.error("Error: .env file not found in project root");
    console.error("Expected path:", envPath);
    console.error("\nCreate a .env file with:");
    console.error("  FIREWORKS_API_KEY=your_api_key_here");
    process.exit(1);
  }

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  return env;
}

// ============================================================================
// TOOL DEFINITIONS (simplified subset for testing)
// ============================================================================

function getTestTools() {
  return [
    {
      type: "function",
      function: {
        name: "terminal_list",
        description: "[query] Get list of all terminals with metadata",
        parameters: {
          type: "object",
          properties: {
            worktreeId: {
              type: "string",
              description: "Filter by worktree ID",
            },
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
        name: "terminal_getOutput",
        description: "[query] Get terminal output content",
        parameters: {
          type: "object",
          properties: {
            terminalId: {
              type: "string",
              description: "Terminal instance ID",
            },
            maxLines: {
              type: "integer",
              description: "Maximum lines to return",
            },
            stripAnsi: {
              type: "boolean",
              description: "Remove ANSI escape codes",
            },
          },
          required: ["terminalId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "worktree_list",
        description: "[query] Get list of all worktrees",
        parameters: {
          type: "object",
          properties: {},
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
            eventType: {
              type: "string",
              description: "The event type to subscribe to",
            },
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
  ];
}

// ============================================================================
// FULL TOOLS FROM DUMP SCRIPT (for comprehensive testing)
// ============================================================================

async function getFullTools(): Promise<unknown[]> {
  // Import the same logic as dump-assistant-tools.ts but return as OpenAI tool format
  const dumpScript = await import("./dump-assistant-tools.js");
  // Actually, let's just call the dump script and transform the output

  // For now, use a simplified approach - read from the dump output
  const { execSync } = await import("node:child_process");
  try {
    const output = execSync("npx tsx scripts/dump-assistant-tools.ts 2>/dev/null", {
      cwd: ROOT,
      encoding: "utf-8",
    });
    const tools = JSON.parse(output);

    // Convert to OpenAI/Fireworks tool format
    return tools.map((tool: { name: string; description: string; inputSchema: unknown }) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  } catch (err) {
    console.error("Warning: Could not load full tools, using simplified set");
    return getTestTools();
  }
}

// ============================================================================
// API CALL
// ============================================================================

interface ApiResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

async function testApi(apiKey: string, useFullTools: boolean = true) {
  const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
  const MODEL = "accounts/fireworks/models/kimi-k2p5";  // Kimi K2

  console.log("Testing Fireworks AI API...");
  console.log("Model:", MODEL);
  console.log("Using full tools:", useFullTools);
  console.log("");

  const tools = useFullTools ? await getFullTools() : getTestTools();
  console.log(`Loaded ${tools.length} tools`);

  const systemPrompt = `You are Canopy's operator—terse, direct, efficient. You have access to tools for controlling an IDE.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "What can you do?" },
  ];

  const requestBody = {
    model: MODEL,
    messages,
    tools,
    tool_choice: "auto",
    max_tokens: 1024,
  };

  console.log("\nRequest body size:", JSON.stringify(requestBody).length, "bytes");
  console.log("Number of tools:", tools.length);

  try {
    const response = await fetch(`${FIREWORKS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();

    console.log("\nResponse status:", response.status, response.statusText);

    if (!response.ok) {
      console.log("\n=== ERROR RESPONSE ===");
      console.log(responseText);

      // Try to parse as JSON for better error display
      try {
        const errorJson = JSON.parse(responseText);
        console.log("\nParsed error:");
        console.log(JSON.stringify(errorJson, null, 2));
      } catch {
        // Not JSON, already displayed raw
      }
      return;
    }

    const data: ApiResponse = JSON.parse(responseText);

    console.log("\n=== SUCCESS ===");

    if (data.choices?.[0]?.message) {
      const msg = data.choices[0].message;
      console.log("Role:", msg.role);
      console.log("Content:", msg.content || "(no content)");

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        console.log("\nTool calls:");
        for (const tc of msg.tool_calls) {
          console.log(`  - ${tc.function.name}(${tc.function.arguments})`);
        }
      }

      console.log("Finish reason:", data.choices[0].finish_reason);
    }

  } catch (err) {
    console.error("\n=== FETCH ERROR ===");
    console.error(err);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const useFullTools = !args.includes("--simple");  // Full tools by default
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log(`
Test Assistant API

Makes a test request to Fireworks AI with tool definitions.

Usage:
  npm run assistant:test-api              Use simplified tool set (4 tools)
  npm run assistant:test-api -- --full    Use full tool set from dump script
  npm run assistant:test-api -- --help    Show this help

Requires .env file with FIREWORKS_API_KEY
`);
    process.exit(0);
  }

  const env = loadEnv();
  const apiKey = env.FIREWORKS_API_KEY || env.FIREWORKS_AI_KEY;

  if (!apiKey) {
    console.error("Error: FIREWORKS_API_KEY or FIREWORKS_AI_KEY not found in .env file");
    process.exit(1);
  }

  console.log("API key found:", apiKey.slice(0, 8) + "..." + apiKey.slice(-4));
  console.log("");

  await testApi(apiKey, useFullTools);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
