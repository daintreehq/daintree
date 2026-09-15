import { describe, expect, it } from "vitest";
import { APP_AGENT_DEFAULT_BASE_URL, resolveAppAgentChatCompletionsUrl } from "../appAgentUrl.js";

const HTTPS_REQUIRED = "Base URL must use HTTPS except for loopback hosts";
const INVALID = "Invalid base URL configured";

describe("resolveAppAgentChatCompletionsUrl", () => {
  it.each([undefined, ""])("falls back to the default endpoint for %j", (baseUrl) => {
    expect(resolveAppAgentChatCompletionsUrl(baseUrl)).toEqual({
      ok: true,
      url: `${APP_AGENT_DEFAULT_BASE_URL}/chat/completions`,
    });
  });

  it("keeps the default endpoint on HTTPS", () => {
    expect(new URL(APP_AGENT_DEFAULT_BASE_URL).protocol).toBe("https:");
  });

  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1/chat/completions"],
    ["http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1/chat/completions"],
    ["http://[::1]:8000/v1", "http://[::1]:8000/v1/chat/completions"],
  ])("accepts %s", (baseUrl, url) => {
    expect(resolveAppAgentChatCompletionsUrl(baseUrl)).toEqual({ ok: true, url });
  });

  it.each([
    "http://api.example.com/v1",
    "http://192.168.0.20:11434/v1",
    "http://0.0.0.0:11434/v1",
    // The check reads the final endpoint's host, so these cannot smuggle a loopback name past it.
    "http://localhost:80@evil.example/v1",
    "http://evil.example#http://localhost",
    "http://evil.example/?http://localhost",
  ])("requires HTTPS for %s", (baseUrl) => {
    expect(resolveAppAgentChatCompletionsUrl(baseUrl)).toEqual({
      ok: false,
      error: HTTPS_REQUIRED,
    });
  });

  it.each([
    "not a url",
    "   ",
    "/v1",
    "file:///tmp/models",
    "ftp://example.com/v1",
    "data:text/plain,",
  ])("rejects %j as an invalid base URL", (baseUrl) => {
    expect(resolveAppAgentChatCompletionsUrl(baseUrl)).toEqual({ ok: false, error: INVALID });
  });
});
