import { describe, it, expect } from "vitest";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";

describe("getAIAgentInfo", () => {
  it("should detect Claude URLs", () => {
    expect(getAIAgentInfo("https://claude.ai/new")).toEqual({
      title: "Claude",
      icon: "claude",
    });
    expect(getAIAgentInfo("https://claude.ai/chat/abc123")).toEqual({
      title: "Claude",
      icon: "claude",
    });
  });

  it("should detect ChatGPT URLs", () => {
    expect(getAIAgentInfo("https://chatgpt.com/")).toEqual({
      title: "ChatGPT",
      icon: "openai",
    });
    expect(getAIAgentInfo("https://chatgpt.com/c/abc123")).toEqual({
      title: "ChatGPT",
      icon: "openai",
    });
  });

  it("should detect Gemini URLs", () => {
    expect(getAIAgentInfo("https://gemini.google.com/app")).toEqual({
      title: "Gemini",
      icon: "gemini",
    });
    expect(getAIAgentInfo("https://gemini.google.com/app/abc123")).toEqual({
      title: "Gemini",
      icon: "gemini",
    });
  });

  it("should return null for non-AI agent URLs", () => {
    expect(getAIAgentInfo("https://example.com")).toBeNull();
    expect(getAIAgentInfo("https://google.com")).toBeNull();
    expect(getAIAgentInfo("https://github.com")).toBeNull();
  });

  it("should handle URLs with query parameters", () => {
    expect(getAIAgentInfo("https://claude.ai/new?ref=test")).toEqual({
      title: "Claude",
      icon: "claude",
    });
  });

  it("should handle URLs with different protocols", () => {
    expect(getAIAgentInfo("http://claude.ai/new")).toEqual({
      title: "Claude",
      icon: "claude",
    });
  });

  it("should handle www. subdomains", () => {
    expect(getAIAgentInfo("https://www.claude.ai/new")).toEqual({
      title: "Claude",
      icon: "claude",
    });
    expect(getAIAgentInfo("https://www.chatgpt.com/")).toEqual({
      title: "ChatGPT",
      icon: "openai",
    });
  });

  it("should not match agent names in query parameters", () => {
    expect(getAIAgentInfo("https://example.com?ref=claude.ai")).toBeNull();
    expect(getAIAgentInfo("https://google.com/search?q=chatgpt.com")).toBeNull();
  });

  it("should handle invalid URLs gracefully", () => {
    expect(getAIAgentInfo("not a url")).toBeNull();
    expect(getAIAgentInfo("")).toBeNull();
    expect(getAIAgentInfo("javascript:alert(1)")).toBeNull();
  });

  it("should be case insensitive for hostnames", () => {
    expect(getAIAgentInfo("https://CLAUDE.AI/new")).toEqual({
      title: "Claude",
      icon: "claude",
    });
    expect(getAIAgentInfo("https://ChatGPT.COM/")).toEqual({
      title: "ChatGPT",
      icon: "openai",
    });
  });
});
