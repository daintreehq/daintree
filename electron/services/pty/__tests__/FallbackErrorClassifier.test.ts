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
  "API Error: 529 Overloaded",
  "API Error: Repeated 529 Overloaded errors",
  "API Error: connect ECONNREFUSED 127.0.0.1:443",
  "API Error: getaddrinfo ENOTFOUND api.anthropic.com",
  "Unable to connect to API due to poor internet connection. Retrying in 3 seconds…",
]);

cases("connection: Gemini patterns", "connection", [
  "Error: INTERNAL",
  "Error: UNAVAILABLE: failed to connect to google.generativeai",
  "ENOTFOUND generativelanguage.googleapis.com",
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

cases("clean: empty or non-matching tail", "clean", [
  "",
  "Hello, world!",
  "Running tests…",
  "✓ 42 passed",
]);

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

  it("returns 'clean' for exit code 0 with UNAVAILABLE in the tail", () => {
    const output = "Error: UNAVAILABLE: dns resolution failed\nRecovered.\nTask complete!";
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
