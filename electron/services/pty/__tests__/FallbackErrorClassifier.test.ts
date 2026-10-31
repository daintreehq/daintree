import { describe, it, expect } from "vitest";
import {
  classifyExitOutput,
  shouldTriggerFallback,
  type FallbackExitClass,
} from "../FallbackErrorClassifier.js";

function cases(
  label: string,
  expected: FallbackExitClass,
  samples: string[],
  options: { wasKilled?: boolean; exitCode?: number } = {}
) {
  describe(label, () => {
    for (const sample of samples) {
      it(`classifies: ${sample.slice(0, 60)}…`, () => {
        expect(
          classifyExitOutput({
            recentOutput: sample,
            wasKilled: options.wasKilled,
            exitCode: options.exitCode,
          })
        ).toBe(expected);
      });
    }
  });
}

cases("connection: Claude patterns", "connection", [
  "Unable to connect to API — check your internet connection",
  "API Error: 500 Internal server error",
  "API Error: Repeated 529 Overloaded errors",
  "API Error: connect ECONNREFUSED 127.0.0.1:443",
  "API Error: getaddrinfo ENOTFOUND api.anthropic.com",
]);

cases("connection: Gemini patterns", "connection", [
  "Error: INTERNAL",
  "Error: UNAVAILABLE: failed to connect to google.generativeai",
  "ETIMEDOUT when contacting the API",
  "ECONNRESET reading response body",
]);

cases("connection: Codex patterns", "connection", [
  "Error: Could not resolve host: api.openai.com",
  "failed to connect to the server",
  "Error on conversation request: 502 Bad Gateway",
  "503 Service Unavailable",
  "504 Gateway Timeout",
]);

cases("connection: gRPC status names in an error context", "connection", [
  "Error: 14 UNAVAILABLE: No connection established",
  "Error: 13 INTERNAL: Received RST_STREAM",
  'ApiError: {"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}',
  '{"error": {"code": 500, "status": "INTERNAL"}}',
  'ApiError: {"error":{"message":"{\\"error\\":{\\"code\\":500,\\"status\\":\\"INTERNAL\\"}}","code":500,"status":"Internal Server Error"}}',
  'Error: request failed {"status":"UNAVAILABLE"}',
]);

cases("auth: Claude patterns", "auth", [
  "Error: Not logged in. Please run /login to authenticate.",
  "Please run /login first",
  "Invalid API key",
  "OAuth token has expired",
  "OAuth token revoked",
  "Your organization has been disabled",
  "Your organization has been suspended",
]);

cases("auth: Gemini patterns", "auth", [
  "Error: UNAUTHENTICATED",
  "Error: PERMISSION_DENIED",
  "403 Forbidden: API key lacks permission",
]);

cases("auth: Codex patterns", "auth", [
  "To use codex you must be logged in",
  "Error: Invalid OAuth token",
  "401 Unauthorized",
]);

cases("rate-limit: must NOT trigger fallback", "rate-limit", [
  "API Error: Rate limit reached for requests",
  "Request rejected (429)",
  "Error 429: Too Many Requests",
  "RESOURCE_EXHAUSTED",
  "rateLimitExceeded",
  "quota exceeded",
]);

cases("user-error: must NOT trigger fallback", "user-error", [
  "Error: Prompt is too long for this model",
  "Error: Request too large",
  "context window exceeded",
  "input is too long, try /compact",
]);

cases("clean: empty or non-matching tail", "clean", ["", "Hello, world!"]);

cases(
  "clean: ordinary text containing INTERNAL, UNAVAILABLE or 429 on a nonzero exit",
  "clean",
  [
    "const INTERNAL_API_URL = process.env.INTERNAL_API_URL;",
    "return Status.UNAVAILABLE;",
    "⎿  Read 429 lines",
    "Tests: 429 passed, 1 failed",
    "Handlers return HTTP 429 when the bucket is empty.",
    "src/foo.ts line 429",
    "enum Code { OK = 0, INTERNAL = 13, UNAVAILABLE = 14 }",
    '```json\n{"status":"UNAVAILABLE"}\n```',
    "```ts\nexport const INTERNAL = 13;\nif (status === Status.UNAVAILABLE) retry();\n```",
    " Tests  1 failed | 428 passed (429)",
    " Test Files  1 failed | 12 passed (13)\n      Tests  1 failed | 429 passed (430)\n   Duration  4.2s",
  ],
  { exitCode: 1 }
);

describe("classifyExitOutput: short-circuits", () => {
  it("returns 'clean' when wasKilled is true, regardless of output", () => {
    const output = "API Error: 500 Internal server error";
    expect(classifyExitOutput({ recentOutput: output, wasKilled: true })).toBe("clean");
  });

  it("returns 'clean' for exit code 0 even with matching error text in tail (retry-then-succeed)", () => {
    const output =
      "API Error: 503 Service Unavailable\nRetrying in 2s…\nTask completed successfully\nDone.";
    expect(classifyExitOutput({ recentOutput: output, exitCode: 0 })).toBe("clean");
  });

  it("strips ANSI sequences before matching", () => {
    const output = "\x1b[31mAPI Error: 500\x1b[0m Internal server error";
    expect(classifyExitOutput({ recentOutput: output })).toBe("connection");
  });

  it("prefers rate-limit over connection when both appear (429 lookahead)", () => {
    // If the output contains "API Error:" and "429", treat as rate-limit.
    const output = "API Error: 429 Rate limit reached — slow down";
    expect(classifyExitOutput({ recentOutput: output })).toBe("rate-limit");
  });

  it("scans only the last 4000 chars of output", () => {
    const padding = "noise ".repeat(5000);
    const output = padding + "\nAPI Error: 500 Internal server error\n";
    expect(classifyExitOutput({ recentOutput: output })).toBe("connection");
  });

  it("keeps a real 5xx a connection error when an unrelated 429 appears elsewhere", () => {
    const output = "API Error: 503 Service Unavailable\nsrc/foo.ts line 429\n";
    expect(classifyExitOutput({ recentOutput: output, exitCode: 1 })).toBe("connection");
  });

  it("keeps a real 5xx a connection error when a test summary ends in (429)", () => {
    const output = "API Error: 503 Service Unavailable\n Tests  1 failed | 428 passed (429)\n";
    expect(classifyExitOutput({ recentOutput: output, exitCode: 1 })).toBe("connection");
  });

  it("does not match unrelated 'Error:' chatter", () => {
    const output = "Error: file not found in workspace\nTask completed";
    expect(classifyExitOutput({ recentOutput: output })).toBe("clean");
  });
});

describe("shouldTriggerFallback", () => {
  it.each([
    ["connection", true],
    ["auth", true],
    ["rate-limit", false],
    ["user-error", false],
    ["clean", false],
  ] as const)("%s → %s", (cls, expected) => {
    expect(shouldTriggerFallback(cls)).toBe(expected);
  });
});
